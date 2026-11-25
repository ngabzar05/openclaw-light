# DESAIN — Rombak Arsitektur OpenClaw: Mobile Fast Boot

> **Status:** DESAIN (belum diimplementasi penuh — lihat §10 untuk status tiap perubahan).
> **Basis:** `openclaw/openclaw` @ tag `v2026.11.6` (commit `06afb10d3272cc9deaf38ca6a3b7b839d5935638`).
> **Perintah pemilik:** 25 Nov 2026 03:14 WIB — "benar-benar merombaknya agar startnya cepat; tidak masalah jika saat ada update harus berusaha lebih keras; yang penting ada arahan dokumentasi yang detail, lengkap, dan super komprehensif agar setiap ada update nantinya bisa dilakukan oleh AI agent dengan presisi."
> **Otorisasi clone:** pemilik sudah diberitahu tentang pemberitahuan keamanan sistem atas clone (risiko eksekusi kode saat memproses repo clone) dan sesudah itu memerintahkan perombakan ini, yang mengharuskan clone, modifikasi, build, dan test. Dicatat sebagai persetujuan eksplisit pemilik untuk memproses clone source OpenClaw @ `v2026.11.6`.
> **Batas arsitektur:** PERTAHANKAN Opsi A — Gateway pemilik tunggal, WebUI dipertahankan (keputusan pemilik 24 Nov 2026). Jangan ubah model kepemilikan.
> **Target:** definisi B — "Buka → bisa dipakai dalam hitungan detik"; definisi A (waktu-ke-probe) sedekat mungkin. **Lantai gateway puluhan detik tetap berlaku** — fork/rombak tidak bisa memberi 2 detik untuk gateway itu sendiri. Yang disamai adalah _pengalaman_ OpenCode, bukan angka boot mentah gateway.

## 0. Ringkasan eksekutif

Arsitektur OpenClaw hari ini adalah **satu gateway resident yang mengerjakan semuanya secara berurutan sebelum mengaku siap**: config valid → state sqlite → recovery → migrasi sesi → model runtime → plugin registry → Control UI. Tiap "dan" adalah gerbang serial, dan socket HTTP baru diikat setelah sebagian besar gerbang itu dilewati. Hasilnya (LAB PRoot+QEMU, 283–330 dtk; perangkat v0.1.120, video 25 Nov 02:39 WIB: tile READY ~95 dtk, WebUI ≥40 dtk skeleton sesudah ready).

Rombakan ini **membalik urutan itu** tanpa mengubah arti "siap":

1. **Ikat socket dulu** (proses depan tipis): HTTP server + rute probe `/health`/`/ready` + auth gate + state-owner diikat dalam ~1–2 detik; graf-sisa (channels, cron, model runtime, worker envs, discovery, skills) diimpor dinamis sesudah `http.bound`. Ini F4 — tuas struktural terbesar.
2. **Semua yang berat pindah ke latar / malas**: admission + migrasi sesi (F1), rencana + capture plugin (F5), sub-langkah bootstrap (F3), migrasi inkremental (A4), cache rencana plugin (A3).
3. **Lock yang tidak lagi menunggu 300 dtk** (F2, fast-path single-owner mobile) — dengan bind eksklusif TCP 18789 sebagai penjaga terakhir.
4. **UI tidak menunggu katalog** (perbaikan fase WebUI): chat shell langsung tampil; katalog tool dimuat malas di latar (atau dari cache). Ini yang memangkas ≥40 dtk skeleton sesudah ready di perangkat.
5. **Satu saklar** (`OPENCLAW_MOBILE_BOOT=1`, A1) mengaktifkan semua perilaku fork. Default OFF = perilaku upstream murni (byte-perilaku identik kecuali nomor versi) — satu-satunya cara rebase tetap teruji (N10).

Yang **TIDAK** diubah: arti `/health` (liveness) dan `/ready` (readiness) — tidak ada readiness palsu (A2-R2 ditolak); auth + token (N1); bind eksklusif (N2); integritas state/sqlite (N3); invarian lock (N4, kecuali mode single-owner + N2); validasi config + exit 78 (N5); migrasi sesi tidak pernah dilewati, hanya ditunda (N6); semantik `plugins.deny` (N7); lantai runtime Node (N8); perilaku default = upstream bila saklar OFF (N10).

