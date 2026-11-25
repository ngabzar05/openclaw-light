# Lane F — F3 + F6 + F8 + D2 (mobile-fast-boot)

Lane F fork OpenClaw (`lane-f/f3-f6-f8-d2`, basis `mobile-fast-boot` `1d9ecf44`).
Semua perubahan perilaku digated di belakang A1 (`OPENCLAW_MOBILE_BOOT=1`,
resolver `src/gateway/mobile-boot.ts`); OFF = upstream murni. D2 adalah
perubahan build/packaging, bukan perilaku runtime.

Dokumen ini catatan desain + implementasi Lane F. Angka ukur LAB ada di
[`MEASUREMENT.md`](MEASUREMENT.md) § Lane F. Panduan rebase umum ada di
[`REBASE-GUIDE.md`](REBASE-GUIDE.md); D2 didokumentasikan terpisah di
[`D2-PREBUILD-PRUNE.md`](D2-PREBUILD-PRUNE.md).

## Ringkasan

| Item | Perubahan | Efek ukur LAB (2× ON vs 2× OFF) |
| --- | --- | --- |
| F3(a) | Preflight baca core-only; metadata plugin dibaca sekali pra-listen di `run.ts` | (isi sesudah ukur) |
| F3(b) | Import runtime database/session lewat `createLazyRuntimeModule` | netral perilaku (sengaja) |
| F3(c) | Scope state-snapshot malas (`lazy: true`) bila ON | (isi sesudah ukur) |
| F6 | `src/entry-gateway.ts` + routing `openclaw.mjs` + entri tsdown; prewarm `server-start.js` paralel | (isi sesudah ukur) |
| F8 | Penolakan admission + skip update check pasca-attach bila ON | ~0 dtk boot (update check memang deferred); efeknya penghapusan jalur, bukan kecepatan |
| D2 | Skrip prune prebuild non-arm64-linux | lihat `D2-PREBUILD-PRUNE.md` |

## F3 — pecah `gateway-run-bootstrap`

Rantai yang dipecah (semua diukur sebagai `cli.bootstrap.*` oleh F9):

```
tryRunGatewayRunFastPath (run-main.ts)
 └─ bootstrapGatewayRun (run-command.ts)
     └─ ensureCliExecutionBootstrap (command-execution-startup.ts)
         └─ ensureConfigReady (program/config-guard.ts)
             └─ runStartupConfigPreflight (startup-config-preflight.ts)
                 └─ readAdmittedConfigSnapshot (config-preflight-snapshot.ts)
                     ├─ admission.plugin-config   (~1,65 dtk [LAB], paralel)
                     └─ admission.state-snapshot  (~1,72 dtk [LAB])
                         └─ readiness chain: database-runtime-import 0,13
                            → database-readiness 0,98 → session-runtime-import
                            0,55 → session-targets → session-readiness
                            → workspace-runtime-import → workspace-readiness
                            → config-recovery
```

### F3(a) — `plugin-config` pindah (relokasi, bukan penghapusan)

`prepareStartupConfig` (`src/commands/startup-config-preflight.ts`) membaca
core-only bila mobileBoot ON: `includePluginMetadata: false`,
`skipPluginValidation: true`. Full read dengan metadata plugin TETAP terjadi
pra-listen, sekali, di `readGatewayStartupConfig`
(`src/cli/gateway-cli/run.ts`), yang memberi makan server bootstrap.

**Kejujuran ukur:** di LAB, `admission.plugin-config` berjalan PARALEL dan
sepenuhnya tumpang tindih dengan rantai readiness — menghapusnya dari block
menghemat ~0 mdtk wall di LAB. Nilainya ada di perangkat (I/O emulasi, di
mana discovery plugin jauh lebih mahal) dan via A3 Lane D. Nama langkah
trace dipertahankan (`admission.plugin-config`) agar perbandingan ON/OFF
eksplisit.

**Koreksi terhadap draf desain awal:** draf awal mengklaim "validasi plugin
penuh di run.ts pra-listen" — SALAH. `readGatewayStartupConfig` HANYA
melempar untuk read failure (`isConfigReadFailure`); snapshot plugin-invalid
(`valid === false`, bukan read failure) lolos diam-diam. Penegakan upstream
ada di preflight (via `ensureConfigReady`). Karena F3(a) membutakan
preflight terhadap plugin, Lane F menambahkan penegakan eksplisit di
`runGatewayCommandOnce` (`run.ts`, tepat sesudah
`readGatewayStartupConfigWithShellEnv`, digated ON):

