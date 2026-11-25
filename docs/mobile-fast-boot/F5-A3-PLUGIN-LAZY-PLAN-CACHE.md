# F5 + A3 — Plugin capture async, lazy load & cache rencana plugin (Lane D)

> **Status:** implementasi Lane D di branch `lane-d/f5-a3`, basis
> `mobile-fast-boot` `1d9ecf44`. Semua perilaku digated di belakang A1
> (`OPENCLAW_MOBILE_BOOT=1`); OFF = upstream murni.
> **Baca dulu:** `DESIGN.md` §9.1 (F5) + §9.2 (A3),
> `~/workspace/research-start/per-harness/openclaw.md` §5.9,
> `MEASUREMENT.md` §4 (baseline LAB run2-off).

## 1. Ringkasan

| Item              | Yang dibangun                                                                                                                    | Efek yang diukur [LAB]                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| F5a               | `preparePluginGenerationArtifact` async-only selama boot (tidak pernah `requestSync`/`Atomics.wait` di thread utama)             | `eventLoopMax` selama `plugins.runtime-post-bind` (run2-off: 803,2 ms — bukti blokir main thread) |
| F5 lazy split     | `loadGatewayStartupPluginRuntime` hanya memuat plugin essential sebelum `/ready`; sisanya dimuat di latar sesudah `/ready`       | `plugins.runtime-post-bind` (run2-off: 9,7 dtk) + `/ready` (42,4 dtk)                             |
| F5 trim post-bind | Impor `../plugins/runtime.js` ditunda sampai jalur dispose (hanya bila mobile boot ON); atribusi waktu `state-migration` dipecah | Gap ~7,2 dtk tak teratribusi di dalam `plugins.runtime-post-bind` (run2-off)                      |
| A3                | Cache rencana plugin di `<stateDir>/cache/startup-plugin-plan.json`                                                              | `plugins.bootstrap.lookup-table` → `startupPlanMs` (run2-off: 7,8 ms)                             |

**Jujur soal besaran:** di LAB hanya 3 plugin yang masuk rencana
(`teams-meetings`, `zoom-meetings`, `memory-core`; total load 2,4 dtk)
dan resolusi rencana hanya ~8 ms. Jadi F5/A3 di LAB menghemat
**detik, bukan puluhan detik** — nilai penuhnya ada di perangkat, di
mana rencana plugin jauh lebih besar (plugin terkonfigurasi +
channel + memory + provider). Dokumen ini tidak mengklaim lebih.

## 2. F5a — capture async (tidak ada lagi `requestSync` saat boot)

`src/plugins/plugin-generation-worker.ts`:

- `PreparationParameters.mobileBoot` diteruskan dari loader sampai
  `preparePluginGenerationArtifact` (`loader-module-runtime.ts` →
  `loader-runtime-core.ts` → `server-plugins.ts` →
  `server-startup-plugins.ts`).
- Bila `mobileBoot.enabled`, codec invoke memakai `request` async —
  **tidak pernah** `requestSync` (`Atomics.wait`). Call `request`
  untuk source-capture tidak memakai timeout (menyamai semantik
  `requestSync` yang juga tanpa timeout).
- `dispose()` sinkron pada artefak hasil worker tidak berubah (loader
  memakai `disposeAsync()`; artefak in-process tidak terpengaruh).

### F5b — cache artefak capture antar-boot: TIDAK diimplementasikan

Diputuskan tidak dikerjakan di lane ini (bukan dikerjakan diam-diam):

- Sistem custody capture (`createPluginSourceCaptureRoot` membuat
  mkdtemp baru tiap capture; release menghapus dir; retensi native)
  membuat reuse dir antar-boot berisiko merusak invarian
  custody/retention. Butuh design review terpisah.
- Biaya capture di LAB melebih-lebihkan biaya di perangkat: plugin di
  perangkat prebuilt (`preferBuiltPluginArtifacts`), sementara LAB
  mengukur mode source (memory-core `modulePreparationMs` 1071,7 ms).
- Item terbuka untuk koordinator, bukan bagian dari lane ini.

## 3. F5 — lazy split: essential vs deferred

`resolveMobileBootStartupPluginSplit` di
`src/gateway/server-startup-plugins.ts`. Split hanya mempartisi rencana
yang **sudah** ter-resolve (deny + allow-list sudah diterapkan saat
resolusi rencana) — plugin yang di-deny tidak pernah mencapai split.

