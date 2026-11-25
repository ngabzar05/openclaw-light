# W1/W2/W3 — Katalog WebUI malas + cache snapshot + bundle ringan (Lane E)

> **Status:** diimplementasikan di branch `lane-e/w1-w3` (basis `mobile-fast-boot`
> `1d9ecf44`). Semua perilaku baru digated di belakang `OPENCLAW_MOBILE_BOOT=1`
> (A1); OFF = perilaku upstream murni.
> **Target yang dilayani:** fase skeleton WebUI ≥40 dtk sesudah READY (video
> perangkat 25 Nov 2026 02:39 WIB, v0.1.120, Xiaomi 12). Vonis F9 (Lane A):
> tidak ada celah ~150 dtk tanpa fase di LAB native — fase skeleton inilah
> target nyata lane ini.

## 1. Jalur kode yang ditemukan (baca, bukan tebak)

### 1.1 Jalur katalog tool (server)

| Langkah                  | Berkas                                                                                                                                                                                                                                                                                                                        | Keterangan                                                                                                                                                                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RPC `tools.catalog`      | `src/gateway/server-methods/tools-catalog.ts` (`toolsCatalogHandlers`)                                                                                                                                                                                                                                                        | Membangun grup inti (statis, murah) + grup plugin                                                                                                                                                                                                                            |
| Akuisisi registry plugin | `src/plugins/tools.ts:377` `acquireStandalonePluginToolRegistry`                                                                                                                                                                                                                                                              | Memanggil `acquirePluginRegistryForInspection`                                                                                                                                                                                                                               |
| Re-capture registry      | `src/plugins/loader-runtime-load.ts:239` `acquirePluginRegistryForInspection`                                                                                                                                                                                                                                                 | `loadOpenClawPluginsSteps({ activate: false, cache: false })` — **discovery + load penuh pada SETIAP panggilan, tanpa cache apa pun**. Inilah sumber stall 43,5 dtk yang dikutip riset (`dist/tool-catalog-*.mjs`, re-capture di `ensureStandalonePluginToolRegistryLoaded`) |
| `plugins.deny`           | `src/plugins/manifest-owner-policy.ts:60` `resolveManifestOwnerBasePolicyBlock` → `"blocked-by-denylist"`                                                                                                                                                                                                                     | Ditegakkan di `resolvePluginToolLoadState` (`src/plugins/tools.ts:143`) lewat `isManifestPluginAvailableForControlPlane`; deny mengalahkan allow-list                                                                                                                        |
| Kunci config             | `src/config/runtime-snapshot.ts:411` `resolveRuntimeConfigCacheKey`                                                                                                                                                                                                                                                           | Hash seluruh config (`stableConfigStringify` + sha256); mencakup `plugins.deny`, `tools.*`, agen                                                                                                                                                                             |
| Versi registry           | `src/plugins/runtime.ts:564` `getActivePluginRegistryVersion()`                                                                                                                                                                                                                                                               | Naik pada install/reload plugin                                                                                                                                                                                                                                              |
| Direktori ekstensi       | `src/plugins/install-paths.ts:83` `resolveDefaultPluginExtensionsDir` → `src/plugins/install-root-context.ts:41` `resolveActivePluginInstallDir`                                                                                                                                                                              | `<configDir>/extensions` (config dir = `OPENCLAW_STATE_DIR` bila disetel)                                                                                                                                                                                                    |
| Versi build              | `src/version.ts:215` `VERSION`                                                                                                                                                                                                                                                                                                | Berubah tiap rilis; menjaga snapshot tidak menyeberang update APK                                                                                                                                                                                                            |
| State dir                | `src/config/state-dir.ts:23` `resolveStateDir`                                                                                                                                                                                                                                                                                | `OPENCLAW_STATE_DIR` atau `~/.openclaw`                                                                                                                                                                                                                                      |
| Threading A1             | `src/gateway/mobile-boot.ts` → `src/gateway/server.ts:81` → `prepareGatewayServerBootstrap` (`mobileBoot` di return) → `prepareGatewayKernelState` (`...bootstrap`) → lifecycle (`...runtime`) → core runtime (`...runtime`) → `createGatewayRequestContext` (`src/gateway/server-request-context.ts`) → `context.mobileBoot` | Nilai di-resolve tepat sekali per proses; handler tidak pernah membaca env sendiri                                                                                                                                                                                           |

### 1.2 Konsumen katalog (UI)