## 1. Arsitektur lama vs baru (alur boot)

### 1.1 Alur lama (upstream 2026.11.6) — [TERBUKTI: openclaw.md §5]

```text
openclaw.mjs → dist/entry.js (~30 impor statis) → dist/cli/run-main.js
  → gateway-run-bootstrap (58,6 dtk [LAB])
    → state-snapshot 10,8 + plugin-config 6,7 + database/session-runtime-import 10,3
  → gateway-lock (18 dtk bersih; worst-case 300 dtk)
  → sessions.admission (27,2 dtk) — migrasi seluruh sesi, pra-listen
  → gateway.server-start-import (22,1 dtk)
  → http.listen → http.bound
  → runtime.early (discovery, skills, cron)
  → runtime.post-attach → plugins.runtime-post-bind (67,7 dtk)
  → mark("ready") — /ready 200
  → (pengguna mengetuk Buka) → Control UI → stall katalog 43,5 dtk → skeleton
```

Fase LAB (VM PRoot+QEMU): impor graf ~30 dtk, bootstrap 58,6, lock 18 (worst 300),
server-import 22,1, admission 27,2, **celah tanpa fase ~150 dtk (~49%)**, plugin 67,7
**sesudah** health. Health-200 pertama ≈306 dtk; `http server listening` ≈393 dtk
(jam internal). Perangkat (video): tile READY ~95 dtk; WebUI ≥40 dtk skeleton.

### 1.2 Alur baru (rombak) — target

```text
openclaw.mjs → dist/entry-gateway.js (F6, hanya graf gateway)
  → [A1 ON] graf-listen saja: HTTP server + /health + /ready + auth gate + state-owner
  → http.listen → http.bound  ──► /health 200 (liveness, ~1–2 dtk dari spawn)
  │   (paralel, di latar — tidak lagi menghalangi /health):
  │   ├─ F1: sessions.admission + migrasi sesi (gerbang RPC menahan chat.send sampai selesai)
  │   ├─ F3: plugin-config, database/session-runtime-import (lazy)
  │   ├─ F5: plugin capture async + lazy runtime (hanya provider terkonfigurasi + memory-core saat boot)
  │   ├─ A3: cache rencana plugin (skip discovery bila hash cocok)
  │   ├─ A4: migrasi inkremental (watermark; hanya sesi berubah)
  │   ├─ runtime.early (discovery, skills, cron)
  │   └─ F9: instrumentasi tiap langkah (termasuk celah lama) → startup-phases.log
  → runtime.post-attach → mark("ready") — /ready 200 (jujur, sesudah post-attach)
  → (pengguna mengetuk Buka) → Control UI shell langsung tampil
      → katalog tool dimuat malas di latar / dari cache (tanpa skeleton 40 dtk)
```

**Prinsip yang dipertahankan:** `/health` tetap liveness (dijawab proses Gateway yang
asli, bukan shim — A2-R1, bukan R2); `/ready` tetap readiness (200 hanya sesudah
post-attach); migrasi tidak pernah dilewati (N6); RPC agen menunggu migrasi (gerbang
per-RPC, bukan gerbang per-proses — pola yang sama dengan gerbang model runtime).

## 2. Daftar perubahan per berkas/fungsi

Semua perubahan di belakang saklar tunggal `OPENCLAW_MOBILE_BOOT=1` (A1) kecuali
yang dinyatakan lain. Rujukan lengkap (bukti + risiko + kontribusi) ada di
`~/workspace/research-start/per-harness/openclaw.md` §9 — bagian ini adalah
ringkasan eksekutif desain, bukan pengganti §9.

### 2.1 DIUBAH (F1–F9)