```ts
if ((opts.mobileBoot ?? resolveMobileBootOptions(process.env)).enabled &&
    snapshot.exists && !snapshot.valid && !isConfigReadFailure(snapshot)) {
  throw createInvalidConfigError(snapshot.path, details);
}
```

Hasilnya sama seperti upstream: invalid-config error → tawaran recovery →
exit 78, tetap pra-listen. Config hilang (`snapshot.exists === false`,
kasus `--allow-unconfigured`) dibiarkan lewat. Konsumen metadata preflight
mentolerir undefined: webhook migration (`manifestRegistry` optional-chained),
quarantine (`withPluginCache(...?...: getPluginCache())`), `result()` (spread
kondisional), `takePluginCache(undefined)` → undefined,
`metadataMetrics ?? {}`. Cache proses kosong yang dibuang `ensureConfigReady`
di akhir (preflight tanpa metadata) aman: `run.ts` selalu mengadopsi cache
segar dari full read sesudahnya (bentuk yang sama dengan upstream, yang
membuang snapshot cache preflight lalu mengadopsi cache `run.ts`).

Test: `src/commands/config-preflight-snapshot.test.ts` — ON: snapshot valid +
`pluginMetadataSnapshot` undefined + trace mengandung `admission.plugin-config`
tapi TIDAK `admission.plugin-metadata-completion`; OFF: metadata ada; N5:
config core-invalid (`gateway.mode: "bogus-mode"`) tetap dilaporkan invalid
di bawah ON.

### F3(b) — import runtime malas (netral perilaku, sengaja)

Dua dynamic import di `assertStartupStateReady`
(`config-preflight-snapshot.ts`) diganti loader level-modul
`createLazyRuntimeModule` (`src/shared/lazy-runtime.ts`, pola yang sudah ada
— sama seperti `src/commands/doctor-config-preflight.ts:54-55`):

- `loadDatabasePreflightRuntime` → `../state/openclaw-database-preflight.js`
- `loadSessionStartupMigrationRuntime` → `../config/sessions/startup-migration.js`
- `loadSessionTargetsRuntime` → `../config/sessions/targets.js`

Dipakai TANPA SYARAT (single path): modul sama, titik pemakaian pertama sama
(di dalam admission, karena readiness check membutuhkannya pra-listen),
`import()` berulang sudah cache-hit. Perubahan ini netral perilaku; perilaku
yang digated adalah (a) dan (c). Ini adalah seam agar lane berikutnya bisa
menunda pemakaian pertama tanpa menciptakan pola lazy baru.
(`admission.workspace-runtime-import` TIDAK termasuk cakupan F3(b).)

Test: tercakup oleh test `readAdmittedConfigSnapshot` yang ada + test F3(a)
(trace mengandung `admission.database-runtime-import` /
`admission.session-runtime-import` / `admission.database-readiness`).

### F3(c) — `state-snapshot` malas

`readAdmittedConfigSnapshot` meneruskan `lazy: true` ke
`withOpenClawStateDatabaseReadSnapshot` bila mobileBoot ON. Flag `lazy`
SUDAH didukung upstream (`src/state/openclaw-state-db-readonly.ts:156`,
`src/state/openclaw-state-read-snapshot-source.ts`): tanpa admission wait /
persiapan snapshot eager; `readSource()` menyiapkan on-demand secara sinkron
(loop `Atomics.wait`); bila tidak ada pembaca, byte snapshot tidak pernah
disiapkan. Di state segar LAB jalur eager sudah short-circuit, jadi hemat
LAB ≈ 0; hemat nyata pada warm state.

Caveat (single-owner mobile saja): dengan lazy, admission wait dilewati —
bila writer bersamaan memegang admission saat pembaca meminta, pembaca gagal
cepat alih-alih menunggu sampai timeout admission. Polones menjalankan satu
Gateway owner (Opsi A), jadi tidak ada writer bersamaan yang diharapkan.

Tidak ada unit test khusus untuk F3(c): efeknya hanya teramati di bawah
pembaca bersamaan / warm state; cakupan ada di ukur LAB (ON vs OFF) +
smoke boot.

### Threading mobileBoot (resolve SEKALI per proses)