**Essential (dimuat sebelum `/ready`):**

- Pemilik provider terkonfigurasi: model, generation, voice, speech,
  web-search, decision, embedding, worker, storage (mirror kebijakan
  `canStartGatewayStartupPlugin`).
- Plugin memory-slot + context-engine-slot.
- Pemilik channel terkonfigurasi; pemilik agent-harness terkonfigurasi.
- Plugin dengan `hasConfiguredActivationPath`.
- **Yang tak terklasifikasi → essential** (fail-closed ke arah dimuat
  saat boot, bukan ke arah di-drop diam-diam).
- Bila essential kosong padahal rencana tidak kosong → seluruh rencana
  tetap essential (boot tidak boleh kosong bergantung pada load latar).

**Deferred (dimuat di latar sesudah `/ready`):** sisa rencana.

### Alur deferred load

1. `loadGatewayStartupPluginRuntime` (panggilan pertama, sebelum
   `/ready`) mengembalikan `deferredPluginIds` bersama registry essential.
2. `server-startup-finish.ts` menyimpan ids itu; closure
   `loadDeferredStartupPlugins` memanggil
   `loadGatewayStartupPluginRuntime` kedua dengan **rencana penuh +
   `previousRegistry` = registry essential** — record yang tidak berubah
   di-retain (`resolvePluginRecordRetention`), tidak pernah di-reload.
3. `server-startup-post-attach.ts`: sesudah `logGatewaySidecarsReady`,
   load deferred dijalankan fire-and-forget lewat `trackStartupWork`
   (guard `isClosing()`, warn bila gagal, fase
   `plugins.runtime-deferred`). Attach memakai `onStartupPluginsLoaded`
   yang sama (publish + discovery refresh + capability reconcile).
4. Service plugin deferred dijalankan sesudah attach via
   `startPluginServices({ previous: <handle saat ini> })` — service yang
   sudah jalan di-retain, tidak pernah di-restart (fase
   `plugins.runtime-deferred-services`). Gate-nya BUKAN
   `shouldStartPluginServices` (yang false begitu handle service
   pertama ada — akan mematikan start deferred selamanya), melainkan
   `shouldStartDeferredPluginServices`: hanya false bila reload plugin
   sedang berjalan.
5. Satu plugin gagal **tidak pernah** menggagalkan boot (fail-closed
   per plugin — upstream `loadIntent: "startup"` +
   `throwOnLoadError: false` — dipertahankan; load latar yang gagal
   hanya tercatat sebagai warn).

### Trim post-bind

- `loadStartupPluginsIfNeeded(loader, phase)` diparameterisasi: loader
  pertama mengukur `plugins.runtime-post-bind`, loader deferred
  mengukur `plugins.runtime-deferred`.
- Dengan mobile boot ON, `import("../plugins/runtime.js")` yang eager
  (hanya dipakai untuk dispose registry yang tidak ter-attach) ditunda
  sampai jalur dispose membutuhkannya. OFF mempertahankan impor eager
  (upstream). Kedua jalur diukur (`plugins.runtime-import` pada OFF).
- `confirmPluginStateMigrationReadiness` + impornya kini diukur
  terpisah (`plugins.state-migration-import`,
  `plugins.state-migration-readiness`) — untuk mengatribusi gap 7,2 dtk
  di dalam `plugins.runtime-post-bind` pada run ukur berikutnya.

## 4. A3 — cache rencana plugin

Modul baru `src/plugins/startup-plugin-plan-cache.ts`, hook di
`loadGatewayStartupPluginPlanWithMetadata`
(`src/plugins/gateway-startup-plugin-loader.ts`).

- **Lokasi:** `<stateDir>/cache/startup-plugin-plan.json`
  (ditulis atomik: temp + rename). State dir + `mobileBoot`
  di-threading dari `prepareGatewayPluginBootstrap`
  (`server-startup-bootstrap.ts` → `resolveStateDir(process.env)`).
- **Isi:** `{ version: 1, key, plan: { pluginIds, channelPluginIds },
  startupPlanMs }`. `startupPlanMs` yang tersimpan adalah biaya
  resolusi asli (provenance); pada hit, loader melaporkan biaya
  baca-cache sebagai `startupPlanMs` (akuntansi jujur per boot).