| #   | Perubahan                                                                                            | Berkas/fungsi (src/)                                                                                                                                                                                                                                                                                                                                                  | Kontribusi [LAB]                                                       | Risiko                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| F9  | Instrumentasi celah tanpa fase (PRASYARAT — kerjakan dulu)                                           | `measureGatewayBootstrapStep` / `createGatewayDispatchStartupTrace` (`startup-trace`), `STARTUP_PROGRESS_PHASES` (`server-startup-trace`); tambah `measure()` di impor graf entry, tiap impor `server-start-import`, celah 221,1–304,2 dtk, `state-snapshot`/`plugin-config`                                                                                          | 0 dtk (tapi tanpa ini F3/F4 menebak)                                   | Nol (hanya log)                                                                                |
| F1  | Tunda `sessions.admission` sampai sesudah HTTP listen                                                | `src/gateway/server-startup-session-migration.ts` (`prepareGatewayStartupSessions`) → `src/config/sessions/startup-migration.ts` (`runSessionStartupMigration`); gerbang RPC menahan `chat.send`/`agent` sampai migrasi selesai                                                                                                                                       | 27,2 dtk dari waktu-ke-`/health`                                       | Sedang-rendah; gerbang RPC wajib (N6)                                                          |
| F2  | Fast-path gateway-lock single-owner mobile                                                           | `src/infra/gateway-lock.ts` (`acquireGatewayLock`) → `src/infra/gateway-state-owner.ts` (`classifyGatewayLockProcessNamespace`) → `src/shared/pid-alive.ts` (`resolveGatewayOwnerStatusSync`, `isPidDefinitelyDead`); env `OPENCLAW_MOBILE_SINGLE_OWNER=1`                                                                                                            | 18 dtk (bersih); hingga ~270 dtk (kotor: 300→30 dtk)                   | TINGGI bila env bocor — mitigasi: bind eksklusif 18789 (N2) + env hanya dari plan Rust Polones |
| F3  | Pecah `gateway-run-bootstrap` — tunda sub-langkah pasca-listen                                       | `run-command` (orkestrasi bootstrap); `plugin-config` pasca-listen; `database/session-runtime-import` jadi lazy (`createLazyRuntimeModule`); `state-snapshot` malas (hanya bila ada pembaca bersamaan)                                                                                                                                                                | [HIPOTESIS] 17 dtk                                                     | Sedang; impor lazy salah urut = `ReferenceError`                                               |
| F4  | Restrukturisasi early-listen — ikat socket dulu, impor sisanya belakangan (TUAS STRUKTURAL TERBESAR) | `gateway-prewarm.js` (`http.listen` → `http.bound`) + `server-start-import` + `startGatewayEarlyRuntime` (`server-startup-early`); pisah graf-listen vs graf-sisa (impor dinamis sesudah `http.bound`); `runtime.early` seluruhnya pasca-`/health`-200                                                                                                                | [HIPOTESIS] 22–80 dtk                                                  | TINGGI; graf impor 9.384 baris harus dipisah tanpa siklus baru; audit modul satu per satu      |
| F5  | Plugin capture async + lazy plugin runtime                                                           | `src/plugins/plugin-generation-worker.ts` (`preparePluginGenerationArtifact`: `requestSync`→`request` async) → `src/gateway/server-startup-plugins.ts` (`loadGatewayStartupPluginRuntime`) → `src/gateway/server-startup-post-attach.ts` (`plugins.runtime-post-bind`); cache artefak capture di `captures/`; hanya provider terkonfigurasi + `memory-core` saat boot | 0 dtk ke `/health`; 67,7 dtk ke "terasa siap" + hapus wedge-kill palsu | Sedang; fail-closed per plugin; hormati `plugins.deny` (N7)                                    |
| F6  | Code-split entry: `gateway run` tidak mengimpor pohon CLI                                            | Entry gateway baru `src/entry-gateway.ts` (hanya: launcher compile-cache, trace, `run-main` jalur gateway, `gateway-prewarm.js`); perintah lain tetap `entry.js` lama                                                                                                                                                                                                 | [HIPOTESIS] satuan detik (I/O)                                         | Rendah-sedang; dua entry harus dijaga sepakat                                                  |
| F7  | Compile cache jadi di dalam aset — DITOLAK, jangan dikerjakan                                        | —                                                                                                                                                                                                                                                                                                                                                                     | —                                                                      | Seed cache miss (path+arsitek); cache hangat terbukti tidak memangkas boot                     |
| F8  | Matikan update-admission + update check di dalam fork                                                | `tryRunUpdateAdmissionBeforeStartup` (`entry.js` → `run-main-update-admission-*.mjs`) + `update-startup-*.mjs`                                                                                                                                                                                                                                                        | [BELUM TERUKUR], kecil                                                 | Rendah; kehilangan `openclaw update` (disengaja — update lewat APK)                            |