| Konsumen           | Berkas                                                                                                                                 | Perilaku sebelum lane ini                                                                                                                                                                                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Panel Agen → Tools | `ui/src/pages/agents/tools.ts` `createAgentToolsCatalog` → `ui/src/pages/agents/panels-tools-skills.tsx` (`Configuration` + `Catalog`) | Satu request `tools.catalog` `{ includePlugins: true }`; selama menunggu tampil skeleton + daftar fallback bawaan; tombol profil dinonaktifkan                                                                                                                                                                 |
| Detail plugin      | `ui/src/pages/plugins/plugins-detail-reads.ts:101`                                                                                     | Request `tools.catalog` sekali; gagal → `undefined` (detail tetap tampil dari inspeksi lokal)                                                                                                                                                                                                                  |
| Composer chat      | `ui/src/pages/chat/chat-composer-capability-host.tsx:166`                                                                              | Memakai `tools.effective` (BUKAN `tools.catalog`); sudah in-memory cache + stale-while-revalidate di `src/gateway/server-methods/tools-effective.ts`. Selama menunggu, hanya toggle tool-access yang menampilkan "Memuat..." — **input chat tidak pernah digerbangi katalog** (verifikasi dari kode; lihat §5) |

### 1.3 Yang TIDAK memblokir first paint

- Shell chat (`/chat`) tidak memanggil `tools.catalog` sama sekali; route
  loader hanya menunggu data sesi/riwayat/model. Jadi "shell tampil segera"
  di W1 berarti: (a) RPC katalog tidak lagi menahan panel Tools, (b) composer
  tidak menunggu katalog, (c) katalog plugin menyusul lewat cache/retry.
- `tools.effective` sudah punya cache in-memory (fresh 10 dtk, stale 120 dtk)
  - coalescing inflight — tidak disentuh lane ini.

## 2. W1 — Katalog malas

### Server (`src/gateway/server-methods/tools-catalog.ts`, A1 ON)

1. Grup inti dibangun seperti biasa (statis, murah) dan selalu disertakan.
2. Bila snapshot valid ada (W2) → jawab lengkap dari snapshot.
3. Bila tidak ada snapshot → **jawab grup inti saja + `pluginCatalogPending: true`**
   dan mulai rebuild snapshot di latar (`rebuildToolCatalogSnapshot`,
   dikoalescing per kunci — panggilan bersamaan berbagi satu rebuild).
4. Bila `includePlugins: false` → jawab grup inti saja, tanpa snapshot
   (sama seperti upstream).

Skema protokol: `ToolsCatalogResultSchema`
(`packages/gateway-protocol/src/schema/tools-catalog.ts`) mendapat field
opsional `pluginCatalogPending?: boolean`. `closedObject` menuntut field ini
dideklarasikan — respons tanpa deklarasi akan gagal `Value.Check` di test.

### UI (`ui/src/pages/agents/tools.ts` + `panels-tools-skills.tsx`)

- `createAgentToolsCatalog`: bila hasil yang diterima membawa
  `pluginCatalogPending: true`, jadwalkan re-request latar (2 dtk, maks 10×,
  backoff tetap; timer dibersihkan pada `reset()`/supersede). Hasil core-only
  yang sudah diterima **tetap tampil** selama retry — tidak pernah kembali
  ke skeleton/fallback. Sesudah 10× gagal berturut-turut, polling berhenti
  (hasil core-only tetap tampil + indikator pending tetap terlihat);
  kunjungan ulang ke panel mencoba lagi dengan budget baru.
  **Perhatian implementasi:** `ensure` WAJIB berupa fungsi lokal di dalam
  `createAgentToolsCatalog`, bukan hanya metode pada objek yang dikembalikan
  — timer retry memanggil `ensure(...)` langsung; versi awal yang hanya
  mendefinisikannya sebagai metode objek melempar `ReferenceError: ensure is
  not defined` dari dalam `setTimeout` (ditangkap test UI, diperbaiki
  25 Nov 2026).
- `Catalog` di `panels-tools-skills.tsx`: selama `pluginCatalogPending`,
  tampilkan `SettingsLoadingSkeleton` ("Loading runtime tool catalog…") di
  bawah judul katalog — komponen + string yang sudah ada, tanpa CSS baru.
- `plugins-detail-reads.ts` tidak diubah: halaman detail bukan jalur
  first-paint; katalog detail tiba pada pembukaan berikutnya sesudah snapshot
  ada.