- **Kunci** (`resolveStartupPluginPlanCacheKey`): versi cache (1) +
  kunci cache snapshot metadata (env fingerprint, hash kebijakan
  plugin, load paths, workspace/state dir, **fingerprint index
  terpasang** — mencakup isi manifest di `dist/extensions/`) + hash
  config penuh + hash activation-source config + worker provider ids +
  platform + ambient trigger policy.
- **Invalidasi:** `openclaw.json` berubah → hash config berubah;
  manifest di `dist/extensions/` berubah → fingerprint index berubah;
  deny berubah → hash kebijakan berubah. File hilang/rusak/versi
  tidak cocok/kunci tidak cocok = miss (resolusi normal).
- **Best-effort:** gagal baca/tulis tidak pernah melempar — boot hanya
  kehilangan hematannya, bukan fungsinya. Cache tidak mengubah plugin
  apa yang dimuat, hanya apakah rencana (yang sudah difilter deny)
  dihitung ulang.
- **Catatan kejujuran:** resolusi rencana di LAB hanya ~8 ms; snapshot
  metadata sendiri tetap di-resolve sekali per boot di bootstrap
  (upstream). A3 menghemat resolusi rencana, bukan discovery.

## 5. Fase trace baru (F9)

| Fase                                | Arti                                         |
| ----------------------------------- | -------------------------------------------- |
| `plugins.mobile-boot-split`         | jumlah essential/deferred + ids deferred     |
| `plugins.runtime-deferred`          | load latar deferred (sesudah `/ready`)       |
| `plugins.runtime-deferred-services` | start service plugin deferred                |
| `plugins.runtime-import`            | impor eager `plugins/runtime.js` (hanya OFF) |
| `plugins.state-migration-import`    | impor readiness check                        |
| `plugins.state-migration-readiness` | `confirmPluginStateMigrationReadiness`       |

## 6. Berkas yang berubah

- `src/plugins/plugin-generation-worker.ts` — F5a async-only.
- `src/plugins/loader-types.ts`, `src/plugins/runtime/load-context.ts`,
  `src/plugins/loader-module-runtime.ts`,
  `src/plugins/loader-runtime-core.ts`, `src/gateway/server-plugins.ts`
  — threading `mobileBoot`.
- `src/plugins/gateway-startup-plugin-activation.ts` —
  `manifestOwnsConfiguredContract(Group)` di-export (dipakai split).
- `src/gateway/server-startup-plugins.ts` — split + `mobileBoot` /
  `previousRegistry` / `deferredPluginIds` + atribusi state-migration.
- `src/gateway/server-startup-finish.ts` — teruskan `mobileBoot`,
  closure `loadDeferredStartupPlugins`.
- `src/gateway/server-startup-post-attach.ts` — loader
  terparameterisasi, trim impor runtime, load + service deferred.
- `src/gateway/server-startup-bootstrap.ts` — threading `mobileBoot` +
  `stateDir` ke `prepareGatewayPluginBootstrap`.
- `src/plugins/startup-plugin-plan-cache.ts` (baru) + hook di
  `src/plugins/gateway-startup-plugin-loader.ts` — A3.
- Test: `src/plugins/startup-plugin-plan-cache.test.ts`,
  `src/plugins/gateway-startup-plugin-loader.mobile-boot.test.ts`,
  `src/gateway/server-startup-plugins.mobile-boot.test.ts`.

## 7. Verifikasi

- Typecheck kanonis `pnpm tsgo:core` (via `scripts/run-tsgo.mjs`):
  **exit 0, 0 error** (25 Nov 2026, run pertama; dan run ke-3
  pasca-perbaikan gate, exit 0 pada 02:48 WIB). Retry ke-2 timeout
  600 dtk karena beban host; retry ke-3 sempat gagal karena stale
  lock `.artifacts/dist-artifacts.lock` dari proses yang mati saat
  restart runtime (lock dihapus sesudah verifikasi pemiliknya mati,
  lalu retry berhasil). Catatan: `tsrs --noEmit` mentah melaporkan
  749 error declaration-emit di file test-support yang tidak disentuh
  lane ini (artefak preview tsrs; 0 error di file lane ini;
  interseksi dengan diff lane ini kosong).