```
tryRunGatewayRunFastPath (src/cli/run-main.ts)
  resolveMobileBootOptions(process.env)          ← satu-satunya resolve (gateway-run)
  ├─ beforeRun hook: opts.mobileBoot = mobileBoot
  │    └─ bootstrapGatewayRun({ ..., mobileBoot })   (run-command.ts)
  │         └─ ensureCliExecutionBootstrap({ ..., mobileBoot })
  │              └─ ensureConfigReady({ ..., mobileBoot })   (config-guard.ts)
  │                   └─ runStartupConfigPreflight({ ..., mobileBoot })
  │                        └─ readAdmittedConfigSnapshot({ ..., mobileBoot })
  └─ runGatewayCommand(opts) → runGatewayCommandOnce
       └─ opts.mobileBoot ?? resolveMobileBootOptions(process.env)
            (fallback hanya untuk pemanggil langsung/test)
```

Pemanggil `ensureCliExecutionBootstrap` lain (`preaction.ts`, `route.ts`,
`mac-worker-entry.ts`) tidak meneruskan mobileBoot → undefined → OFF.
Field baru: `GatewayRunOpts.mobileBoot?: MobileBootOptions`
(`src/cli/gateway-cli/run-options.ts`); hook `beforeRun` dilebarkan dari
`Pick<GatewayRunOpts, "force" | "reset">` ke `GatewayRunOpts`
(`run-command.ts`).

## F6 — entry gateway baru

### `src/entry-gateway.ts`

Cerminan prolog `entry.ts` MINUS bagian non-gateway. Dibawa:

- `installDatabaseProcessRole(resolveCliDatabaseProcessRole(...))`,
  `watchCliRespawnParent()`, `ensureOpenClawExecMarkerOnProcess()`,
  `installProcessWarningFilter()`, `normalizeEnv()`, `normalizeWindowsArgv`
- early parse `--profile`/`--container` (validasi kombinasi, sama seperti
  `entry.ts`)
- runtime guard (`assertSupportedRuntime`, dinamis), node-host launcher
  (`runNodeHostLauncher`, dinamis), compile-cache respawn + enable,
  respawn plan (`buildCliRespawnPlan`/`runCliRespawnPlan`)
- `process.title = "openclaw"`, trace
  `createGatewayDispatchStartupTrace(process.argv, "entry")`
- guard `isMainModule` dengan `ENTRY_GATEWAY_WRAPPER_PAIRS` sendiri
  (diekspos untuk test)
- side-effect import `./shared/detached-async-context.js` (dipertahankan:
  singleton `AsyncResource` harus ada sebelum managed work; modulnya kecil,
  risikonya nol bila dibawa)
- managed-node-host state path handling + `withCliProcessScope`, sama
  seperti `entry.ts`

Dilewati (sengaja): update admission (F8, struktural),
`tryHandleRootVersionFastPath` (launcher sudah menangani `--version`),
root/precomputed help fast path, native-hook relay,
`shouldForceReadOnlyAuthStore` (hanya `secrets audit`).

Panggilan `runCli(process.argv, { additionalStartupTrace,
retainConsoleRoutingUntilProcessExit: true, runtimeRecoveryEnv:
inheritedRuntimeEnv })` secara dinamis; JANGAN impor `entry.ts` (akan
menarik ulang graf penuh + risiko double-run).

Guard argv: bila argv bukan foreground gateway run
(`isForegroundGatewayRunArgv`), tolak eksplisit (stderr + exit 2) — jangan
diam-diam berperilaku salah.

### Prewarm paralel

Tepat sebelum `runCli`, dynamic import `./gateway/server-start.js`
(diekivalen-src dari `dist/gateway-prewarm.js`) di-kick off TANPA await,
bersamaan dengan `runCli`, dengan `.catch` → peringatan stderr (jangan
gagalkan boot). `server-start.js` import-only menurut kontrak upstream
(`gateway-prewarm.mjs`: "Import only: do not start a Gateway"); server
nantinya mengimpor specifier yang sama → module cache hit, langkah
`gateway.server-start-import` (~1,9 dtk [LAB]) menjadi ~0. Efek bersih
HARUS diukur (kompetisi CPU/disk dengan preflight; di bawah emulasi belum
tentu menang) — lihat `MEASUREMENT.md` § Lane F.

### Routing + build