### Fail-open / fail-closed

- **Fail-open untuk tampilan:** katalog gagal/lambat → chat + grup inti tetap
  bisa dipakai; grup plugin menyusul.
- **Fail-closed untuk eksekusi:** eksekusi tool tidak pernah membaca katalog
  UI maupun snapshot. Agen me-resolve tool dari live registry pada tiap turn
  (`resolvePluginTools`, `src/plugins/tools.ts`). Tool yang katalognya belum
  dimuat tidak bisa dieksekusi lewat UI karena UI tidak mengeksekusi tool —
  dan tidak bisa dieksekusi lewat agen karena agen tidak memakai snapshot.

## 3. W2 — Cache snapshot katalog

Modul baru: `src/gateway/tool-catalog-snapshot.ts`.

- **Lokasi:** `<stateDir>/cache/tool-catalog-<16 hex pertama sha256(kunci)>.json`.
  Satu berkas per kunci (agen/konfigurasi berbeda = berkas berbeda).
- **Isi:** `{ version: 1, key, savedAtMs, result: ToolsCatalogResult }`.
  Tulis atomik (temp + rename); `mkdir cache` bila belum ada.
- **Kunci** (`buildToolCatalogSnapshotKey`): `configKey` (hash seluruh
  `openclaw.json` — mencakup `plugins.deny`) + `pluginRegistryVersion` +
  `sourceVersion` (`VERSION`, menjaga update APK) + `agentId` +
  `swarmEnabled` + `multipleIdentities` + `includePlugins` +
  `extensionsFingerprint` (nama + mtime tiap entri `<configDir>/extensions`,
  turun satu level ke dalam tiap direktori plugin agar rewrite file di
  dalam plugin ikut mengubah fingerprint; berkas lebih dalam ditangkap
  `pluginRegistryVersion`), di-hash; `"missing"` bila dir tidak ada,
  `"unavailable"` bila tak terbaca).
- **Validasi baca** (`readToolCatalogSnapshot`): berkas harus ada, JSON valid,
  `version === 1`, `key` sama persis, dan `Value.Check(ToolsCatalogResultSchema)`
  lolos. Gagal satu syarat → `null` (bukan error) → caller rebuild.
- **Pruning:** tiap tulis yang berhasil menghapus snapshot lain yang lebih
  tua dari 7 hari (best-effort; berkas tak-terparse dianggap basi).
