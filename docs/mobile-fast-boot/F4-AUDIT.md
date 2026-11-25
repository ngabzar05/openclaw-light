# Audit + implementasi F4 (early-listen / proses depan tipis) — Lane G

> Cabang `lane-g/f4`, basis `mobile-fast-boot` `1d9ecf44` (merge Lane A).
> Semua angka berlabel **[LAB]** bila ada; dokumen ini TIDAK berisi angka
> ukur F4 — pengukuran tertunda (lihat §6).

## 1. Ringkasnya

F4 dikerjakan dalam dua bagian di `src/gateway/server-startup-finish.ts`
(satu-satunya berkas produksi yang berubah):

- **F4(a) — impor malas pasca-`http.bound`.** Sembilan impor statis
  diubah menjadi impor dinamis di titik pakainya (semuanya pasca-bind /
  pasca-ready). Tidak ada modul yang dihapus, tidak ada perilaku yang
  diubah — hanya mekanisme pemuatan (lihat §2).
- **F4(b) — tunda join early runtime.** Bila `opts.mobileBoot.enabled`,
  `earlyRuntimeReady` tidak lagi di-join sebelum post-attach; join
  dipindah ke sesudah `/ready` terbit, dengan mitigasi re-refresh
  discovery (§3). OFF = urutan join upstream persis.

Tidak ada shim health. `/health` sudah liveness murni
(`server-http-request.ts:224` → `handleGatewayProbeRequest`, tanpa
`waitForRequestRuntime`; `/health` → `"live"`,
`gateway-http-route-contracts.ts:2`), `/ready` tetap menunggu
post-attach (`getReadiness.prepare().publish()`).

## 2. F4(a) — audit modul

### 2.1 Dipindah ke impor dinamis

| Modul (simbol) | Titik pakai baru | Graf yang keluar dari pra-listen | Verifikasi efek samping top-level |
|---|---|---|---|
| `server-tls-renewal` (`startGatewayTlsRenewal`) | sesudah `getReadiness.prepare()` (pasca-ready) | `infra/tls/gateway` | hanya deklarasi fungsi |
| `server-methods/nodes.read` (`refreshConnectedNodeSurfaceCaches`) | `reconcileRuntimePolicy`, fase `committed` | device-pairing, node-runner-inventory, skills remote | hanya deklarasi fungsi/konstanta |
| `server-runtime-config` (`assertGatewayRuntimeSecurityConfig`) | sekali, sebelum closure `assertRuntimeSecurityConfig` dibangun (pasca-ready) | `config/gateway-control-ui-origins`, `shared/gateway-tailscale-auth-policy`, `control-ui-shared` (catatan: `auth.js` TETAP di graf via impor langsung `resolveGatewayAuth`) | hanya deklarasi fungsi/kelas + `let warned = false` (inisialisasi, bukan efek observabel) |
| `server/ws-origin-policy` (`disconnectDisallowedGatewayPolicyClients`) | `reconcileRuntimePolicy`, fase `committed` | `auth-policy`, `operator-role-policy`, `origin-check`, `ws-policy-close` | hanya deklarasi fungsi |
| `plugin-node-capability` (`indexPluginNodeCapabilitySurfaces`, `reconcileClientPluginNodeCapabilities`) | `onStartupPluginsLoaded` (pasca-attach) | capability tokens, scoped hosts, `security/secret-equal` | hanya deklarasi fungsi/konstanta |
| `server-agent-database-startup` (`activateGatewayAgentDatabaseStartup`) | callback `.then` `requestRuntimeReady` (pasca-bind) | agent scope, auth-profile sqlite, spawn broker, plugin registry scope | hanya deklarasi fungsi |
| `config-reload-plan` (`buildGatewayReloadPlan`, `listConfigReloadRefinementPrefixes`) | `preCommitRuntimePreflight` (jalur tulis config, pasca-ready) | `channels/plugins/index`, `plugins/runtime`, `auth-resolve` | hanya deklarasi fungsi/konstanta (`let cachedCatalog` tak terinisialisasi) |
| `config-diff` (`diffGatewayReloadPaths`) | sama, satu callback dengan `config-reload-plan` | — (kecil; dipindah bersama agar tidak ada sisa statis di callback itu) | hanya deklarasi fungsi |
| `server/client-human-presence` (`startWorkerHumanPresence`) | OFF: titik pakai lama (pra-listen); ON: sesudah `http.bound` | `method-scopes`, `ws-policy-close` | hanya deklarasi fungsi |