- `openclaw.mjs`: di cabang akhir `runLauncher`, bila `foregroundGateway &&
  mobileBootOn` → coba `tryImport("./dist/entry-gateway.js")` dulu (lalu
  `.mjs`), fallback ke `entry.js` bila tidak ada. Routing DIGATED A1 (OFF =
  upstream murni via `entry.js`). Cek truthy direplikasi lokal di plain JS
  (cermin `isTruthyEnvValue`: `"true"`/`"1"`/`"yes"`/`"on"`,
  case-insensitive, trim).
- `tsdown.config.ts`: tambah `"entry-gateway": "src/entry-gateway.ts"` di
  `buildCoreDistEntries` (di samping `"gateway-prewarm"`).

### Divergensi yang diketahui (vs `entry.ts`)

1. Error yang lolos dari `runCli` mendapat satu baris stderr + exit 1 (bukan
   formatted diagnostic block / JSON failure envelope `entry.ts`). Exit code
   sama (1); hanya presentasi berbeda. Kegagalan start gateway yang ditangani
   di dalam `runCli` (config error, lock) tidak terpengaruh.
2. Compile-cache respawn write-error menulis plain stderr (bukan diagnostic
   block).
3. Validasi `--container`+`--profile` dini TETAP dibawa (tertutup).
4. `secrets audit` via entry-gateway tidak didukung (hanya via `entry.js`).

### Kejujuran F6

Hemat terukur di src saat ini KECIL (graf statis `entry.ts` sudah ramping;
penghematan lama "satuan detik I/O" berasal dari dist lama). Nilai F6:
struktural (entry khusus gateway tanpa jalur update-admission/container/
TUI/doctor) + overlap prewarm (~1,9 dtk potensial di LAB).

Test: `src/entry-gateway.test.ts` — asersi graf impor statis (TIDAK impor
update-admission/precomputed-help/respawn-policy/version-fast-path/`entry.js`;
impor compile-cache + startup-trace + profile/container + gateway-run-argv +
detached-async-context) + impor dinamis `run-main` + `server-start` +
guard argv + `ENTRY_GATEWAY_WRAPPER_PAIRS`. Ekuivalensi OFF: ukur LAB +
`--version` via kedua entry (lihat `MEASUREMENT.md`).

## F8 — hapus jalur update-admission

Tiga titik, semua digated A1:

1. **Entry (struktural):** `entry-gateway.ts` tidak pernah mengimpor
   `run-main-update-admission.js`. `update-startup-*.mjs` tidak dijangkau
   dari entry fork.
2. **`runCli` (`src/cli/run-main.ts:630`):** bila
   `isUpdateAdmissionInvocation(originalInvocation)` DAN mobileBoot ON →
   tolak fail-closed: pesan jelas + `process.exitCode = 2` + return
   (cermin pola `reject()` di admission: exit 2). Bila OFF → jalankan
   admission seperti upstream. Keputusan diekstrak ke helper murni yang
   dapat dites: `resolveUpdateAdmissionMobileBootRefusal(mobileBoot,
   invocation): string | undefined` (`src/cli/run-main-update-admission.ts`).
   Resolusi mobileBoot di titik ini HANYA bila invokasi adalah
   update-admission (gateway-run tidak pernah menyentuhnya — argv saling
   eksklusif — sehingga "resolve sekali per proses" tetap terjaga per jalur).
3. **Post-attach (`src/gateway/server-startup-post-attach.ts`):** `mobileBoot`
   di-thread dari `finishGatewayStartup` (`opts.mobileBoot`) →
   `startGatewayPostAttachRuntime({ ..., mobileBoot })` →
   `updateCheck.start()` dilewati bila ON (dengan `log.info` bahwa update
   check dinonaktifkan). Handle deferred tetap dibuat + diregistrasi sebagai
   lifetime sidecar (stop pada check yang tak pernah start adalah no-op yang
   aman), jadi `stopGatewayUpdateCheck` yang dikembalikan tetap valid.

Cakupan TIDAK mencakup perintah `openclaw update` secara keseluruhan — hanya
admission + update check saat start, sesuai penamaan tugas. Sentinel restart
update (`prepareLatestUpdateRestartSentinel` di sidecars) DIPERTAHANKAN — itu
bookkeeping restart, bukan update check. RPC `update-status` (on-demand)
tidak disentuh. Catatan kontrak update upstream
(`docs/install/updating.md#update-implementation-contract`): perubahan ini
fork-scoped (hanya bila A1 ON, di mana update memang dikirim lewat APK
Polones, bukan self-update); perilaku OFF tidak berubah.