### 2.2 DITAMBAH (A1–A5)

| #   | Tambahan                                                                             | Berkas/fungsi                                                                                                                                                                                                                     | Catatan                                                                                                                      |
| --- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| A1  | Profil boot mobile (`OPENCLAW_MOBILE_BOOT=1`) — saklar tunggal semua F               | `src/cli/run-main.ts` / `src/gateway/server-startup-bootstrap.ts`; baca env sekali, teruskan sebagai `MobileBootOptions` ke lock/admission/plugin loader                                                                          | Default OFF = upstream murni. Test: boot OFF harus byte-perilaku identik dengan upstream 2026.11.6 (kecuali nomor versi)     |
| A2  | Gerbang ready lebih awal — varian R1 SAJA ("listen lebih awal", tanpa komponen baru) | F4 (rute probe didaftarkan pada server yang diikat pertama)                                                                                                                                                                       | R2 (shim health mandiri) DITOLAK — readiness palsu                                                                           |
| A3  | Cache rencana plugin + snapshot metadata (disk, keyed by config hash)                | `src/plugins/gateway-startup-plugin-loader.ts` (`loadGatewayStartupPluginPlanWithMetadata`); simpan ke `<stateDir>/cache/startup-plugin-plan.json` (hash config + versi fork)                                                     | Invalidasi bila `openclaw.json` / `dist/extensions/` berubah; [HIPOTESIS] pangkas `plugin-config` 6,7 dtk pada boot berulang |
| A4  | Migrasi sesi inkremental (watermark)                                                 | `src/config/sessions/startup-migration.ts` (`runSessionStartupMigration`); watermark (revisi migrasi terakhir) di state sqlite; hanya sesi berubah sejak watermark yang dimigrasi penuh; sisanya `assertExistingDatabaseIdentity` | Watermark ditulis hanya sesudah migrasi penuh berhasil; skema naik → reset → migrasi penuh                                   |
| A5  | Yang dipertimbangkan dan DITOLAK                                                     | Esbuild penuh, V8 snapshot, Bun single-executable (Bun 1.4 tak punya paritas `node:sqlite`/worker/`Atomics`/modul native/`execve`), zip `dist/`/`node_modules/`                                                                   | Penolakan beralasan, bukan vonis final (Bun: belum ada prototipe)                                                            |

### 2.3 DIHAPUS (D1–D8) — yang boleh dan yang DILARANG

| #   | Yang dihapus                                                                     | Status                                                                                                           |
| --- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| D1  | 5 ekstensi kandidat-buang (`telegram`, `x`, `browser`, `canvas`, `cua-computer`) | **DILARANG** — keputusan pemilik 24 Nov menolak 4.4; menghapusnya membunuh janji pengembalian via `plugins.deny` |
| D2  | Prebuild `.node` non-arm64-linux (darwin/win32/x64)                              | BOLEH — aman, tidak pernah dimuat di linux-arm64                                                                 |
| D3  | `node_modules/npm` (14 MB) + `@esbuild`, `highlight.js`, `clawpdf`               | HANYA sesudah bukti impor (graf impor per paket [BELUM TERUKUR]); `npm` hanya bila F8 menghapus update           |
| D4  | Jalur update (F8) + cek update saat start                                        | BOLEH (via F8)                                                                                                   |
| D5  | `dist/control-ui`                                                                | **DILARANG DIHAPUS** (Opsi 1: Control UI disajikan Gateway)                                                      |
| D6  | `dist/worker-artifacts/*.tar.gz` (34 MB)                                         | JANGAN sebelum diidentifikasi isinya                                                                             |
| D7  | 46 ekstensi "tidak yakin"                                                        | JANGAN hapus borongan                                                                                            |
| D8  | `memory-core` / `active-memory`                                                  | **DILARANG DIHAPUS**                                                                                             |

### 2.4 Perbaikan fase WebUI (dari video perangkat 25 Nov 02:39 WIB)