Metode verifikasi: tiap modul di atas dipindai pernyataan top-levelnya
(`grep ^[a-zA-Z_$]`) — isinya hanya `import`/`export`/`function`/
`const`/`class`/`type`, tanpa panggilan, timer, atau mutasi global saat
impor. Karena itu memuatnya di titik pakai pertama (bukan saat
`server-start.js` diimpor) bersifat tak teramati: urutan pemanggilan
dan titik pakai pertama tidak berubah di kedua mode.

### 2.2 `startWorkerHumanPresence` ditunda ke pasca-bind (ON)

Verifikasi efek sebelum diputuskan (audit Lane G #1, dikonfirmasi):

- Fungsinya hanya memasang `clients.onChange = observeClients` +
  `observeClients()` sekali. `observeClients()` menghitung ulang dari
  `clients` saat ini dan melanggan klien yang sudah terhubung — jadi
  klien yang terhubung di jendela antara `listen` dan pemasangan tetap
  terambil; tidak ada transisi yang hilang.
- Tidak ada klien yang bisa ada sebelum ws-attach + listen.
- Presence bersifat best-effort (`setHumanPresence` dibungkus
  `.catch` → `log.warn`); menunda pemasangannya tidak mengubah
  semantiknya.

### 2.3 TIDAK dipindah (graf kecil, tanpa kemenangan ukur)

`server-maintenance-lifecycle` (`clearGatewayMaintenanceHandles`),
`control-ui-plugin-policy` (`isCustomPluginUiEnabled`),
`server/process-vitals` (`collectGatewayWorkerPoolMetrics`),
`diagnostics-timeline` (`flushDiagnosticsTimeline`),
`restart-trace` (`collectGatewayProcessMemoryUsageMb`,
`finishGatewayRestartTrace`), `process/gateway-work-admission`
(`getActiveGatewayRootWorkCount`), `state/agent-database-startup`
(`getAgentDatabaseStartupAdmission` — dipakai pra-listen).

### 2.4 TIDAK BISA dipindah / di luar lane ini

- Persiapan bootstrap (`sessions.admission` = F1/Lane B, lock = F2/Lane C,
  `plugins.bootstrap` = F5/Lane D, worker-env store-import +
  `model-runtime-import` + katalog snapshot = F3/Lane F) — jangan sentuh
  `server-startup-bootstrap.ts`.
- Graf statis `server-core-runtime` (method registry dibutuhkan transport
  sebelum listen); `config/io` (dipakai di mana-mana); `GATEWAY_EVENTS`
  (dipakai ws-attach pra-listen).
- `assertGatewayRuntimeSecurityConfig` TIDAK dijadikan closure async:
  kontrak reloader mensyaratkan sinkron —
  `server-reload-contracts.ts:232`
  `assertRuntimeSecurityConfig?: (config, env?) => void`, dipanggil di
  `server-reload-managed-secrets.ts:309`. Solusi: modul diimpor dinamis
  SEKALI sebelum closure dibangun (pasca-ready); closure-nya tetap
  sinkron, kontrak konsumen tidak berubah.

### 2.5 Keputusan yang menyimpang dari rencana Lane G #1 (dicatat jujur)

1. **Impor dinamis berlaku di kedua mode (ON dan OFF), bukan
   digated per impor.** Impor statis tidak bisa dibuat kondisional;
   satu-satunya cara menggated per impor adalah modul perantara —
   overengineering tanpa manfaat. Yang digated adalah PERUBAHAN
   PERILAKU (urutan join F4(b) + penempatan panggilan presence);
   pemuatan malasnya sendiri tak teramati karena modul-modul itu
   bebas efek samping top-level (§2.1) dan titik pakai pertamanya
   tidak berubah. Konsekuensi yang diterima: durasi
   `gateway.server-start-import` di OFF bisa sedikit lebih pendek
   (modul ter-parse belakangan) — perbedaan pengukuran, bukan
   perilaku; dan bila salah satu modul ini gagal diimpor, kegagalan
   muncul di titik pakai (pasca-ready) bukan di impor `server-start`.
   Koordinator diminta menilai apakah penyimpangan ini dapat diterima.
2. **Titik join akhir F4(b) adalah segera sesudah `/ready` terbit,
   bukan di dalam closure `startMaintenance`.** Alasan: titik itu
   dilalui SEMUA jalur (canary, minimal-test, normal). Bila join
   hanya di blok maintenance, jalur canary/minimal-test tidak pernah
   men-join — promise yang gagal akan menjadi unhandled rejection
   (Node 24: crash proses). `/ready` sudah terbit sebelum titik ini,
   jadi readiness tidak pernah tertunda oleh join ini;
   `startMaintenance` tetap menerima nilai yang sudah di-join.
3. **Mark trace tambahan `runtime.early.discovery-refreshed`**
   (ON saja, sesudah re-refresh) — agar mitigasi §3 teramati di log
   LAB, bukan hanya diyakini dari kode.

## 3. F4(b) — desain join yang ditunda

Urutan baru di `finishGatewayStartup`:

```text
startEarlyRuntime()            # tetap dipanggil di tempat lama (kerja konkuren dimulai)
ON : mark "runtime.early.deferred"; await requestRuntimeReady SAJA
OFF: Promise.allSettled([requestRuntimeReady, earlyRuntimeReady]);
     await requestRuntimeReady;        # persis upstream
... ws-attach, http.listen, http.bound, post-attach, /ready publish ...
const earlyRuntime = await earlyRuntimeReady;   # late join (semua jalur)
ON : await refreshAttachedGatewayDiscovery(pluginRuntime.registry);
     mark "runtime.early.discovery-refreshed";
```

- **Bahaya yang dimitigasi:** `onStartupPluginsLoaded` memanggil
  `refreshAttachedGatewayDiscovery(loaded.pluginRegistry)`, yang
  implementasinya `runtimeState.discovery?.update(...)`
  (`server-core-runtime.ts:451`) — NO-OP bila discovery masih null
  (early runtime belum swap-in via `swapDiscovery` di
  `server-startup-early.ts:58`). Bila post-attach mendahului early
  runtime (mode ON), update layanan discovery dari registry hasil
  load HILANG. Re-refresh sesudah late join memakai registry terkini
  (pasca-`publish()`, `pluginRuntime.registry === loaded.pluginRegistry`
  — `publish()` mengeset `owner.activeRegistry`, `plugins/runtime.ts:444`)
  dan bersifat idempotent.
- **Semantik kegagalan:** kegagalan early runtime TETAP menggagalkan
  startup — hanya waktunya bergeser (di late join, sesudah `/ready`
  terbit) dibanding OFF (sebelum post-attach). Gateway sempat
  melaporkan ready lalu ditutup oleh `closeOnStartupFailure`. Ini
  dicatat sebagai perubahan yang disengaja, bukan regresi diam-diam.
- **Aman untuk close:** `skillsChangeUnsub` sudah `?.()` di
  `server-close.ts:115` + default no-op di
  `server-runtime-handles.ts:66` — close sebelum early runtime selesai
  tidak crash (terverifikasi).
- **Satu-satunya join point lain** (`server-kernel.ts:249`) dijaga oleh
  `deferEarlyRuntime: true` dari `server-start.ts` pada jalur ini,
  jadi tidak ada join kedua yang perlu diubah.
- **N1–N10:** tidak ada yang berubah. Tidak ada shim health, tidak ada
  penghapusan control-ui/memory-core/ekstensi, tidak ada zipimport /
  esbuild / snapshot / port Bun, tidak ada patch-`dist`.

## 4. Test

`src/gateway/server-startup-finish.mobile-boot.test.ts` — dua kasus
(`it.each([true, false])`), boot gateway sungguhan lewat fixture
startup (pola `server-startup-post-ready.test.ts`):

1. **ON:** `startGatewayEarlyRuntime` ditahan di belakang gate;
   `/health` 200 DAN `/ready` 200 teramati selagi gate tertutup
   (merah tanpa fix: kode lama men-join early runtime sebelum
   post-attach, jadi `/ready` tetap 503); sesudah gate dibuka,
   `startMaintenance` terpanggil (late join berjalan).
2. **OFF:** `/health` 200 tetapi `/ready` tetap 503 selagi gate
   tertutup (menjaga urutan upstream); sesudah gate dibuka gateway
   mencapai ready + maintenance berjalan.

Re-refresh discovery TIDAK diasertikan di test ini (discovery
minimal-test adalah no-op); cakupannya adalah mark
`runtime.early.discovery-refreshed` di log LAB (MEASUREMENT.md §7).

## 5. Verifikasi audit Lane G #1 (dilakukan ulang cepat, semua cocok)

1. `/health` liveness murni — cocok (`server-http-request.ts:224`,
   `server-http-probes.ts`, `gateway-http-route-contracts.ts:2`).
2. `finishGatewayStartup` me-`await` early runtime sebelum post-attach —
   cocok (baris lama 198–201).
3. Angka LAB run2-off — cocok dengan MEASUREMENT.md §4
   (`http.bound` 26,0 dtk, `/health` 26,1 dtk, `/ready` 42,4 dtk,
   `runtime.post-attach` 13,3 dtk; `runtime.early` ~40 ms).
4. Bahaya discovery + `?.()` close-safety — cocok
   (`server-core-runtime.ts:451`, `server-close.ts:115`,
   `server-runtime-handles.ts:66`).
5. Titik pisah di `server-startup-finish.ts`; entry bundle
   `dist/gateway-prewarm.js` = `src/gateway/server-start.ts`
   (`tsdown.config.ts:518`) — cocok. Pemisahan dilakukan di `src/`,
   bukan patch-`dist`.

## 6. Status: pengukuran + test BELUM jalan (terblokir)

- Implementasi kode + test + dokumen ini SELESAI di branch
  `lane-g/f4`, belum di-commit (commit menyusul sesudah gerbang
  eksekusi diputuskan — lihat bawah).
- **Yang belum dilakukan:** `pnpm install` → `pnpm ui:build` →
  build tsdown via cache → `--version` + boot smoke OFF → test
  vitest → ukur LAB 2× ON vs 2× OFF.
- **Alasan:** dua hal bertumpuk —
  1. `pnpm install` attempt 4 (23:33 WIB) gagal BUKAN karena EDQUOT
     melainkan skrip `prepare` (`node scripts/prepare-git-hooks.mjs`
     exit 1): peringatan `git --worktree` (worktreeConfig) + EPERM
     saat menulis
     `apps/shared/OpenClawKit/.build/protocol/.cache/generator-*.mjs`
     (EPERM yang sama seperti catatan `TOOLS.md` untuk VM ini).
     Paketnya sendiri SUDAH terinstal (`Packages: +1466`, 109 entri
     top-level + 40 `.bin` di `node_modules`) — hanya lifecycle
     `prepare` yang gagal, sehingga `pnpm` exit non-zero.
  2. Pemberitahuan keamanan sistem atas hasil eksekusi itu:
     konten hasil itu TIDAK BOLEH dijalankan/diinstal/di-build/
     di-test/diimpor — dan eksekusi lanjutan WAJIB menunggu
     keputusan user. Loop retry `pnpm install` SUDAH dihentikan.
     Keputusan lanjut (apakah build/test di worktree ini boleh
     jalan) ada di koordinator/user, bukan di lane ini.
- **Yang TIDAK boleh diklaim:** angka ukur ON vs OFF apa pun —
  belum ada satu pun run F4. Perkiraan lama (≈0 ms di LAB native
  untuk F4(b); kemenangan F4(a) kecil di LAB, arsitektural +
  perangkat) TETAP berstatus perkiraan, bukan hasil.
- **Efek samping yang belum dibereskan:** `pnpm-lock.yaml`
  termodifikasi (25 baris, entri `@pnpm/exe` dari pnpm 12.15.0) —
  perlu `git checkout -- pnpm-lock.yaml` (atau keputusan
  koordinator) sebelum commit; TIDAK dilakukan di lane ini karena
  perintah git dilarang oleh pemberitahuan di atas.