- 12 pemeriksaan fungsional lewat `tsx` (cerminan asersi vitest):
  **12/12 lolos** — round-trip cache, miss/invalidasi, gate,
  hit/miss loader, klasifikasi split, fail-closed, komposisi deny.
- Vitest baru lane ini (direct-form `node_modules/.bin/vitest`, runner
  wrapper stall di VM ini — lihat bawah): **18/18 lolos** — A3
  (`startup-plugin-plan-cache.test.ts` 11 +
  `gateway-startup-plugin-loader.mobile-boot.test.ts` 3) dan split F5
  (`server-startup-plugins.mobile-boot.test.ts` 4).
- Regresi plugins: batch 1 **95 ✓** (`channel-plugin-ids` 91 +
  `plugin-generation-worker` 4); batch 2 **32 ✓ + 1 gagal** —
  `gateway-startup-plugin-providers.test.ts` > queued I/O
  (`events` kosong). Investigasi: test itu **lolos isolasi di lane-d
  (9.248 ms) dan lolos di basis 1d9ecf44 (9.193 ms)** → kegagalan batch
  adalah flake beban (load 15–56 saat batch), BUKAN regresi lane ini.
- Regresi gateway `server-startup-plugins.test.ts` (file penuh,
  20 mnt, load 17–56): **18 lolos, 5 gagal**. Kelimanya dijelaskan
  BUKAN regresi, lewat kontrol basis 1d9ecf44 (salinan basis diperbaiki
  dari `git archive` — 18.453 berkas 0-byte akibat EPERM, dipulihkan
  per-chunk; `node_modules` workspace di-symlink dari lane-d; salinan
  basis dihapus sesudah kontrol selesai, 25 Nov 2026, untuk
  membebaskan kuota disk):
  - "returns admitted plugins while native receipt…" timeout 126 dtk —
    **direproduksi di basis (timeout 154 dtk)** → flake bawaan.
  - "validates invalid bindings…" timeout 258 dtk — **gagal juga di
    basis** (asersi: promise resolve padahal diharapkan reject, 10,7
    dtk) → kegagalan bawaan, manifestasi berbeda karena beban.
  - "validates valid bindings…" (140 dtk) dan "validates invalid with
    failed cleanup…" (194 dtk) timeout — lolos di basis pada beban
    ringan; worker vitest lane-d hanya 61 dtk CPU dalam 14 mnt wall
    (starved) → timeout beban.
  - "reports registered memory provider setup: ready" gagal asersi
    (warn `Shared-state read and cleanup failed`) — **lolos isolasi
    di lane-d (3/3, "ready" 6.841 ms)** dan lolos di basis → polusi
    beban antar-test dalam satu file, bukan regresi. Warn itu sendiri
    kode upstream (`server-startup-plugins.ts:362` di basis).
- Regresi gateway `server-startup-post-attach.test.ts` (config
  `vitest.gateway-server-isolated.config.ts` — berkas ini isolated,
  bukan bagian config gateway-server biasa): **56/56 lolos, 0 gagal**.
- Vitest di VM ini: runner wrapper (`test-projects.mts` /
  `run-vitest.mjs`) stall saat startup worker (cache miss
  `vitest-workers`, tanpa output >120 dtk) — termasuk untuk file test
  upstream yang tidak disentuh lane ini; direct-form vitest bekerja.
  Beban host ekstrem selama semua run ini (load 13–56, MemAvailable
  1–5 GB, restart runtime berkala membunuh job latar) — angka durasi
  test tidak dapat dibandingkan antar-run; yang dibandingkan adalah
  lolos/gagal.
- Ukur LAB: lihat `MEASUREMENT.md` §7 (sesudah run ukur).

## 8. Hal terbuka

1. **F5b** (cache capture antar-boot) — butuh design review terpisah
   (custody/retention). Lihat §2.
2. **Hipotesis gap 7,2 dtk** (impor `plugins/runtime.js`) — verifikasi
   lewat split trace pada run ukur (§3: fase
   `plugins.runtime-import` vs `plugins.state-migration-*`).
3. **Vitest di VM ini** — runner stall saat startup worker; validasi
   test di CI.
4. **Dampak perangkat** — nilai F5/A3 sesungguhnya (rencana plugin
   perangkat jauh lebih besar dari LAB 3-plugin) hanya terukur di
   perangkat; LAB hanya membuktikan mekanisme + tidak ada regresi.