**Gejala [TERBUKTI perangkat]:** tile READY ~95 dtk; WebUI dibuka ~99 dtk → layar
gelap ~8 dtk → skeleton "Memuat..." sampai akhir video 135 dtk (belum bisa dipakai).
Fase ini TIDAK tertangkap angka LAB (LAB mengukur sampai health, bukan sampai bisa
dipakai).

**Tersangka utama [TERBUKTI source]:** stall 43,5 dtk saat membuka katalog tool
(`dist/tool-catalog-*.mjs`; re-capture di `ensureStandalonePluginToolRegistryLoaded`;
lihat openclaw.md §9.1 F5 + §5.9). Control UI menunggu data katalog sebelum menampilkan
apa pun.

**Perubahan (bagian dari rombak, di belakang A1):**

- **W1. Katalog malas:** endpoint katalog tool tidak lagi memblokir render awal —
  Control UI menampilkan shell + chat segera; katalog dimuat di latar sesudah
  shell tampil (atau dari cache snapshot, lihat W2). Bila katalog gagal/lambat,
  UI tetap bisa dipakai (chat) dengan katalog yang menyusul — fail-open untuk
  tampilan, fail-closed untuk eksekusi tool yang katalognya belum ada.
- **W2. Cache snapshot katalog:** simpan snapshot katalog (`tool-catalog` +
  metadata plugin) ke `<stateDir>/cache/tool-catalog.json` pada boot yang
  berhasil; saat boot berikutnya, UI membaca snapshot dulu (instan), lalu
  memvalidasi/memperbarui di latar bila hash config berubah. Invalidasi sama
  dengan A3.
- **W3. Bundle awal ringan:** audit apa yang dimuat Control UI pada pemuatan
  pertama (chunk awal) — bila ada impor berat yang tidak dibutuhkan untuk
  menampilkan chat pertama, pindahkan ke impor dinamis. (Ukur dulu; jangan
  tebak.)

**Yang TIDAK boleh:** menghapus Control UI (D5/N1); memalsukan katalog (menampilkan
tool yang tidak ada); melewati `plugins.deny` di katalog (N7).

## 3. Yang TIDAK BOLEH diubah/dihapus (N1–N10) — guardrail

| #   | Yang dipertahankan                                                                                                                                                     | Mengapa                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| N1  | Auth Gateway + Control UI: `gateway.auth` (token/password), `OPENCLAW_GATEWAY_TOKEN`, device-identity + origin check, token sebagai fragment `#token=`                 | Menghapus = siapa pun yang mencapai 18789/18790 punya akses penuh ke agen + riwayat chat (D-05)                       |
| N2  | Bind eksklusif TCP 18789                                                                                                                                               | Penjaga terakhir single-owner bila F2 melemahkan lock file/sqlite; bind gagal = start gagal                           |
| N3  | State dir + integritas SQLite (`OPENCLAW_STATE_DIR`, `state/openclaw.sqlite`, agent DB, `state-snapshot`, migrasi skema)                                               | Karantina-bukan-hapus adalah kebijakan Polones; fork yang menghapus state saat boot = kehilangan riwayat + sesi       |
| N4  | Invarian lock: "pemilik yang tak terverifikasi tidak pernah direklamasi otomatis" — kecuali mode `OPENCLAW_MOBILE_SINGLE_OWNER=1` + jaminan eksklusivitas Polones + N2 | Relaksasi tanpa jaminan eksternal = dua Gateway menulis sqlite bersamaan = korupsi state                              |
| N5  | Validasi config + gerbang `gateway.mode=local` + exit 78 atas config invalid                                                                                           | Fail-closed mencegah restart-loop; Polones mengandalkan exit 78 untuk karantina + retry sekali                        |
| N6  | Migrasi sesi (F1): ditunda boleh, dilewati TIDAK BOLEH                                                                                                                 | `assertExistingDatabaseIdentity` + validasi kanonik melindungi dari sesi basi/hilang; RPC agen harus menunggu migrasi |
| N7  | Semantik `plugins.deny` / allow-list (deny mengalahkan segalanya)                                                                                                      | Lazy load (F5) + cache (A3/W2) harus tetap menghormatinya                                                             |
| N8  | Lantai runtime Node (24.22.1+/26.12.1+, `node:sqlite`) + `NODE_COMPILE_CACHE`                                                                                          | `openclaw.mjs` menolak runtime lain; fork yang menurunkan lantai = boot gagal di rootfs Polones (Node 24.22.3)        |
| N9  | Sinyal readiness yang jujur: `/health` = live, `/ready` = ready, `h.mark("ready")` sesudah post-attach                                                                 | Mengubah arti `/health` menjadi "ready" (atau menjawabnya dari shim) memalsukan status dan menutupi crash-loop        |
| N10 | Perilaku default = upstream bila env fork tidak disetel (A1 OFF)                                                                                                       | Satu-satunya cara rebase tetap teruji: test upstream berjalan atas fork dengan saklar OFF                             |