Test: `src/cli/run-main-update-admission.test.ts` — helper penolakan
(`admit`/`preflight` ditolak bila ON; tidak ditolak bila OFF; tidak ditolak
untuk `gateway run` / `update status` / `--help` / `doctor`). Post-attach:
cakupan via LAB (phases.tsv ON tidak mengandung `post-attach.update-check`
+ baris log penonaktifan).

## D2 — hapus prebuild `.node` non-arm64-linux

Deliverable di repo fork: skrip prune
`scripts/mobile-fast-boot/prune-non-arm64-prebuilds.mjs` (allowlist-based,
dry-run default, `--apply` untuk menghapus) + test vitest atas pohon palsu
(`test/scripts/mobile-fast-boot-prune-prebuilds.test.ts`) + dokumen
[`D2-PREBUILD-PRUNE.md`](D2-PREBUILD-PRUNE.md) (daftar berkas persis +
ukuran + cara adopsi pipeline Polones + bukti keamanan).

Ringkasan hasil (diukur dari pohon hasil `pnpm install` lane-f, x86_64):
task-named + prod (A) ≈ 60,4 MiB (pi-tui + resvg + node-pty + fs-safe +
proc-safe + cua-driver); total pohon install 41 target ≈ 1365,4 MiB.
Detail lengkap di `D2-PREBUILD-PRUNE.md`.

Uji boot LAB memakai pohon PRISTINE (x86_64 butuh berkas x64); keamanan
prune diuji via unit test + telaah loader code (loader memilih berdasarkan
`process.platform`/`arch`). Implementasi langkah prune di `build.sh` adalah
sisi Polones (bukan fork) — skrip + daftar + bukti dari Lane F adalah
inputnya.

## Berkas yang diubah

```
openclaw.mjs                                  (F6 routing, gated A1)
tsdown.config.ts                              (F6 entri build)
src/entry-gateway.ts                          (F6, baru)
src/entry-gateway.test.ts                     (F6, baru)
src/cli/run-main.ts                           (F3 resolve sekali + F8 gate)
src/cli/run-main-update-admission.ts          (F8 helper penolakan)
src/cli/run-main-update-admission.test.ts     (F8 test helper)
src/cli/gateway-cli/run-command.ts            (F3 threading + hook lebar)
src/cli/gateway-cli/run-options.ts            (F3 field mobileBoot)
src/cli/gateway-cli/run.ts                    (F3a penegakan plugin-invalid)
src/cli/command-execution-startup.ts          (F3 threading)
src/cli/program/config-guard.ts               (F3 threading)
src/commands/startup-config-preflight.ts      (F3a core-only + threading)
src/commands/config-preflight-snapshot.ts     (F3b lazy loader + F3c lazy)
src/commands/config-preflight-snapshot.test.ts (F3 test)
src/gateway/mobile-boot.ts                    (komentar: peta threading Lane F)
src/gateway/server-startup-finish.ts          (F8 threading)
src/gateway/server-startup-post-attach.ts     (F8 skip update check)
scripts/mobile-fast-boot/prune-non-arm64-prebuilds.mjs  (D2, baru)
test/scripts/mobile-fast-boot-prune-prebuilds.test.ts    (D2, baru)
docs/mobile-fast-boot/LANE-F.md               (dokumen ini)
docs/mobile-fast-boot/D2-PREBUILD-PRUNE.md     (D2, baru)
docs/mobile-fast-boot/MEASUREMENT.md          (§ Lane F)
```

Tidak disentuh (sengaja, wilayah lane lain): `server-startup-bootstrap.ts`
(Lane B/F1), `server-startup-plugins.ts` (Lane D/F5/A3),
`server-start.ts` (Lane G/F4), `DESIGN.md` (konsolidasi di integrasi).

## Hal terbuka

- Efek bersih prewarm paralel F6 menunggu ukur LAB (kompetisi CPU/disk).
- Efek F3(a)/F3(c) di LAB diperkirakan ≈ 0 (paralelisme + short-circuit state
  segar) — nilai sesungguhnya di perangkat; lihat `MEASUREMENT.md`.
- Asal `dist/` Lane A tidak terjawab dari log (Lane A tidak meninggalkan log
  build penuh yang sukses); Lane F memakai jalur tsdown inti + `pnpm ui:build`
  (lihat `MEASUREMENT.md` § build).
- Ronde perangkat S2/S3 tetap menunggu pemilik.