- **Catatan penyimpangan dari AGENTS.md upstream:** aturan root
  `AGENTS.md` ("State and caches: SQLite, not new JSON/JSONL/sidecar
  stores") akan mengarahkan cache ini ke SQLite. Lane ini tetap memakai
  berkas JSON di `<stateDir>/cache/` karena **tugas lane + DESAIN
  memerintahkan jalur itu secara eksplisit** (`<stateDir>/cache/tool-catalog.json`)
  dan karena cache ini murni display-only (bukan state otoritatif, bukan
  data pengguna, mudah dihapus/dibangun ulang tanpa migrasi). Bila integrasi
  memutuskan mengikuti aturan upstream, pemindahan ke SQLite adalah
  perubahan mekanis: kunci, validasi skema, dan disiplin invalidasi di
  modul ini tidak berubah — hanya backend penyimpanannya.
- **I/O best-effort:** semua fungsi mengembalikan "tidak ada snapshot"
  / `false`, bukan throw — cache yang rusak tidak pernah memecahkan RPC.
- **Disiplin invalidasi = A3:** `openclaw.json` berubah → hash config berubah
  → kunci berubah → snapshot lama tidak disajikan; `dist/extensions/`
  berubah → `sourceVersion` (update APK) atau fingerprint ekstensi berubah →
  kunci berubah. Perubahan tanpa restart (plugin install) menaikkan
  `pluginRegistryVersion` pada reload.

## 4. W3 — Bundle awal ringan (audit)

Pengukuran "sebelum" memakai `dist/control-ui/` Lane A (basis commit sama,
`1d9ecf44`) — lihat `MEASUREMENT.md` §7 untuk angka sesudah.

### 4.1 Yang dimuat pada load pertama (`dist/control-ui/index.html`)

Total preload di `index.html`: **±5,06 MB tak-terkompresi** (JS+CSS).
Dua chunk terbesar adalah kode first-party itu sendiri:

| Aset                          | Ukuran   | Isi                                                                                                            |
| ----------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `control-ui-boot-shared-*.js` | 1.719 KB | 1.084 modul: `ui/src/lib` 228, `ui/src/components` 190, `ui/src/app` 153, `ui/src/pages` 148, `packages/*` 101 |
| `control-ui-boot-chat-*.js`   | 1.369 KB | 649 modul: `ui/src/pages` 417 (hampir semua kode halaman chat), `ui/src/components` 58, `ui/src/lib` 55        |
| `control-ui-connection-*.js`  | 275 KB   | Handshake/koneksi gateway — dibutuhkan first paint                                                             |
| `markdown-runtime-*.js`       | 204 KB   | Render pesan chat — dibutuhkan untuk riwayat                                                                   |
| `solid-runtime-*.js`          | 111 KB   | Runtime Solid                                                                                                  |
| `control-ui-boot-new-*.js`    | 267 KB   | Rute `/new` (juga di-preload)                                                                                  |

### 4.2 Yang SUDAH malas (tidak perlu dipindah)

- `pele.min-*.js` 644 KB (mermaid), `ghostty-web-*.js` 624 KB (terminal),
  `chat-attachment-video.worker-*.js` 588 KB, `locale-config-hints-*.js`
  400–732 KB per locale — semuanya chunk terpisah dan TIDAK ada di preload
  `index.html`; hanya `chat-english-*.js` 2,7 KB yang di-preload.
- Modul panel Agen/Tools (`ui/src/pages/agents/*`) TIDAK ada di grup boot
  `chat` (0 modul; hanya `route.ts` di `shared`) — panel Tools sudah
  route-split.

### 4.3 Vonis

_(Diisi sesudah `pnpm ui:build` di lane-e + perbandingan chunk — lihat
`MEASUREMENT.md` §7. Hipotesis awal: tidak ada impor berat yang layak
dipindah dari chunk awal; chunk awal = kode chat itu sendiri + runtime yang
dibutuhkan first paint. Bila pengukuran menemukan kandidat, dicatat di sini
beserta pemindahannya.)_

## 5. Yang diverifikasi dari kode (bukan klaim)

1. **Input chat tidak digerbangi katalog.** `chat-composer-capability-host.tsx`:
   `mutationBlockedReason` (yang menonaktifkan menu) hanya memeriksa
   `gatewayAvailable`, `capabilitiesReady` (gateway + sesi + runtimeConfig),
   dan akses patch — bukan hasil katalog. `toolAccessMutationBlockedReason`
   = "Memuat..." hanya menahan toggle tool-access, bukan pengiriman pesan.
   Pengiriman pesan me-resolve tool di server pada turn berjalan.
2. **Panel Tools sudah merender fallback inti tanpa katalog** —
   `resolveToolSections(null)` memakai `listCoreToolSections()` statis.
   W1 mengubah yang dirender saat menunggu: dari fallback/skeleton menjadi
   grup inti dari respons pending + skeleton kecil "plugin masih dimuat".
3. **`tools.catalog` tidak punya cache apa pun sebelum lane ini** —
   tiap panggilan menjalankan `loadOpenClawPluginsSteps` penuh
   (`cache: false`). `tools.effective` adalah satu-satunya jalur katalog
   yang sudah di-cache (in-memory, bukan disk).
4. **Snapshot tidak bisa memalsukan katalog** — snapshot hanya ditulis dari
   hasil build lengkap yang sama persis dengan respons OFF, dan hanya
   disajikan bila kunci cocok; eksekusi tidak membacanya (N7 terjaga:
   deny ada di kunci DAN ditegakkan saat build).

## 6. Guardrail yang disentuh / tidak disentuh

- N1 (auth + Control UI): tidak disentuh — RPC tetap di belakang auth gateway.
- N5 (validasi config): tidak disentuh.
- N7 (`plugins.deny`): ditegakkan dua lapis — saat build (deny mengecualikan
  plugin dari `onlyPluginIds`) dan saat kunci (deny mengubah hash config).
  Test: `tools-catalog-mobile-boot.test.ts` ("honors plugins.deny…").
- N10 (OFF = upstream): OFF tidak membaca/menulis snapshot, tidak
  menyetel `pluginCatalogPending`, dan menjalankan build inline yang sama
  persis (kode diekstrak ke `buildPluginCatalogGroups` tanpa perubahan
  perilaku). Test OFF menegaskan tidak ada berkas snapshot yang ditulis.
- D5 (jangan hapus `dist/control-ui`): tidak disentuh. Tidak ada patch-ke-`dist`.

## 7. Test — hasil (25 Nov 2026, VM LAB)

| Test                           | Berkas                                                         | Yang dibuktikan                                                                                                                                                                                                                 | Hasil                                 |
| ------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Kunci berubah pada tiap input  | `src/gateway/tool-catalog-snapshot.test.ts`                    | 8 input kunci (config, registry, source, agent, swarm, identities, includePlugins, extensions) masing-masing mengubah kunci; deterministik                                                                                      | 16/16 lolos                           |
| Fingerprint ekstensi           | sama                                                           | `"missing"` bila dir tak ada; stabil bila tak berubah; berubah bila mtime berubah                                                                                                                                               | 16/16 lolos                           |
| Round-trip + penolakan         | sama                                                           | tulis→baca sama; kunci lain → null; JSON rusak / versi salah / hasil gagal skema → null                                                                                                                                         | 16/16 lolos                           |
| Prune 7 hari + scope per kunci | sama                                                           | snapshot 8 hari terhapus saat tulis; dua kunci = dua berkas                                                                                                                                                                     | 16/16 lolos                           |
| Miss → pending → hit           | `src/gateway/server-methods/tools-catalog-mobile-boot.test.ts` | panggilan 1: core-only + pending (bukti respons tidak menunggu re-capture; `acquire` paling banyak 1× karena rebuild latar boleh sudah jalan), snapshot tertulis di latar, panggilan 2: grup plugin lengkap, `acquire` tetap 1× | 3/3 lolos (332,59 dtk)                |
| Deny + invalidasi              | sama                                                           | snapshot deny tidak berisi beta; hapus deny → pending lagi → rebuild berisi beta (test me-reload registry, meniru gateway saat config berubah)                                                                                  | 3/3 lolos (138,37 dtk untuk test ini) |
| OFF = upstream                 | sama                                                           | tanpa `mobileBoot`: build inline, tanpa pending, tanpa berkas snapshot                                                                                                                                                          | 3/3 lolos                             |
| Panel pending → retry          | `ui/src/pages/agents/agents-tools-catalog.test.tsx`            | grup inti tampil dari hasil pending (bukan fallback); re-request otomatis ±2 dtk; grup plugin muncul; skeleton pending hilang                                                                                                   | 8/8 lolos                             |
| Regresi OFF (existing)         | `src/gateway/server-methods/tools-catalog.test.ts`             | tidak diubah; tetap hijau — perilaku OFF byte-sama                                                                                                                                                                              | 6/6 lolos (256,89 dtk)                |

Catatan run: test handler butuh timeout tunggu snapshot 180 dtk + timeout
per-test 300 dtk (re-capture plugin penuh di VM yang sibuk memakan
60–140 dtk; timeout 120 dtk bawaan vitest pernah memotong test OFF yang
sebenarnya lolos). Test UI sempat gagal 2× karena label skeleton hanya ada
sebagai `aria-label` (bukan teks) dan string i18n berakhiran elipsis `…` —
asersi diperbaiki ke `querySelector('[aria-label="Loading runtime tool
catalog…"]')`, bukan `textContent`. Typecheck/lint/format: `pnpm check`
penuh dan `pnpm check:changed` **tidak dapat jalan di VM ini**
(`check:changed` mendelegasikan ke Crabbox yang fetch-nya diblokir sandbox;
`pnpm check` mati diam-diam di fase database-worker); sebagai gantinya
dijalankan langsung `tsgo:core` + `tsgo:ui` + oxlint + format pada berkas
yang berubah (lihat laporan lane).

## 8. Cara menjalankan ulang

```bash
# dari root worktree lane-e
pnpm install
pnpm test src/gateway/tool-catalog-snapshot.test.ts src/gateway/server-methods/tools-catalog-mobile-boot.test.ts src/gateway/server-methods/tools-catalog.test.ts
pnpm --filter ./ui test src/pages/agents/agents-tools-catalog.test.tsx  # atau: pnpm ui:test <berkas>
pnpm ui:build   # sesudah perubahan UI; verifikasi hash /assets/index-*.js berubah
```

Ukur LAB (2× ON vs OFF): `docs/mobile-fast-boot/measure-baseline.sh`
ditambah skrip waktu RPC `tools.catalog` (lihat `MEASUREMENT.md` §7).
Chat pertama TIDAK terukur di lab tanpa model/API key — dicatat jujur di sana.