> **Aturan berhenti:** bila desain/implementasi membuktikan salah satu N1–N10 HARUS
> berubah, atau desain menabrak Opsi A (Gateway pemilik tunggal), **BERHENTI dan
> laporkan ke Lead**. Jangan putuskan sendiri.

## 4. Urutan implementasi

1. **F9** (instrumentasi) + ukur ulang baseline LAB → vonis celah 83 dtk (dan
   celah ~150 dtk). **Prasyarat semua F lain.**
2. **A1** (saklar) + **F1** (defer admission) + **F2** (lock fast-path) — dua tuas
   terbesar + teraman; ukur LAB.
3. **F5** (capture async + lazy plugin) + **W1/W2** (katalog malas + cache) —
   "terasa siap" + fase WebUI.
4. **A3 + A4** (cache rencana + migrasi inkremental) — boot berulang.
5. **F4** (early-listen / proses depan tipis) — sesudah F9 membuktikan titik
   pisah graf; upaya terbesar, terakhir di antara yang besar. (Dalam rombak ini
   F4 tetap dalam cakupan atas perintah pemilik — bukan opsional — tetapi
   urutannya sesudah F9.)
6. **F3/F6/F8** — kecil, kapan saja; **F7** jangan dikerjakan; **D2** (prebuild
   non-arm64) kapan saja; D3 hanya sesudah bukti impor.

## 5. Cara mengukur (LAB) — definisi yang dipakai

- **Definisi A (waktu-ke-probe):** spawn → `GET /health` pertama 200. (Yang
  diukur Polones.)
- **Definisi B (Buka → bisa dipakai):** spawn → Control UI shell tampil +
  chat pertama bisa dikirim (katalog boleh menyusul). (Yang dirasakan pengguna;
  diukur dengan skrip ukur + WebView/lab — lihat `docs/mobile-fast-boot/VERIFY.md`.)
- **Baseline:** ukur upstream 2026.11.6 murni di VM yang sama (x86_64, Node
  24.22.1, PRoot+QEMU) SEBELUM membandingkan fork — angka LAB bukan angka
  perangkat. Semua angka dilabeli [LAB].
- **Yang tidak boleh diklaim:** angka perangkat sebelum ronde perangkat
  (S1/S2/S3 + `startup-phases.log`). Perangkat v0.1.120 (video): A ~95 dtk,
  B >135 dtk — itu baseline perangkat S1, bukan hasil fork.

## 6. Beban maintenance (jujur)

- Rebase tiap rilis CalVer upstream (cepat) + rebuild Rollup arm64 + `npm
  install` ulang (dependensi transitif live — hash aset tidak stabil antar
  rebuild) + re-pin + smoke boot arm64 sampai `/health` 200 + suite kontrak
  Polones + test fork sendiri (F1 gerbang RPC, F2 dua-Gateway, F5 fail-closed
  per plugin). Estimasi: **0,5–1 hari kerja per rilis upstream** untuk rebase
  ringan (sentuhan fork kecil, terlokalisasi di belakang A1), lebih bila
  upstream menyentuh berkas yang sama (`gateway-prewarm`, `gateway-lock`,
  `startup-migration` adalah berkas yang aktif berubah).
- Fork yang tertinggal dua rilis lebih berbahaya daripada upstream murni
  (kehilangan fix keamanan + perbaikan #160959). Pemilik fork harus jelas.
- Panduan rebase lengkap untuk AI agent ada di
  `docs/mobile-fast-boot/REBASE-GUIDE.md` (ditulis terpisah; wajib dibaca
  sebelum rebase apa pun).

## 7. Referensi

- Formulasi lengkap: `~/workspace/research-start/per-harness/openclaw.md` §9
  (F1–F9, A1–A5, D1–D8, N1–N10, §9.6, §10) + §5.5 (lock) + §5.7 (admission)
  - §5.8 (listen/ready) + §5.9 (plugin post-bind) + §5.10 (celah).
- Laporan utama: `~/workspace/research-start/RIS-START-OPENC0DE-VS-LAINNYA.md`.
- Angka LAB: `docs/guides/openclaw-slow-start.md` (Polones).
- Bukti perangkat: video 25 Nov 2026 02:39 WIB (v0.1.120, Xiaomi 12).

## 8. Status implementasi (diperbarui per lane)

| Perubahan            | Status                           | Keterangan                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1                   | ✅ SELESAI                       | Saklar `OPENCLAW_MOBILE_BOOT=1` — `src/gateway/mobile-boot.ts` + plumbing titik masuk (`run.ts`, `run-loop.ts`, `run-loop-startup.ts`, `server.ts`, `server-public.ts`, `server-startup-bootstrap.ts`). OFF = upstream murni; ON di Lane A tanpa perubahan perilaku (hanya baca + log). Smoke ON lolos (MEASUREMENT.md §5). Threading penuh ke lock/admission/plugin loader diserahkan ke Lane B/C/D                                                  |
| F9                   | ✅ SELESAI                       | Instrumentasi celah + baseline ulang — 15+ nama fase baru, 285 fase terukur, baseline 2× OFF + 1× ON (MEASUREMENT.md §4–§5). Vonis: tidak ada celah ~150 dtk di LAB native; titik pisah F4 ADA di `http.bound`                                                                                                                                                                                                                                        |
| F1                   | ⏳ BELUM                         | Defer admission + gerbang RPC                                                                                                                                                                                                                                                                                                                                                                                                                         |
| F2                   | ✅ SELESAI (Lane C, 25 Nov 2026) | Fast-path lock — `OPENCLAW_MOBILE_SINGLE_OWNER=1` (hanya bila A1 ON): lewati proyeksi file-lock + asersi lease, deadline contention 300→30 dtk, `isPidDefinitelyDead` cukup untuk reklamasi namespace `"unknown"`. Bind eksklusif 18789 (N2) dipertahankan. Test: single-owner 5/5 + regresi lock 163 + mobile-boot 24/24; typecheck tsgo core + gateway-root + infra + agents-root + agents-other lolos; oxlint 0 error. Ukur LAB: MEASUREMENT.md §7 |
| F3                   | ⏳ BELUM                         | Pecah bootstrap                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| F4                   | ✅ LAYAK (vonis F9)              | Early-listen / proses depan tipis — titik pisah terbukti di `http.bound` (~26 dtk [LAB]); kemenangan LAB native ~13 dtk post-attach                                                                                                                                                                                                                                                                                                                   |
| F5                   | ⏳ BELUM                         | Capture async + lazy plugin                                                                                                                                                                                                                                                                                                                                                                                                                           |
| F6                   | ⏳ BELUM                         | Code-split entry                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| F8                   | ⏳ BELUM                         | Matikan update-admission                                                                                                                                                                                                                                                                                                                                                                                                                              |
| A3                   | ⏳ BELUM                         | Cache rencana plugin                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| A4                   | ⏳ BELUM                         | Migrasi inkremental                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| W1/W2/W3             | ⏳ BELUM                         | Katalog malas + cache + bundle ringan                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D2                   | ⏳ BELUM                         | Hapus prebuild `.node` non-arm64                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Lane H (dokumentasi) | ✅ SELESAI (25 Nov 2026)         | `docs/mobile-fast-boot/REBASE-GUIDE.md`, `BUILD-PUBLISH.md`, `GUARDRAILS.md`, `VERIFY.md` — ditulis Lane H, basis v2026.11.6, tanpa perubahan kode. Butir [BELUM TERUKUR] di tiap dokumen menunggu Lane A/G + ronde perangkat (lihat VERIFY.md §5).                                                                                                                                                                                                   |
