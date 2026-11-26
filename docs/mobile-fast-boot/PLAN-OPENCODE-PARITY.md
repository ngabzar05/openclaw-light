# RENCANA — OpenClaw setara OpenCode (OpenCode Parity): dari ~2 menit ke ~3 detik

> **Status:** RENCANA (belum diimplementasikan — dokumen ini hanya rencana + investigasi).
> **Basis:** fork `ngabzar05/openclaw-light`, `main` = `b741e515` (merge F4 `5c911ea6` + fix duplikat mobileBoot), dari upstream `openclaw/openclaw` @ tag `v2026.11.6`.
> **Perintah pemilik:** 26 Nov 2026 07:31 WIB — user melaporkan v0.1.124 masih ~2 menit di perangkat dan memerintahkan planning dulu untuk perombakan besar (arsitektur, logika, infrastruktur, sebesar apa pun) agar OpenClaw start secepat OpenCode (~3 detik). Implementasi HANYA sesudah rencana ini disetujui.
> **Batas arsitektur:** PERTAHANKAN Opsi A — Gateway pemilik tunggal, WebUI dipertahankan (keputusan pemilik 24 Nov 2026). Jangan ubah model kepemilikan.
> **Target:** definisi B (Buka → bisa dipakai) ~3 detik sebagai *pengalaman*; definisi A (READY) sedekat mungkin. Baca §0.3 dulu — "3 detik" yang jujur bukan cold-boot penuh, melainkan kombinasi proses depan tipis + prestart/warm-run (lihat §4 Fase 1–2 dan §9).

## 0. Ringkasan eksekutif

### 0.1 Diagnosis singkat

v0.1.124 masih ~2 menit di perangkat karena **dua sebab yang bertumpuk**:

1. **Saklar fast-boot tidak pernah dinyalakan (penyebab utama, terverifikasi).** Aset fast-boot fork ADA di APK (`38c12305…`, 19 chunk `mobileBoot`, flag `OPENCLAW_MOBILE_BOOT`), tetapi Polones tidak pernah menyetel `OPENCLAW_MOBILE_BOOT=1` di env gateway. Grep di source Polones hanya menemukan penyebutan di `docs/plan/STATUS.md` (dokumentasi) — tidak ada di kode yang meluncurkan OpenClaw. Fork menegaskan default OFF dan env var itu "the single switch" (`src/gateway/mobile-boot.ts:3`). Jadi fast-boot DORMANT: kode ada, tidak aktif. Perangkat: Memulai 07:28:34 → Berjalan 07:30:14 (~100 dtk), praktis sama dengan v0.1.120 (READY ~95 dtk, Buka→bisa dipakai >135 dtk).
2. **Batas desain fork saat ini (penyebab kedua, terverifikasi dari source).** Bahkan dengan saklar ON, fork TIDAK akan memberi 3 detik. F4 yang diimplementasikan BUKAN proses depan tipis seperti yang dijanjikan `DESIGN.md` §1.2 ("ikat socket dulu dalam ~1–2 dtk") — F4 yang masuk (commit `d8407b989`) hanya lazy-import 9 modul + tunda join early-runtime; seluruh rantai pra-listen upstream tetap berjalan sebelum `http.listen`. Perkiraan realistis dengan saklar ON (dari struktur kode, BUKAN hasil ukur — karena angka boot LAB terintegrasi ON vs OFF belum pernah ada): definisi A ~60–90 dtk, definisi B ~70–120 dtk. Itu perbaikan besar, bukan transformasi ke kecepatan OpenCode.

### 0.2 Tiga temuan yang mengubah rencana

- **"3 detik vs 95 detik" membandingkan dua milestone yang berbeda.** Probe OpenCode mengukur "Bun hidup + socket terikat + shell tersaji" (`GET /` dijawab tanpa cek ready; `/api/info` masih 503 saat itu). Probe OpenClaw mengukur liveness *sesudah* config + sqlite + recovery + migrasi sesi + admission — titik yang jauh lebih akhir. OpenCode full-ready sendiri belum pernah terukur di perangkat. Dan "Bun vs Node" sebagai penjelasan utama DITOLAK riset (impor `run-main.js` OpenClaw hanya ~0,4 dtk di LAB; DSH Node 8,3 dtk dan Hermes Python ~1,5 dtk membuktikan runtime saja tidak menentukan orde detik).
- **Pengali perangkat ~3,7× tidak disentuh fork.** Perangkat ~95 dtk vs LAB native ~22–26 dtk. Penyebabnya volume I/O (aset 519 MB / 32.354 berkas; `dist/` 281 MB / 17.464 berkas; `node_modules/` 237 MB) dikali overhead syscall Groot + eMMC + page-in. Fork tidak memangkas volume I/O secara orde-besaran.
- **Manfaat fast-boot terintegrasi (ON vs OFF) belum pernah terukur.** Build `dist/` terintegrasi tidak pernah berhasil di VM ini (butuh heap ≥4,4 GB; waiter timeout sesudah 345 cek). Hanya F2 yang punya angka boot LAB (bersih ON ≈ OFF; kotor ON menyelamatkan boot yang OFF-nya gagal). Semua lane lain hanya punya bukti test unit, bukan angka boot. Jadi langkah pertama sesudah menyalakan saklar WAJIB ukur, bukan klaim.

### 0.3 Apa arti "3 detik" yang jujur — baca sebelum menyetujui rencana

Kontrak gateway OpenClaw (config valid → state sqlite → recovery → migrasi sesi → model runtime → plugin registry → Control UI) **tidak bisa diselesaikan dalam 3 detik di ponsel**, bahkan sesudah semua penundaan — lantainya puluhan detik untuk *full-ready*. Yang bisa dicapai:

| Keadaan | Yang dirasakan user | Target rencana ini |
|---|---|---|
| **Cold start** (gateway belum jalan) | Shell tampil ~3–5 dtk (bisa lihat + bisa mengetik; kirim menunggu ready), chat pertama bisa dikirim ~40–60 dtk | Fase 1 (proses depan tipis) + Fase 3–5 |
| **Warm start** (gateway sudah hidup via prestart) | Shell + chat pertama ~2–5 dtk — **inilah pengalaman OpenCode** | Fase 2 (prestart/warm-run/reattach) + Fase 1 |

Jadi "secepat OpenCode (~3 detik)" dicapai sebagai **pengalaman** melalui kombinasi (a) proses depan tipis yang menyajikan shell dalam hitungan detik saat cold, dan (b) prestart/warm-run sehingga gateway sudah siap saat user mengetuk. Rencana ini TIDAK menjanjikan cold-boot penuh 3 detik — itu tidak mungkin secara fisik untuk kontrak gateway ini, dan siapa pun yang menjanjikannya sedang memalsukan readiness (lihat §5 N9 dan §6).

### 0.4 Peta rencana

| Fase | Isi | Sifat | Dampak utama |
|---|---|---|---|
| **Fase 0** | Nyalakan `OPENCLAW_MOBILE_BOOT=1` di Polones (1 baris Rust + cermin Kotlin + test) | Quick win, Polones | A ~95 → ~70–85 dtk; B >135 → ~85–110 dtk (perkiraan, belum terukur) |
| **Fase 1** | Proses depan tipis yang sesungguhnya — ikat socket + sajikan shell dulu, graf-sisa sesudah `http.bound` | Fork, arsitektur, risiko TINGGI | A (socket) → ~5–15 dtk; B (shell) → ~10–20 dtk cold |
| **Fase 2** | Prestart / warm-run / reattach (Polones) | Polones, satu-satunya jalan ke "terasa ~3 dtk" | B (warm) → ~2–5 dtk |
| **Fase 3** | Kurangi volume I/O perangkat (bundle, prune, cache inventaris berkas) | Fork + build Polones | A (cold) berpotensi ~60–70 dtk; menyerang pengali ~3,7× |
| **Fase 4** | Selesaikan F5 (F5b cache capture) + tunda init model runtime ke chat pertama | Fork | `/ready` LAB ~42 → ~30 dtk; B cold membaik sefraksi |
| **Fase 5** | Admission + migrasi sesi lanjutan (hidrasi malas sesi) | Fork | Boot berulang + perangkat bersesi banyak membaik |
| **Fase 6** | Pengukuran + hardening (LAB terintegrasi, ronde perangkat, tutup utang F4) | Fork + Polones | Prasyarat klaim apa pun; tanpa ini semua angka di atas tetap perkiraan |

Urutan eksekusi dan dependensi: lihat §8. Keputusan yang butuh pemilik: lihat §10.

## 1. Diagnosis (akar masalah — bukti dari source, bukan klaim)

### 1.1 Saklar OFF — fast-boot dormant di perangkat (penyebab utama v0.1.124)

**Bukti:**

- Grep `OPENCLAW_MOBILE_BOOT` di `~/workspace/polones` (`.kt`/`.mjs`/`.js`/`.md`/`.rs`) hanya menemukan **satu** hit: `docs/plan/STATUS.md` baris 14 (dokumentasi). Tidak ada di kode Kotlin/Rust yang meluncurkan OpenClaw.
- Fork `src/gateway/mobile-boot.ts:3`: "`OPENCLAW_MOBILE_BOOT=1` enables the fork's fast-boot profile. Default OFF means pure upstream behavior (guardrail N10)". Test fork menegaskan itu "the single switch" (`mobile-boot.test.ts:79-80`).
- Jalur peluncuran produksi (terverifikasi dari source): Rust `plans.rs` → `openclaw_gateway_extras()` membangun env plan; daemon `polonesd` `supervisor::process::spawn` melakukan `env_clear()` lalu hanya memasang env dari plan; proxy `scripts/mobile-patch/child.mjs` `gatewayEnv()` meneruskan env ke gateway. Karena `OPENCLAW_MOBILE_BOOT` tidak ada di plan, ia tidak pernah sampai ke proses gateway. (Detail lengkap jalur + titik penyisipan: §3.)
- Bukti perangkat (screenshot Aktivitas user, v0.1.124, 26 Nov 07:31 WIB): OpenClaw `Memulai` 07:28:34 → `Berjalan` 07:30:14 (~100 dtk). Baseline v0.1.120: READY ~95 dtk, Buka→bisa dipakai >135 dtk. v0.1.124 praktis identik dengan v0.1.120 — konsisten dengan fork yang dormant.

**Mode gagal diam-diam (penting untuk verifikasi):** bila aset yang terpasang ternyata upstream murni (bukan fork), env `OPENCLAW_MOBILE_BOOT=1` diabaikan tanpa error. Sebaliknya, env yang salah eja juga gagal diam-diam. Jadi verifikasi Fase 0 HARUS berupa pengukuran waktu start di perangkat + baris log `mobile boot profile enabled` di `gateway.log`, BUKAN sekadar "tidak ada error" (lihat §3.4 dan §7).

### 1.2 F4 yang diimplementasikan bukan proses depan tipis (batas desain fork)

**Yang dijanjikan desain** (`DESIGN.md` §1.2): "Ikat socket dulu (proses depan tipis): HTTP server + rute probe `/health`/`/ready` + auth gate + state-owner diikat dalam ~1–2 detik; graf-sisa diimpor dinamis sesudah `http.bound`. Ini F4 — tuas struktural terbesar."

**Yang benar-benar masuk** (commit `d8407b989`, merge `5c911ea6`, diverifikasi dari source + `F4-AUDIT.md` §1, §6):

- (a) 9 impor statis di `server-startup-finish.ts` menjadi impor dinamis di titik pakai pasca-bind/pasca-ready (modul diverifikasi bebas efek samping top-level).
- (b) Join early-runtime ditunda ke sesudah `/ready` terbit (mark `runtime.early.deferred`; late join + re-refresh discovery).

**Yang TIDAK ada:** proses depan tipis; pemisahan graf-listen vs graf-sisa; entry yang mengikat socket sebelum bootstrap. Seluruh rantai pra-listen upstream tetap berjalan sebelum `http.listen`. Titik pisah graf ADA di `http.bound` (~26 dtk [LAB]) — tetapi F4 yang diimplementasikan tidak memakainya sebagai titik pisah proses depan.

**Konsekuensi:** `/health` tetap baru menjawab sesudah seluruh rantai impor + bootstrap + kernel + request-runtime selesai. Tidak ada mekanisme di fork yang bisa membawa A ke hitungan detik. Perkiraan realistis dengan saklar ON (dari struktur kode + skala LAB→perangkat, rentang lebar, BUKAN hasil ukur): **A ~60–90 dtk (kemungkinan 70–85 dtk); B ~70–120 dtk (kemungkinan 85–110 dtk)**. Pengurang terbesar B adalah W1/W2 yang menghilangkan stall katalog 43,5 dtk dari jalur B. Target desain "definisi B hitungan detik" (`DESIGN.md` §0) tidak tercapai secara struktural dengan implementasi saat ini.

**Catatan dokumentasi basi:** `DESIGN.md` §8 dan `FORK-LAPORAN.md` §4.1 masih menulis F4 "terblokir/belum merge" — itu sudah basi; F4 sudah merge di `b741e515`. Perbaiki sebagai bagian Fase 0 (lihat §3.5). Merge `5c911ea6` juga mencatat test gate 2/2 dilewati atas perintah pemilik ("OFF fails on test race, fix pending run 4") — perbaikan test F4 (hanya-test, di worktree `~/workspace/openclaw-fork-lanes/lane-g`) masih belum commit; tutup di Fase 6.

### 1.3 Probe yang tidak sebanding — "3 detik vs 95 detik"

Terverifikasi langsung dari source Polones dan OpenCode (laporan riset `RIS-START-OPENC0DE-VS-LAINNYA.md`):

- **OpenCode:** `health_path: "/"` (`spec_table.rs:214-221`); `GET /` dijawab shell SPA embedded **tanpa cek ready**. Sementara `GET /api/info` menjawab **503 while-starting** sampai ready. Jadi probe OpenCode mengukur **"Bun hidup + socket terikat + shell tersaji"** — sebelum `createRoutes`/migrasi DB selesai. Urutan boot OpenCode: `listen()` dulu (bind 4096) → `serve()` (HTTP melayani) → baru `boot` (routes + migrasi SQLite).
- **OpenClaw:** probe `GET /health` 18789; `/health` = `"live"`, `/ready` = `"ready"`; `mark("ready")` baru sesudah post-attach. Jadi probe OpenClaw mengukur **liveness sesudah** config + sqlite + recovery + migrasi sesi + admission — titik yang jauh lebih akhir.
- **Kesimpulan:** "3 detik" vs "95 detik" membandingkan dua milestone yang berbeda. Perbandingan yang jujur membutuhkan OpenCode full-ready (baris `server listening`, sesudah layer+DB) — **belum terukur di perangkat**. Koreksi kedua: angka "~3 detik" OpenCode sendiri adalah **observasi user, bukan hasil ukur bermetodologi** (RIS §1.2, §3.3); angka 6,2 dtk v0.1.94 sumber primernya tidak ditemukan.
- **"Bun vs Node" DITOLAK sebagai penjelasan utama** (RIS §3.2 Faktor 3): impor `run-main.js` OpenClaw hanya 433/414 ms [LAB]; DSH (Node) 8,3 dtk dan Hermes (Python) ~1,5 dtk [LAB] membuktikan runtime saja tidak menentukan orde detik.

**Implikasi untuk rencana:** menyamakan OpenClaw dengan OpenCode berarti menyamakan *milestone yang diukur* (bind + shell) DAN *perilaku* (defer segalanya). Fase 1 melakukan yang pertama di sisi fork; §7 mendefinisikan ulang metrik agar perbandingan selanjutnya jujur.

### 1.4 Pengali perangkat ~3,7× — volume I/O yang tidak disentuh fork

Dua set angka LAB — jangan dicampur:

| Fase | PRoot+QEMU [LAB] (riset lama) | Native x86_64 [LAB] (Lane A, run2-off) |
|---|---|---|
| Impor graf modul utama | ~30 dtk | (termasuk dalam `http.bound` 26,0 dtk) |
| `gateway-run-bootstrap` | 58,6 dtk | 6,9 dtk |
| `gateway-lock` | 18,0 dtk bersih; worst-case 300 dtk | 1,6 dtk |
| `gateway.server-start-import` | 22,1 dtk | 1,9 dtk |
| `sessions.admission` | 27,2 dtk | 1,6 dtk |
| **Celah tanpa fase** | **~150 dtk (~49%)** | jauh lebih kecil (total ke health hanya 21,8–26,1 dtk) |
| `plugins.runtime-post-bind` (sesudah health) | 67,7 dtk | 9,7 dtk |
| **Total ke `/health` 200 pertama** | **283–330 dtk** | **21,8 / 26,1 dtk** |
| `/ready` 200 pertama | — | **43,5 / 42,4 dtk** |

**Vonis F9 (`MEASUREMENT.md` §4.3): di LAB native TIDAK ada celah ~150 dtk tanpa fase.** Wilayah itu terurai menjadi fase-fase ~1–2 dtk + inflasi emulasi PRoot/QEMU + stall katalog WebUI. Celah ~150 dtk dan total 283–330 dtk sebagian besar adalah **inflasi emulasi QEMU + pajak ptrace/PRoot**, bukan kerja upstream murni. Perangkat v0.1.120 ~95 dtk vs native LAB ~22–26 dtk → **pengali perangkat-vs-LAB-native ~3,7×** (overhead syscall Groot + eMMC + page-in). Semua kontribusi fork yang dihitung dari angka PRoot+QEMU harus diskalakan ulang — mis. F1 "27,2 dtk" itu 1,6 dtk di native LAB.

**Volume I/O (tidak disentuh fork):** aset OpenClaw 519 MB / 32.354 berkas; `dist/` 281 MB / 17.464 berkas; `node_modules/` 237 MB; `control-ui` 63 MB; 76 ekstensi. D2/F6 hanya memangkas satuan detik. Tidak ada lane yang memangkas volume I/O secara orde-besaran. Ini menjelaskan mengapa native LAB 22–26 dtk menjadi ~95 dtk di perangkat — dan mengapa Fase 3 (kurangi volume I/O) diperlukan untuk menyerang pengali itu (lihat §4 Fase 3).

### 1.5 Manfaat terintegrasi belum pernah terukur

- Build `dist/` terintegrasi tidak pernah berhasil di VM ini (butuh heap ≥4,4 GB; waiter timeout sesudah 345 cek / ~5 jam 45 mnt polling, MemAvailable maks 1,8 GB vs kebutuhan ≥5.500 MB). Ukur LAB terintegrasi butuh mesin/CI ber-heap ≥4,4 GB.
- Satu-satunya angka boot LAB per lane: **F2** (bersih ON ≈ OFF dalam noise; kotor OFF exit 1 @ 104,6 dtk tanpa `/health`, ON `/health` 200 @ 21,4/22,9 dtk = boot bersih, hemat ~82 dtk). Lane B/D/E/F/G hanya punya bukti test unit/integrasi, bukan angka boot.
- **Fork belum pernah diukur end-to-end (ON vs OFF) sama sekali** — semua angka lane bersifat parsial. Vonis perangkat dengan saklar ON (S1/S2/S3 + `startup-phases.log`) juga belum ada.
- **Konsekuensi untuk rencana:** setiap klaim dampak di dokumen ini diberi label perkiraan + dasarnya, dan Fase 6 (pengukuran) adalah prasyarat klaim apa pun — bukan pelengkap.

## 2. openclaw-light vs upstream — apa yang diubah fork (untuk jawaban user)

### 2.1 Yang diubah fork (lane per lane)

Semua perubahan di belakang saklar tunggal `OPENCLAW_MOBILE_BOOT=1` (A1), default OFF. Basis: upstream `v2026.11.6`.

| Lane | Perubahan | Berkas/fungsi utama (fork `src/`) | Status |
|---|---|---|---|
| **A1** | Profil boot mobile — saklar tunggal semua F | `src/gateway/mobile-boot.ts` (145 baris): `resolveMobileBootOptions()` satu-satunya tempat baca env; `OPENCLAW_MOBILE_BOOT=1` → `enabled:true`; `OPENCLAW_MOBILE_SINGLE_OWNER=1` hanya berpengaruh bila A1 juga ON. Nilai di-resolve sekali per proses (`src/cli/gateway-cli/run.ts:378`, fallback `src/gateway/server.ts:81`), di-thread sebagai `MobileBootOptions` | ✅ Selesai (Lane A) |
| **F9** | Instrumentasi celah tanpa fase | `measureGatewayBootstrapStep` / `createGatewayDispatchStartupTrace` (`startup-trace`), `STARTUP_PROGRESS_PHASES` (`server-startup-trace`); 15+ nama fase baru, 285 fase terukur | ✅ Selesai (Lane A) |
| **F1** | Tunda `sessions.admission` sampai sesudah HTTP listen; gerbang RPC menahan `chat.send`/`agent` sampai migrasi selesai | `server-startup-bootstrap.ts:502` (slot admission jadi placeholder kosong bila deferred); migrasi nyata dimulai `server-startup-finish.ts:212-236` tepat sesudah `http.bound`, paralel dengan `runtime.post-attach`; `/ready` baru diterbit sesudah `await deferredSessionMigration.ready` (`server-startup-finish.ts:538-541`) | ✅ Selesai (Lane B, `38937a07`) |
| **A4** | Migrasi sesi inkremental (watermark) | `src/config/sessions/startup-migration.ts:317-336, 366-373, 507-515` — hanya sesi berubah sejak watermark yang dimigrasi penuh; watermark ditulis hanya sesudah migrasi penuh sukses; skema naik → reset → migrasi penuh | ✅ Selesai (Lane B) |
| **F2** | Fast-path gateway-lock single-owner mobile | `src/infra/gateway-lock.ts:116` (`MOBILE_SINGLE_OWNER_LOCK_TIMEOUT_MS = 30_000` vs upstream 300 dtk); bila `singleOwner`: lewati proyeksi file-lock + asersi lease, `isPidDefinitelyDead` cukup untuk reklamasi namespace `"unknown"`. Env kedua: `OPENCLAW_MOBILE_SINGLE_OWNER=1` | ✅ Selesai (Lane C, `bbef1646`) |
| **F3** | Pecah `gateway-run-bootstrap` — tunda sub-langkah pasca-listen | Preflight snapshot core-only bila ON (`includePluginMetadata:false`, `skipPluginValidation:true`); penegakan plugin-invalid pindah ke `run.ts:490-499` (tetap pra-listen, tetap exit 78); impor runtime database/session jadi lazy; state-snapshot scope jadi lazy | ✅ Selesai (Lane F) |
| **F4** | Early-listen — **versi yang diimplementasikan: lazy-import + tunda join** (BUKAN proses depan tipis; lihat §1.2) | 9 modul di `server-startup-finish.ts:13-22` jadi impor dinamis di titik pakai pasca-bind/pasca-ready; `earlyRuntimeReady` tidak lagi di-join sebelum post-attach bila ON (`server-startup-finish.ts:261-275`, mark `runtime.early.deferred`); late join + re-refresh discovery sesudah `/ready` | ✅ Kode selesai + merge (Lane G, `d8407b989`, merge `5c911ea6`); ukur LAB belum ada |
| **F5** | Plugin capture async + lazy plugin runtime | `server-startup-plugins.ts:585-604`: bila ON, rencana startup dibagi **essential** (dimuat sebelum `/ready`: pemilik provider terkonfigurasi + memory-slot & context-engine-slot + pemilik channel & harness runtime) dan **deferred** (latar sesudah `/ready`, fire-and-forget, gagal tidak menggagalkan startup — `server-startup-post-attach.ts:464-507`). Fail-closed: plugin tak terklasifikasi tetap essential. Impor `plugins/runtime.js` yang eager dijadikan lazy bila ON | ✅ Selesai (Lane D, `fddd35a9`); **F5b (cache artefak capture antar-boot) SENGAJA tidak diimplementasikan** (butuh design review) |
| **A3** | Cache rencana plugin + snapshot metadata (disk, keyed by config hash) | `src/plugins/gateway-startup-plugin-loader.ts:40`; simpan ke `<stateDir>/cache/startup-plugin-plan.json` (hash config + versi fork). Hemat LAB hanya ~8–30 ms | ✅ Selesai (Lane D) |
| **F6** | Code-split entry: `gateway run` tidak mengimpor pohon CLI | Entry gateway baru `src/entry-gateway.ts` (282 baris) + routing `openclaw.mjs` (gated A1; OFF tetap `entry.js`); prewarm paralel `server-start.js` | ✅ Selesai (Lane F) |
| **F8** | Matikan update-admission + update check di dalam fork | Entry gateway tanpa update-admission; `runCli` menolak `update admit`/`preflight` bila ON (exit 2); cek update pasca-attach di-skip bila ON (`server-startup-post-attach.ts:566-580`) | ✅ Selesai (Lane F) |
| **W1** | Katalog malas (WebUI) | `src/gateway/server-methods/tools-catalog.ts`: bila ON dan tanpa snapshot, jawab grup inti saja + `pluginCatalogPending:true`, rebuild di latar (dikoalescing). UI (`ui/src/pages/agents/tools.ts`) menampilkan grup inti + retry latar 2 dtk maks 10×; tidak pernah kembali ke skeleton. **Input chat tidak pernah digerbangi katalog** (composer memakai `tools.effective`, bukan `tools.catalog`) | ✅ Selesai (Lane E, `08af5d9d`) |
| **W2** | Cache snapshot katalog | `src/gateway/tool-catalog-snapshot.ts`: snapshot `<stateDir>/cache/tool-catalog-<sha16>.json`, kunci = hash config (termasuk `plugins.deny`) + versi registry + versi build + agentId + fingerprint `extensions/`. Tulis atomik, prune >7 hari, best-effort (rusak → null, bukan error) | ✅ Selesai (Lane E) |
| **W3** | Bundle awal ringan | Audit: **vonis negatif — tidak ada impor berat yang dipindah.** Chunk awal ~5,06–5,18 MB adalah kode chat itu sendiri + runtime first paint; mermaid/ghostty/video-worker/locale sudah malas; panel Tools sudah route-split. **W3 = 0 dtk** | ✅ Selesai (Lane E, vonis negatif) |
| **D2** | Hapus prebuild `.node` non-arm64 | Skrip `scripts/mobile-fast-boot/prune-non-arm64-prebuilds.mjs`; 41 target / 1365,4 MiB di pohon install, **~60,4 MiB relevan APK**. Efek boot ~0 dtk; hanya ukuran | ✅ Selesai (Lane F) |

### 2.2 Yang TIDAK diubah fork

- **Default OFF = upstream murni** (N10): tanpa `OPENCLAW_MOBILE_BOOT=1`, tidak ada perilaku fork yang jalan — kecuali satu penyimpangan yang dicatat sendiri Lane G: impor malas F4(a) berlaku di kedua mode (perbedaan pengukuran, bukan perilaku; `F4-AUDIT.md` §2.5 butir 1).
- **Opsi A dipertahankan** — Gateway pemilik tunggal, WebUI dipertahankan; tidak ada perubahan model kepemilikan.
- **Arti `/health` dan `/ready` tidak diubah** (N9): `/health` = liveness proses Gateway asli (bukan shim — A2-R2 ditolak), `/ready` = readiness jujur sesudah post-attach + migrasi. Tidak ada readiness palsu.
- **Auth + token tidak disentuh** (N1); **bind eksklusif TCP 18789 dipertahankan** (N2); **integritas state/sqlite tidak disentuh** (N3); **invarian lock** (N4) kecuali mode `singleOwner` + jaminan eksklusivitas Polones + N2; **validasi config + exit 78** (N5); **migrasi sesi tidak pernah dilewati, hanya ditunda** (N6); **semantik `plugins.deny`** (N7); **lantai runtime Node** (N8).
- **Tidak ada ekstensi yang dihapus** (D1/D5/D7/D8 dilarang): 5 ekstensi kandidat-buang, 46 ekstensi "tidak yakin", `memory-core`/`active-memory`, dan `dist/control-ui` semuanya dipertahankan. Yang dihapus hanya prebuild `.node` non-arm64 (D2) dan jalur self-update (F8, update lewat APK).
- **Tidak ada Bun / esbuild penuh / V8 snapshot / zip `dist/`** (A5, ditolak beralasan — lihat §6).
- **Tidak ada patch-`dist`**: semua perubahan di `src/` (+ routing `openclaw.mjs` + `ui/` untuk W1).
- **Perilaku yang hilang bila ON:** `openclaw update` / update-admission dari dalam fork (sengaja, update lewat APK); dan bila `singleOwner` ikut dinyalakan, perlindungan lock file/lease melemah (hanya aman di bawah jaminan eksklusivitas Polones + bind 18789).

### 2.3 Koreksi atas gambaran desain (penting — jangan ulangi klaim lama)

- `DESIGN.md` §1.2 dan §0 menjanjikan proses depan tipis ("ikat socket dulu dalam ~1–2 dtk"). **Itu tidak diimplementasikan** (lihat §1.2). Rencana ini (Fase 1) adalah pekerjaan F4 yang sesungguhnya — bukan pengulangan klaim desain.
- `DESIGN.md` §8 dan `FORK-LAPORAN.md` §4.1 masih menulis F4 "terblokir/belum merge" — **sudah basi**; F4 sudah merge di `b741e515` (git adalah otoritasnya). Perbaiki di Fase 0.
- Angka "43,5 dtk" muncul dua kali dengan arti berbeda — stall katalog (riset perangkat) dan `/ready` 43,5 dtk run1-off (Lane A LAB). Jangan disamakan; kemungkinan koinsidensi, belum diverifikasi.

## 3. Fase 0 — Quick win: nyalakan `OPENCLAW_MOBILE_BOOT=1` di Polones

**Tujuan:** mengaktifkan seluruh profil fast-boot fork yang sudah ada di APK v0.1.124. Satu baris Rust + cermin Kotlin + test. Tidak ada perubahan fork. Tidak ada perubahan perilaku bila aset yang terpasang ternyata upstream murni (env diabaikan diam-diam — lihat mode gagal di §3.4).

### 3.1 Jalur peluncuran produksi (yang dieksekusi — terverifikasi dari source)

**Koreksi penting:** `OpenClawHarness.kt` **bukan** jalur yang dieksekusi di produksi. Per ADR 0023 (AGENTS.md repo Polones §3), sumber kebenaran spec/plan adalah Rust (`spec_table.rs`/`plans.rs`); `launchPlan` Kotlin hanya cermin yang tidak dieksekusi. Jalur produksi:

1. **Kotlin — permintaan plan.** `GatewayRepository.start` → `EngineHarnessSpec.launchPlan` (`core/runtime/.../EngineHarnessSpec.kt:65-66`): `HarnessEngine.launchPlan(inner.id, ctx, dynamicEnv(), loopbackToken())`. `dynamicEnv()` (baris 77-78) hanya berisi kredensial dari `OpenClawHarness.dynamicEnv()` — `ANTHROPIC_API_KEY` + `OPENCLAW_GATEWAY_TOKEN` dari SecretStore. JSON `{harness_id, ctx, dynamic_env, probe_interval_ms}` dikirim lewat `EngineBridge.call("harness", "launch_plan", …)`.
2. **Rust engine — plan dibangun.** `op_launch_plan` → `build_launch_plan` (`native/crates/engine/src/harness/plans.rs:416`) → `launch_command` (Proxy) + `static_extras` → `openclaw_gateway_extras` (`plans.rs:193`) + `launch_env_base` (`native/crates/engine/src/harness/env.rs:72`, `base()`). Spec OpenClaw di `native/crates/engine/src/harness/spec_table.rs` (~baris 403-430): workdir `/root/openclaw/workspace`, `LaunchCommand::Proxy { front_port: 18790, upstream_command: "openclaw gateway run --allow-unconfigured", token_file: None }`, `health_url http://127.0.0.1:18789/health`, `ready_within_ms` 480.000.
3. **Rust — argv runtime.** `runtime_build` (`native/crates/engine/src/harness/argv.rs:90`) → Groot: `<groot_path> -r <rootfs> -b /dev -b /proc -b /sys … -0 -w /root/openclaw/workspace /bin/sh -c "<command>"`. Perintah dari `mobile_patch::command` (`native/crates/engine/src/harness/mobile_patch.rs:71-94`): `exec node /opt/polones/mobile-patch/boot.mjs --listen-port 18790 --upstream-port 18789 --harness openclaw -- openclaw gateway run --allow-unconfigured`.
4. **Daemon `polonesd` — spawn.** `supervisor::process::spawn` (`native/crates/supervisor/src/process.rs:27-46`): `command.env_clear()` (baris 43) lalu hanya pasangan env dari plan yang dipasang (baris 44-46). **Tidak ada env host Android yang bocor masuk; env harus ada di plan.**
5. **Guest — proxy boot.** `scripts/mobile-patch/boot.mjs:90` memanggil `lifecycle.spawnChild(command)` **sebelum** mengimpor `proxy.mjs`. `spawnChild` (`scripts/mobile-patch/child.mjs:276`) men-spawn gateway dengan `env: gatewayEnv(process.env)`.
6. **Fork — resolve saklar.** `openclaw.mjs:731-734` (launcher JS) membaca `process.env.OPENCLAW_MOBILE_BOOT` (truthy = `true/1/yes/on`, case-insensitive) dan bila foreground gateway run + ON, memakai `dist/entry-gateway.js`; bila OFF/missing, fallback ke `entry.js` upstream. Lalu `src/cli/run-main.ts:173` (`resolveMobileBootOptions(process.env)`, sekali per proses) → `src/cli/gateway-cli/run.ts:378` (resolve sekali di jalur gateway-run, sebelum `clearGatewayRunConfigEnvironment()`) → di-thread ke `startGatewayServer`/`runGatewayLoop` (`run.ts:893,904`).

**Tentang `AppContainer.kt:177`:** itu `sidecarEnvProvider` — env untuk **bridge sidecar TUI** (`openclaw tui`), bukan gateway: token + `NODE_OPTIONS=--max-old-space-size=512`. Bukan jalur env gateway. Jangan taruh saklar di sana (TUI tidak me-resolve mobile-boot; ia hanya connect ke gateway yang sudah jalan).

### 3.2 Perubahan persis

**1. Paling tepat — Rust, sumber kebenaran yang dieksekusi.** `native/crates/engine/src/harness/plans.rs`, di `openclaw_gateway_extras()`, tepat sesudah baris 247 (sesudah knob P3 terakhir), sejajar dengan knob yang sudah ada:

```rust
// plans.rs:241-247 (konteks yang ada — tiga knob 4.5)
push_pair(extras, "OPENCLAW_NO_AUTO_UPDATE", "1");
push_pair(
    extras,
    "OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK",
    "1",
);
push_pair(extras, "OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS", "1");
// <-- TAMBAH (Fase 0): aktifkan profil fast-boot fork openclaw-light.
// Saklar tunggal A1; default fork OFF bila env tidak ada. Nilai "1"
// konsisten dengan knob lain (truthy menurut isTruthyEnvValue fork).
push_pair(extras, "OPENCLAW_MOBILE_BOOT", "1");
```

Satu baris ini saja sudah mengaktifkan fast-boot di produksi.

**2. Cermin Kotlin (wajib agar mirror tidak drift, tapi TIDAK mengaktifkan apa pun sendirian).** `harness/openclaw/src/main/java/com/polones/harness/openclaw/OpenClawHarness.kt`, di `launchEnv()`, sesudah baris 300:

```kotlin
// OpenClawHarness.kt:298-300 (konteks yang ada — tiga knob 4.5)
put("OPENCLAW_NO_AUTO_UPDATE", "1")
put("OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK", "1")
put("OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS", "1")
// <-- TAMBAH (Fase 0, cermin Rust plans.rs — bukan jalur eksekusi):
put("OPENCLAW_MOBILE_BOOT", "1")
```

**3. Bukan tempat yang tepat — `dynamicEnv()` / `EngineDynamicEnv`.** Kanal itu khusus kredensial dinamis dari SecretStore. Secara teknis nilai di sana akan menang (Rust `static_extras` meng-append `dynamic` di akhir), tapi secara semantik salah dan ikut mengalir ke `verifyPlan` (`openclaw --version`). Jangan dipakai.

**Tidak ada mekanisme env tambahan per harness tanpa ubah kode:** grep `extraEnv|additionalEnv|customEnv|env_override` di `core/`, `app/`, `feature/`, `harness/` (Kotlin) = nol hasil. Satu-satunya jalan memasukkan env baru ke proses gateway adalah mengubah `openclaw_gateway_extras` di Rust (+ cermin Kotlin + test).

**Tidak perlu mengubah `child.mjs`:** filter env di tengah ada dua, dan keduanya LOLOS untuk var ini:
- `supervisor::process::spawn` (`process.rs:43-46`): `env_clear()` + hanya env plan — ini whitelist total, bukan filter nama. Konsekuensi: menambahkan var di Kotlin saja (cermin) tidak cukup; harus di Rust plan.
- `gatewayEnv` di `scripts/mobile-patch/child.mjs:75-97` (allowlist tertutup, temuan #544): `GATEWAY_ENV_ALLOW` (nama eksplisit) + `GATEWAY_ENV_PREFIXES = ["LC_", "HERMES_WEBUI_", "OPENCLAW_"]` (baris 53) + pola `*_API_KEY`/`*_API_TOKEN` + `NODE_OPTIONS` hanya bila persis satu flag heap. **`OPENCLAW_MOBILE_BOOT` lolos otomatis lewat prefiks `OPENCLAW_`** — tidak perlu mengubah `child.mjs`. Kontrak ini dipin test `tests/contract/openclaw-gateway-env.test.mjs:340-348` (var `OPENCLAW_*` arbitrer lolos).

**Tidak ada cara alternatif mengaktifkan fast-boot:** tidak ada CLI flag (grep `"--mobile` di seluruh `src/` fork kosong); tidak ada kunci config file (grep `mobileBoot` di `src/config/` fork hanya menemukan threading nilai yang sudah di-resolve — tidak ada kunci skema `openclaw.json`). Hanya env var. Perintah luncur Polones (`openclaw gateway run --allow-unconfigured`) tidak bisa ditambahi flag fast-boot.

### 3.3 Test + dokumen yang wajib menyertai (aturan pemilik)

- **Test Rust:** assert di `plans.rs` (~baris 851-857, deretan assert tiga knob P3) — tambah assert `OPENCLAW_MOBILE_BOOT` = `"1"` di plan OpenClaw.
- **Test kontrak Node:** `tests/contract/openclaw-gateway-env.test.mjs` (~baris 146-164, daftar knob) — tambah `OPENCLAW_MOBILE_BOOT` ke daftar knob yang diharapkan; test allowlist `child.mjs` (baris 340-348) sudah mencakup prefiks `OPENCLAW_*`, tidak perlu diubah.
- **Dokumen:** `docs/plan/STATUS.md` (catat Fase 0 + hasil ukur perangkat), `docs/guides/openclaw.md` §5 (catat saklar aktif + cara rollback), `CHANGELOG.md` (perilaku pengguna berubah: start lebih cepat), `tests/INVENTORY.md` (bila test baru ditambah).
- **Perbaikan dokumen basi (sertakan dalam commit Fase 0):** `DESIGN.md` §8 dan `FORK-LAPORAN.md` §4.1 — F4 sudah merge di `b741e515`, bukan "terblokir/belum merge". Rujukan ukuran F4 kini `MEASUREMENT.md` §12 (bukan §7). (Salinan edit tertunda ada di `/tmp/lane-g-docs-pending.md` — terapkan + sesuaikan dengan temuan §1.2 dokumen ini.)

### 3.4 Verifikasi (cara membuktikan saklar benar-benar aktif)

1. **Build + rilis:** commit di `main` Polones → push (perintah push eksplisit pemilik tetap berlaku) → build APK → verifikasi APK (skill `polones_release_apk_verification` + `polones_jni_boundary_verification`) → serahkan link dengan peringatan #518 (uninstall dulu).
2. **Bukti saklar sampai ke gateway (perangkat):** di `gateway.log` (state dir `~/.openclaw/` perangkat) harus ada baris `mobile boot profile enabled (OPENCLAW_MOBILE_BOOT=1); fork fast-boot behaviors active per lane wiring`. Bila baris ini tidak ada, saklar tidak sampai — jangan klaim aktif.
3. **Bukti perilaku (perangkat, S1):** ukur A (spawn → tile READY), `/ready` 200 pertama, dan B (Buka → bisa dipakai, chat pertama bisa dikirim) + `startup-phases.log` (lihat §7). **Waktu adalah verifikasinya** — "tidak ada error" bukan bukti, karena mode gagalnya diam-diam (§1.1).
4. **Rollback:** hapus `push_pair` (atau set `"0"`) → default OFF = perilaku upstream murni. Rollback mudah dan aman.

### 3.5 Perkiraan dampak Fase 0 (perkiraan, BUKAN vonis)

| Definisi | Baseline perangkat (OFF, v0.1.120/124) | Perkiraan ON (perangkat) | Dasar perkiraan |
|---|---|---|---|
| **A** (spawn → `/health` 200 / tile READY) | ~95 dtk | **60–90 dtk, kemungkinan 70–85 dtk** | F1 mengeluarkan admission dari pra-listen (LAB lama PRoot: 27,2 dtk; LAB native segar: 1,6 dtk — nilai perangkat di antaranya, tergantung tumpukan sesi; A4 membantu boot berulang). F2 hemat ~1 dtk bersih, besar hanya bila lock kotor. F3/F6/F4(a) masing-masing ~0–2 dtk LAB. Sisa rantai pra-listen tetap utuh |
| **B** (Buka → bisa dipakai) | >135 dtk (ujung tak terukur) | **70–120 dtk, kemungkinan 85–110 dtk** | Pengurang terbesar: W1/W2 menghilangkan stall katalog **43,5 dtk** dari jalur B. F5 mempersempit `plugins.runtime-post-bind` (9,7 dtk LAB) ke esensial saja — fraksi belum terukur, di perangkat bisa puluhan detik. Tetapi `/ready` tetap menunggu post-attach + migrasi, dan chat pertama tetap menunggu `unlockStartupMethods` |
| **Kasus lock kotor** (crash/kill -9 sebelumnya) | Gagal total (OFF exit ~104 dtk tanpa `/health`, LAB) | **≈ boot bersih** (ON `/health` 21,4/22,9 dtk LAB) | Satu-satunya klaim ON yang **terukur**, F2 (`MEASUREMENT.md` §8.3). Di perangkat angkanya lebih besar tapi polanya sama |

**Yang TIDAK tercapai Fase 0:** target desain "definisi B hitungan detik". Dengan implementasi saat ini, B hitungan detik tidak dimungkinkan secara struktural. Yang realistis adalah B dari ">135 dtk, belum bisa dipakai" menjadi "~85–110 dtk, bisa dipakai" — perbaikan besar, bukan transformasi ke kecepatan OpenCode. Klaim "3 detik" tidak boleh disampaikan ke user sesudah Fase 0.

### 3.6 Yang TIDAK ikut Fase 0 — `OPENCLAW_MOBILE_SINGLE_OWNER=1` (F2)

Saklar kedua yang terpisah — hanya dihormati bila A1 ON, dan fork menegaskan "ONLY the Polones Rust plan may set it". F2 melewati proyeksi file-lock + asersi lease; pengaman yang tersisa hanya bind TCP eksklusif 18789. Aman hanya karena Polones memang single-owner (daemon satu slot + sapu lease/lock sebelum spawn). **Jangan nyalakan F2 dalam perubahan yang sama tanpa keputusan eksplisit** — ia butuh keputusan sendiri (lihat §10). Bila diputuskan, tempatnya sama (`plans.rs`, di sebelah A1) + test pendamping + vonis perangkat start kedua (boot bersih vs kotor).

## 4. Perombakan besar — fase-fase (diurutkan prioritas)

Setiap fase berisi: masalah yang diselesaikan, perubahan yang diusulkan, berkas/area yang disentuh, risiko + guardrail, dan perkiraan dampak (definisi A dan B). Semua perkiraan diberi label dasarnya; yang belum terukur ditulis [BELUM TERUKUR] dan tidak boleh disajikan sebagai vonis.

### Fase 1 — Proses depan tipis yang sesungguhnya (true early-listen)

**Masalah:** seluruh rantai pra-listen (impor graf + bootstrap + kernel + request-runtime) berjalan sebelum `http.listen`. `/health` baru menjawab sesudah ~26 dtk [LAB] / ~95 dtk (perangkat). F4 yang diimplementasikan hanya lazy-import + tunda join (lihat §1.2) — ia tidak memindahkan satu pun fase pra-listen ke sesudah `http.bound`, kecuali admission (F1). Ini satu-satunya perubahan yang bisa memindahkan A dari puluhan detik ke hitungan detik, dan ia **tidak ada di fork**.

**Perubahan yang diusulkan:**

1. **Definisikan "graf-listen"** — himpunan minimal modul yang dibutuhkan untuk mengikat socket dan melayani `/health` + `/` (shell Control UI) + auth gate. Isinya: HTTP server, rute probe (`/health`, `/ready` — dengan `/ready` yang jujur melaporkan "belum ready" sampai post-attach selesai), auth gate (cek token), state-owner minimal, dan penyajian berkas statis Control UI. Bukan: bootstrap config penuh, kernel, request-runtime, plugin loader, model runtime.
2. **Restrukturisasi startup:** (a) proses hanya mengimpor graf-listen dulu; (b) mengikat 18789 dan mulai melayani `/health` + shell; (c) SESUDAH `http.bound`, impor dinamis graf-sisa (bootstrap, kernel, request-runtime, plugin, dll.). Titik pisah graf ADA di `http.bound` (terbukti F9) — pekerjaan ini adalah memakainya sebagai titik pisah *proses*, bukan hanya titik pisah *impor*.
3. **Definisikan UI sebelum ready:** shell tampil dengan status jujur "memulai" (bukan "ready"); input chat ada tetapi kirim dinonaktifkan/di-antre sampai ready, dengan indikator status yang terlihat. UI tidak boleh mengklaim agen siap sebelum ia siap (N11, lihat §5).
4. **`/ready` tetap jujur:** 200 hanya sesudah post-attach + migrasi selesai (N9). `/health` menjawab 200 begitu proses hidup dan mendengarkan — itu liveness, bukan readiness, dan itu jujur. Yang berubah adalah *arti yang dibaca Polones* dari `/health` — lihat butir 5.
5. **Perubahan pendamping sisi-Polones (wajib, bukan opsional):** Polones saat ini mem-probe `/health` untuk tile READY. Bila `/health` menjawab lebih awal, tile akan menunjukkan READY lebih awal — menyesatkan bila user mengetuk Buka dan belum bisa chat. Maka Polones harus membedakan "hidup" (`/health`) dari "siap" (`/ready`): tile menampilkan status perantara (mis. "Memulai" → "Hidup" → "Siap"), atau tile READY mengikuti `/ready` dan indikator liveness terpisah mengikuti `/health`. Pilihan persisnya adalah keputusan pemilik (lihat §10). Tanpa perubahan pendamping ini, Fase 1 akan memalsukan tile.

**Berkas/area yang disentuh:**

- Fork: `src/gateway/server-start.ts`, `src/cli/gateway-cli/run.ts`, `src/gateway/server.ts`, `src/gateway/server-startup-*.ts`, `gateway-prewarm` (9.384 baris — graf yang harus dipisah), `src/entry-gateway.ts`, shell Control UI (`ui/src/pages/chat`, `ui/src/lib`).
- Polones: logika probe/tile (`supervisor/src/health.rs`, `plans.rs` `ready_within_ms`, state machine tile Dashboard).
- Prasyarat: instrumentasi F9 (sudah ada) untuk membuktikan modul mana yang diimpor sebelum vs sesudah `http.bound`.

**Risiko + guardrail:**

- **Risiko TINGGI.** Graf `gateway-prewarm` 9.384 baris harus dipisah tanpa siklus impor baru dan tanpa `ReferenceError` di runtime. Audit modul satu per satu; pisah bertahap dengan test boot di tiap langkah (bukan sekali besar).
- **Risiko tile menyesatkan** bila perubahan pendamping Polones tidak ikut — mitigasi: Fase 1 tidak dianggap selesai sampai perubahan Polones-nya ikut terverifikasi di perangkat.
- **Guardrail:** N9 (jujur `/health` vs `/ready`), N1 (auth gate harus ada di graf-listen — tidak ada akses tanpa auth ke shell), N2 (bind eksklusif), N6 (migrasi tetap menggerbangi chat/RPC, bukan shell), N10 (OFF = upstream), N11 + N12 (baru, lihat §5).
- **Aturan berhenti:** bila pemisahan graf terbukti membutuhkan perubahan arti `/ready` atau melemahkan auth, BERHENTI dan laporkan ke Lead (jangan putuskan sendiri).

**Perkiraan dampak (perkiraan, dasar: struktur kode + LAB):**

| Metrik | Sebelum Fase 1 (ON, pasca-Fase 0) | Sesudah Fase 1 (perkiraan) |
|---|---|---|
| A — socket terikat + `/health` 200 (baru: "hidup") | ~70–85 dtk | **~5–15 dtk** (perangkat; sisanya Node startup + impor graf-listen + overhead Groot) |
| B — shell tampil (cold) | ~85–110 dtk | **~10–20 dtk** (shell disajikan lebih awal; chat digerbangi sampai ready) |
| `/ready` 200 (full) | ~60–90 dtk | **tidak berubah** (~60–90 dtk) — gateway penuh tetap selama itu; yang membaik hanya yang *dirasakan* |
| Chat pertama bisa dikirim (cold) | ~85–110 dtk | **~60–90 dtk** (tetap menunggu post-attach + migrasi) |

### Fase 2 — Prestart / warm-run / reattach (Polones)

**Masalah:** bahkan dengan proses depan tipis, cold start ke full-ready tetap puluhan detik. Satu-satunya jalan ke "terasa ~3 detik" adalah gateway sudah hidup saat user mengetuk. Fork sendiri berlantai puluhan detik (native LAB ke health saja 22–26 dtk; perangkat ~95 dtk → pasca-fork realistis puluhan detik perangkat, bukan 2 dtk).

**Perubahan yang diusulkan (sisi Polones, bukan fork):**

1. **Prestart:** jalankan gateway OpenClaw di latar saat aplikasi dimulai (atau saat perangkat idle/mengisi daya), digerbangi guard RAM `PRESTART_MIN_AVAIL_RAM_MB` 2048 (sudah diputuskan; hook prestart sudah ditulis di P5 tetapi default OFF). Nyalakan prestart = keputusan pemilik (§10) karena tradeoff baterai/RAM.
2. **Warm-run:** jangan bunuh gateway saat aplikasi ke latar; pertahankan proses hidup lintas restart aplikasi bila memungkinkan. (Perilaku ini sudah sebagian ada — warm-run 7.5 ditunda; lihat §10.)
3. **Reattach:** perbaiki bug desain — `start()` saat ini menyapu yatim `gateway run` sebelum cek reattach, sehingga reattach praktis tak terjangkau. Ubah urutan: cek reattach dulu (probe gateway yang sudah jalan + verifikasi sehat), baru sapu yatim bila tidak ada yang bisa di-reattach. Ini perubahan desain yang butuh keputusan (lihat §10).
4. **Kebijakan kesehatan proses hangat:** gateway yang sudah lama hidup harus diperiksa kesehatannya secara berkala; bila tidak sehat (probe gagal, wedge), restart. Tanpa ini, warm-run bisa mempertahankan gateway yang wedged.

**Berkas/area yang disentuh:**

- Polones: hook prestart, logika `start()`/reattach, pembersihan lease/proses (`lease.rs`, `process.rs`), guard RAM, kebijakan restart gateway hangat. Tidak ada perubahan fork.

**Risiko + guardrail:**

- **Baterai/RAM:** gateway resident mengonsumsi memori (~1,1 GB baseline) dan sedikit CPU. Wajib menghormati guard 2048 MB. User harus menerima tradeoff ini secara eksplisit (itu sebabnya prestart default OFF dan butuh keputusan pemilik).
- **State basi:** gateway yang hidup lama bisa menumpuk sesi basi atau state wedged. Mitigasi: cek kesehatan berkala + restart bila tidak sehat (butir 4 di atas).
- **Reattach ke gateway yang tidak sehat:** verifikasi gateway sehat dulu (probe `/health` + `/ready`) sebelum reattach; bila tidak sehat, start baru.
- **Guardrail:** N13 (prestart opt-in, lihat §5); Opsi A tetap (satu Gateway — prestart tidak boleh menciptakan Gateway kedua; bind eksklusif 18789 tetap penjaga).

**Perkiraan dampak:**

| Metrik | Sebelum Fase 2 | Sesudah Fase 2 (perkiraan) |
|---|---|---|
| B — shell + chat pertama (**warm**, gateway sudah hidup) | ~85–110 dtk (cold) | **~2–5 dtk** — inilah pengalaman OpenCode (hanya muat WebView + reconnect) |
| A — cold | ~70–85 dtk | **tidak berubah** — cold start tetap puluhan detik, tetapi menjadi jarang (hanya boot pertama sesudah install/reboot, atau sesudah crash) |
| B — cold | ~85–110 dtk | **tidak berubah** (Fase 1 yang memperbaikinya) |

**Fase 2 adalah fase berdampak terbesar bagi pengalaman user.** Tanpa Fase 2, tidak ada jalan ke "~3 detik" untuk chat pertama. Dengan Fase 2 (dan Fase 1), pengalaman warm OpenClaw setara OpenCode.

### Fase 3 — Kurangi volume I/O perangkat (menyerang pengali ~3,7×)

**Masalah:** aset 519 MB / 32.354 berkas (`dist/` 281 MB / 17.464 berkas; `node_modules/` 237 MB; `control-ui` 63 MB; 76 ekstensi). Di perangkat, overhead syscall Groot + eMMC + page-in mengalikan tiap buka/stat berkas. Fork tidak memangkas volume I/O secara orde-besaran; D2/F6 hanya memangkas satuan detik.

**Perubahan yang diusulkan (mulai dengan pengukuran, bukan tebakan):**

1. **Ukur dulu (prasyarat fase ini):** dari `startup-phases.log` perangkat (Fase 0) + pengukuran LAB dengan PRoot, kuantifikasi berapa besar porsi boot yang merupakan I/O berkas vs CPU. Jangan tebak — bila I/O ternyata kecil, fase ini tidak dikerjakan.
2. **Bundle/consolidasi:** kurangi jumlah berkas yang dibaca saat boot — `dist/` di-bundle ke chunk yang lebih sedikit dan lebih besar (konfigurasi code-splitting tsdown/rollup). Lebih sedikit berkas = lebih sedikit stat/open yang dikalikan overhead Groot. (Catatan: aset sudah berupa tar.zst yang diekstrak sekali saat install — jadi tuasnya adalah jumlah berkas yang *dibaca saat boot*, bukan format arsip.)
3. **Prune `node_modules` lebih agresif (D3):** `npm`, `@esbuild`, `highlight.js`, `clawpdf` — HANYA sesudah bukti impor (graf impor per paket [BELUM TERUKUR]); aturan D3 melarang hapus tanpa bukti.
4. **Cache inventaris ekstensi:** gateway memindai `extensions/` saat boot (76 ekstensi). Perluas cache rencana plugin A3 untuk mencakup inventaris ekstensi (daftar + hash), sehingga pemindaian penuh hanya terjadi bila hash berubah.
5. **Control UI:** pastikan gateway tidak mem-stat/memindai seluruh direktori `dist/control-ui` (136 MB) saat boot — hanya sajikan berkas yang diminta. (Bila ada pemindaian, pindahkan ke lazy.)

**Berkas/area yang disentuh:**

- Fork: konfigurasi build (tsdown, `package-openclaw-for-docker.mjs`), discovery ekstensi, plugin loader, penyajian aset Control UI.
- Polones: build aset (`scripts/openclaw/build.sh`, langkah prune), bila prune memengaruhi paket.

**Risiko + guardrail:**

- **Risiko SEDANG.** Perubahan bundling bisa memecah impor dinamis (F4 bergantung pada impor dinamis; chunk yang lebih sedikit bisa memasangkan kembali graf yang sudah dipisah). Prune tanpa bukti impor memecah boot. Mitigasi: bukti impor dulu (D3), test boot di tiap langkah, dan jaga agar graf-listen Fase 1 tetap terpisah.
- **Guardrail:** D3 (hapus hanya sesudah bukti impor); N10 (OFF = upstream — perubahan build tidak boleh mengubah perilaku OFF); jangan ubah format aset sedemikian rupa sehingga verifikasi APK (hash/pin) menjadi tidak bermakna.

**Perkiraan dampak:**

| Metrik | Sebelum Fase 3 | Sesudah Fase 3 (perkiraan) |
|---|---|---|
| A — cold | ~70–85 dtk (pasca-Fase 0) | **~50–70 dtk** (bila porsi I/O besar; [BELUM TERUKUR] — angka ini hanya target, bukan janji) |
| Pengali perangkat (vs LAB native) | ~3,7× | **target ~2×** (bila I/O adalah penyebab utama pengali) |

**Jujur dicatat:** dampak Fase 3 tidak bisa diperkirakan tanpa `startup-phases.log` perangkat. Bila pengukuran menunjukkan I/O hanya porsi kecil, fase ini dipersempit atau dibatalkan — dan itu keputusan yang benar, bukan kegagalan.

### Fase 4 — Selesaikan F5 (F5b) + tunda init model runtime ke chat pertama

**Masalah:** `plugins.runtime-post-bind` adalah fase tunggal terbesar pasca-bind (9,7 dtk [LAB]). F5 membuat capture async + membagi essential/deferred, tetapi **F5b (cache artefak capture antar-boot) SENGAJA tidak diimplementasikan** (butuh design review). Init model runtime (`sidecars.model-runtime` 2,7 dtk [LAB]) ada di jalur post-attach padahal hanya dibutuhkan saat turn chat dimulai.

**Perubahan yang diusulkan:**

1. **F5b — cache artefak capture antar-boot:** simpan artefak capture plugin di `captures/` lintas boot, dengan kunci invalidasi = hash config + hash `dist/` + fingerprint `extensions/`. **Design review DULU** (staleness vs correctness — capture basi bisa menyajikan versi plugin yang salah). Aturan invalidasi harus ditulis dan diuji sebelum implementasi (test: ubah config → cache miss; ubah `dist/` → cache miss; tanpa perubahan → cache hit).
2. **Tunda init model runtime:** jangan inisialisasi model runtime (`sidecars.model-runtime`) saat post-attach; inisialisasi saat request chat pertama (atau di latar pasca-ready). Model runtime hanya dibutuhkan saat turn dimulai.
3. **Persempit himpunan "essential":** ukur plugin essential mana yang benar-benar dibutuhkan untuk chat pertama vs mana yang bisa dipindah ke deferred. (Saat ini "essential" = pemilik provider terkonfigurasi + memory-slot & context-engine-slot + pemilik channel & harness runtime — mungkin masih terlalu luas.)

**Berkas/area yang disentuh:**

- Fork: `src/plugins/plugin-generation-worker.ts` (`preparePluginGenerationArtifact`, `requestSync`→`request`), `src/gateway/server-startup-plugins.ts` (`loadGatewayStartupPluginRuntime`), `src/gateway/server-startup-post-attach.ts` (sidecars, deferred load).

**Risiko + guardrail:**

- **Risiko SEDANG.** Cache basi (mitigasi: kunci invalidasi yang kuat + test invalidasi). Deferral model runtime menaikkan latensi chat pertama (chat pertama membayar biaya init — harus diukur dan diungkapkan; bila init model gagal saat chat pertama, chat pertama gagal — butuh error yang jelas + retry). 
- **Guardrail:** N7 (`plugins.deny` tetap ditegakkan di semua jalur, termasuk cache); N9 (`/ready` tetap jujur — bila model runtime ditunda, `/ready` harus tetap berarti "bisa chat" ATAU definisinya diubah secara eksplisit dan disetujui — lihat §10; jangan diam-diam mengubah arti `/ready`).

**Perkiraan dampak:**

| Metrik | Sebelum Fase 4 | Sesudah Fase 4 (perkiraan) |
|---|---|---|
| `/ready` 200 [LAB] | ~42 dtk | **~30 dtk** (bila post-bind menyusut signifikan) |
| B — cold (perangkat) | ~85–110 dtk | **membaik sefraksi** (proporsional dengan penyusutan post-bind) |
| Latensi chat pertama | (termasuk dalam B) | **naik ~2–5 dtk** (biaya init model yang ditunda, dibayar sekali) — tradeoff yang harus diukur dan diungkapkan |

### Fase 5 — Admission + migrasi sesi lanjutan (hidrasi malas sesi)

**Masalah:** di perangkat dengan sesi menumpuk, `sessions.admission` + migrasi bisa menjadi biaya besar — tetapi LAB memakai state segar (1,6 dtk) sehingga tidak representatif. A4 (migrasi inkremental, watermark) membantu boot berulang, tetapi boot pertama sesudah upgrade atau di perangkat bersesi banyak tetap melakukan migrasi penuh.

**Perubahan yang diusulkan:**

1. **Hidrasi malas sesi:** jangan hidrasi semua sesi saat boot; hidrasi hanya metadata daftar sesi (judul, timestamp) dan hidrasi state penuh sebuah sesi saat sesi itu dibuka/dibaca detail. Ini perubahan yang lebih besar (proyeksi sesi saat ini mematerialisasi sesi saat admission).
2. **Perluas watermark A4:** watermark per-sesi (bukan hanya watermark global), sehingga hanya sesi yang berubah sejak watermark-nya yang dimigrasi penuh.
3. **Ukur dulu:** biaya admission + migrasi pada state perangkat yang menumpuk (perangkat user punya sesi dari pemakaian berbulan-bulan) — ini penentu utama apakah Fase 5 bernilai besar atau kecil.

**Berkas/area yang disentuh:**

- Fork: `src/config/sessions/startup-migration.ts`, `src/gateway/server-startup-session-migration.ts`, proyeksi sesi (`session-row-projection.ts`, `session-row-projection-access.ts`).

**Risiko + guardrail:**

- **Risiko SEDANG.** Hidrasi malas mengubah kapan data sesi tersedia — UI harus menangani "sesi belum terhidrasi" dengan anggun (tampilkan placeholder, bukan error). Watermark per-sesi menambah kompleksitas pada state machine migrasi.
- **Guardrail:** N6 (migrasi tidak pernah dilewati, hanya ditunda — hidrasi malas menunda hidrasi, bukan migrasi; migrasi skema tetap harus selesai sebelum sesi ditulis); N3 (integritas state/sqlite); N9 (`/ready` tetap menunggu migrasi yang menggerbangi chat — hidrasi malas tidak boleh membuat `/ready` berbohong tentang kesiapan sesi).

**Perkiraan dampak:**

| Metrik | Sebelum Fase 5 | Sesudah Fase 5 (perkiraan) |
|---|---|---|
| A — state segar | ~70–85 dtk | **~0 dtk** (tidak ada sesi untuk dihemat) |
| A — perangkat bersesi banyak | [BELUM TERUKUR] | **berpotensi puluhan detik** (bila admission/migrasi memang besar di perangkat) — nilai fase ini hanya terbukti sesudah ukur perangkat |

### Fase 6 — Pengukuran + hardening (prasyarat klaim apa pun)

**Masalah:** manfaat terintegrasi ON vs OFF belum pernah terukur (lihat §1.5). Perbaikan test F4 belum commit. Dokumen fork basi di beberapa tempat. Tanpa fase ini, semua angka di dokumen ini tetap perkiraan.

**Perubahan yang diusulkan:**

1. **Buka blokir build `dist/` terintegrasi:** butuh mesin/CI ber-heap ≥4,4 GB (MemAvailable ≥5.500 MB selama ±12 mnt). Jalur yang sudah terbukti: CI Polones `build-openclaw.yml` sudah membangun `dist/` dari source (untuk aset) — perpanjang workflow itu (atau workflow terpisah) untuk menjalankan pengukuran boot di runner CI, atau sediakan VM yang lebih besar. Jangan ulangi waiter 345 cek di VM ini (sudah terbukti tidak bisa).
2. **Ukur LAB terintegrasi:** 2× ON vs 2× OFF dengan `docs/mobile-fast-boot/measure-baseline.sh` + `docs/mobile-fast-boot/measure-catalog-rpc.mts`, pada `dist/` terintegrasi. Isi tabel TBD di `MEASUREMENT.md` §7.3–7.4, §11.1–11.2, §12.
3. **Ronde perangkat:** S1/S2/S3 dengan saklar ON (+ sesudah tiap fase besar), `startup-phases.log` + `startup-summary.sh` + video. Ini vonis akhir.
4. **Tutup utang F4:** commit perbaikan test F4 (hanya-test, di worktree `~/workspace/openclaw-fork-lanes/lane-g`): `waitForStatus` 60→120 dtk, `it.each` 120→240 dtk, probe akhir `/ready` → polling; koreksi komentar yang salah (klaim "~127s before /health" SALAH — log `f4-repro-on.log`: `healthAtMs=80550` = 80,5 dtk; klaim "early runtime 250-306ms" TIDAK ada di log; klaim "180s budget" SALAH — timeout lama 120 dtk). Jalankan test run 4 di mesin ber-heap ≥4 GB. Pesan commit rencana: `test(gateway): raise F4 cold-boot budgets; poll final /ready`.
5. **Perbarui dokumen basi:** `DESIGN.md` §8, `FORK-LAPORAN.md` §4.1 (status F4), `MEASUREMENT.md` (isi TBD sesudah ukur).
6. **Suite regresi boot:** test boot yang gagal bila A atau B regresi melewati ambang (di CI, pada build terintegrasi). Ambang ditetapkan sesudah baseline terukur (bukan ditebak sekarang).

**Berkas/area yang disentuh:** workflow CI (`build-openclaw.yml`), skrip ukur (`measure-baseline.sh`, `measure-catalog-rpc.mts`), test F4, dokumen fork.

**Risiko + guardrail:** Risiko RENDAH (kebanyakan pengukuran + dokumen). Risikonya adalah pengukuran mengungkapkan manfaat fork lebih kecil dari harapan — itu bukan kegagalan, itu informasi (dan akan mengarahkan usaha ke fase yang benar-benar membantu).

**Perkiraan dampak:** 0 dtk secara langsung — tetapi prasyarat untuk mengklaim dampak apa pun. Tanpa fase ini, semua angka di atas tetap perkiraan.

## 5. Yang TIDAK boleh diubah (guardrail)

N1–N10 dari `DESIGN.md` §3 (diringkas — rujukan lengkap di sana):

| # | Yang dipertahankan | Mengapa |
|---|---|---|
| N1 | Auth Gateway + Control UI: `gateway.auth`, `OPENCLAW_GATEWAY_TOKEN`, device-identity + origin check, token `#token=` | Menghapus = siapa pun yang mencapai 18789/18790 punya akses penuh ke agen + riwayat chat |
| N2 | Bind eksklusif TCP 18789 | Penjaga terakhir single-owner bila F2 melemahkan lock file/sqlite; bind gagal = start gagal |
| N3 | State dir + integritas SQLite (`OPENCLAW_STATE_DIR`, `state/openclaw.sqlite`, agent DB, `state-snapshot`, migrasi skema) | Karantina-bukan-hapus adalah kebijakan Polones; fork yang menghapus state saat boot = kehilangan riwayat + sesi |
| N4 | Invarian lock: "pemilik yang tak terverifikasi tidak pernah direklamasi otomatis" — kecuali mode `OPENCLAW_MOBILE_SINGLE_OWNER=1` + jaminan eksklusivitas Polones + N2 | Relaksasi tanpa jaminan eksternal = dua Gateway menulis sqlite bersamaan = korupsi state |
| N5 | Validasi config + gerbang `gateway.mode=local` + exit 78 atas config invalid | Fail-closed mencegah restart-loop; Polones mengandalkan exit 78 untuk karantina + retry sekali |
| N6 | Migrasi sesi: ditunda boleh, dilewati TIDAK BOLEH | `assertExistingDatabaseIdentity` + validasi kanonik melindungi dari sesi basi/hilang; RPC agen harus menunggu migrasi |
| N7 | Semantik `plugins.deny` / allow-list (deny mengalahkan segalanya) | Lazy load (F5) + cache (A3/W2) harus tetap menghormatinya |
| N8 | Lantai runtime Node (24.22.1+/26.12.1+, `node:sqlite`) + `NODE_COMPILE_CACHE` | `openclaw.mjs` menolak runtime lain; fork yang menurunkan lantai = boot gagal di rootfs Polones (Node 24.22.3) |
| N9 | Sinyal readiness yang jujur: `/health` = live, `/ready` = ready, `h.mark("ready")` sesudah post-attach | Mengubah arti `/health` menjadi "ready" (atau menjawabnya dari shim) memalsukan status dan menutupi crash-loop |
| N10 | Perilaku default = upstream bila env fork tidak disetel (A1 OFF) | Satu-satunya cara rebase tetap teruji: test upstream berjalan atas fork dengan saklar OFF |

**Guardrail tambahan untuk perombakan ini:**

| # | Yang dipertahankan | Mengapa |
|---|---|---|
| N11 | Tidak ada readiness palsu di UI: shell sebelum ready harus menampilkan status jujur "memulai", bukan "ready"; kirim chat dinonaktifkan/di-antre sampai ready | UI yang mengklaim siap padahal belum siap adalah readiness palsu di lapisan presentasi — sama buruknya dengan shim health |
| N12 | Kontrak probe dengan Polones: perubahan apa pun atas arti `/health` (Fase 1) harus dikoordinasikan dengan logika probe/tile Polones dan disetujui pemilik | Bila tidak, tile READY akan menyesatkan (menunjukkan READY saat belum bisa chat) |
| N13 | Prestart opt-in: gateway tidak boleh dipertahankan resident tanpa persetujuan eksplisit pemilik, mengingat baterai/RAM | Resident gateway adalah biaya berjalan (memori ~1,1 GB + CPU) yang dibayar user setiap hari |
| N14 | Tidak ada kegagalan diam-diam pada deferral/cache baru: setiap penundaan/peladenan-dari-cache harus meninggalkan jejak log, sehingga kegagalan bisa didiagnosis | Mode gagal Fase 0 adalah diam-diam; perombakan ini tidak boleh menambah mode gagal diam-diam baru |

> **Aturan berhenti:** bila desain/implementasi membuktikan salah satu N1–N14 HARUS berubah, atau desain menabrak Opsi A (Gateway pemilik tunggal), **BERHENTI dan laporkan ke Lead**. Jangan putuskan sendiri.

## 6. Yang dipertimbangkan dan DITOLAK (jangan kerjakan — kecuali kondisi revisit terpenuhi)

| Opsi | Status | Alasan penolakan | Kondisi revisit |
|---|---|---|---|
| **Port Bun / single-executable** (A5) | DITOLAK beralasan | Bun 1.4 tak punya paritas `node:sqlite` / worker + `Atomics` / modul native `.node` / `execve`; belum ada prototipe. Dan kalaupun berhasil, ia hanya menghilangkan biaya parse Node (~0,4 dtk) — bukan kontrak gateway (config, sqlite, migrasi, plugin) yang mendominasi waktu. Bukan tuasnya | Bun mencapai paritas DAN prototipe membuktikan boot end-to-end lebih cepat secara material |
| **Shim health mandiri** (A2-R2) | DITOLAK | Menjawab `/health` dari shim yang bukan proses Gateway = readiness palsu; menutupi crash-loop | Tidak ada — dibedakan dari Fase 1: proses Gateway asli yang menjawab `/health` sebagai "live" (bukan "ready") adalah jujur, bukan shim |
| **Compile cache jadi di dalam aset** (F7) | DITOLAK | Seed cache miss (path + arsitek); cache hangat terbukti tidak memangkas boot | Tidak ada |
| **Esbuild penuh / V8 snapshot / zip `dist/`/`node_modules/`** (A5) | DITOLAK beralasan | Biaya + kerapuhan melebihi manfaat; snapshot V8 tidak stabil lintas versi Node | Bila ada prototipe yang membuktikan hemat material tanpa kerapuhan |
| **Hapus ekstensi / `dist/control-ui` / `memory-core` / 46 ekstensi borongan** (D1/D5/D7/D8) | DILARANG | Keputusan pemilik 24 Nov menolak 4.4 (D1); Control UI dipertahankan Opsi A (D5); `memory-core`/`active-memory` dilarang dihapus (D8) | Keputusan pemilik baru yang eksplisit |
| **Patch ke `dist/`** | DITOLAK | Rapuh tiap rilis (dist di-regenerasi); semua perubahan harus di `src/` | Tidak ada |
| **Hapus jalur update sepenuhnya tanpa pengganti** | Sudah dilakukan F8 (update lewat APK) | — | — |
| **F5b tanpa design review** | DITUNDA (bukan ditolak) | Cache capture basi bisa menyajikan versi plugin yang salah | Design review selesai (Fase 4) |

## 7. Cara mengukur + memverifikasi (LAB dan perangkat)

### 7.1 Definisi metrik (dipakai konsisten di seluruh rencana)

| Metrik | Definisi | Cara ukur |
|---|---|---|
| **A** (waktu-ke-probe) | spawn → `GET /health` 200 pertama (tile READY Polones) | `measure-baseline.sh` (LAB); video + `startup-phases.log` (perangkat) |
| **A'** (baru, Fase 1) | spawn → socket terikat + `/health` 200 dari graf-listen (proses hidup) | Sama seperti A, pada build Fase 1 |
| **`/ready`** | spawn → `GET /ready` 200 pertama (readiness jujur, sesudah post-attach + migrasi) | `measure-baseline.sh` (LAB); `startup-phases.log` (perangkat) |
| **B** (Buka → bisa dipakai) | spawn → Control UI shell tampil + chat pertama bisa dikirim | Proksi LAB: `GET /` 200 pertama (shell tersaji; chat pertama TIDAK bisa diukur di lab — butuh model + API key). Perangkat: video + uji kirim chat pertama |
| **B'** (baru, Fase 1) | Buka → shell tampil (bisa lihat + bisa mengetik; kirim digerbangi) | Perangkat: video (shell tampil) |
| **Latensi chat pertama** | kirim chat pertama → token pertama (TTFT) | Perangkat (butuh model + API key); LAB tidak bisa |
| **Kasus lock kotor** | Boot sesudah crash/kill -9 (owner basi) | `measure-lock-dirty.sh` (LAB); matikan paksa di perangkat lalu start ulang |

### 7.2 Baseline (yang dipakai sebagai pembanding — jangan dicampur)

| Baseline | A | `/ready` | B | Sumber |
|---|---|---|---|---|
| **Perangkat v0.1.120** (S1, video 25 Nov 02:39 WIB, Xiaomi 12) | ~95 dtk | — | >135 dtk (ujung tak terukur) | Video user |
| **Perangkat v0.1.124** (OFF, screenshot 26 Nov 07:31 WIB) | ~100 dtk (Memulai 07:28:34 → Berjalan 07:30:14) | — | — | Screenshot Aktivitas user |
| **LAB native OFF** (x86_64, run2-off, state segar) | 21,8 / 26,1 dtk | 43,5 / 42,4 dtk | 42,6 dtk (proksi `/`) | `MEASUREMENT.md` §4 |
| **LAB PRoot+QEMU OFF** (riset lama) | 283–330 dtk | — | — | `openclaw.md` §4 — JANGAN dicampur dengan LAB native |

**Aturan pelabelan (wajib):** semua angka diberi label **[LAB]** atau **[PERANGKAT]**, dan **[BELUM TERUKUR]** bila belum ada datanya. Angka LAB bukan angka perangkat. Perbedaan <±4 dtk di `/health` [LAB] dinyatakan sebagai noise, bukan efek lane (variansi antar-run terukur).

### 7.3 Kriteria sukses per fase

| Fase | Kriteria sukses (diukur, bukan diklaim) |
|---|---|
| **Fase 0** | Baris log `mobile boot profile enabled` ada di `gateway.log` perangkat; A perangkat turun vs baseline v0.1.124 (~100 dtk) — besarnya dilaporkan apa adanya (perkiraan 70–85 dtk, bukan janji); S1/S2/S3 + `startup-phases.log` terkumpul |
| **Fase 1** | A' (socket) ≤15 dtk di perangkat (cold); shell tampil ≤20 dtk cold; `/ready` tetap jujur (200 hanya sesudah post-attach + migrasi — dibuktikan test + `startup-phases.log`); tile Polones menampilkan status perantara dengan benar (tidak menunjukkan READY saat belum bisa chat) |
| **Fase 2** | B warm (shell + chat pertama) ≤5 dtk di perangkat, diukur 3× berturut-turut; gateway hangat terbukti sehat (probe `/health` + `/ready` 200 sebelum reattach); konsumsi RAM/baterai dilaporkan (bukan disembunyikan) |
| **Fase 3** | Pengali perangkat turun terukur (dari `startup-phases.log` sebelum vs sesudah); bila I/O ternyata porsi kecil, fase dipersempit/dibatalkan dengan bukti — itu sukses, bukan gagal |
| **Fase 4** | `/ready` [LAB] turun terukur; invalidasi cache F5b terbukti (ubah config → miss; tanpa perubahan → hit); latensi chat pertama diukur dan diungkapkan (termasuk kenaikannya) |
| **Fase 5** | Biaya admission/migrasi pada state perangkat menumpuk terukur sebelum vs sesudah; tidak ada sesi hilang/rusak (N3/N6 dibuktikan test migrasi) |
| **Fase 6** | Tabel TBD di `MEASUREMENT.md` terisi (LAB terintegrasi 2× ON vs OFF); ronde perangkat S1/S2/S3 dengan saklar ON selesai; suite regresi boot hijau di CI |

### 7.4 Alat ukur

- **LAB:** `docs/mobile-fast-boot/measure-baseline.sh <label>` (`/health`, `/ready`, `/` 200 pertama + `timings.tsv` + `phases.tsv`); `docs/mobile-fast-boot/measure-catalog-rpc.mts` (latensi RPC `tools.catalog` dingin/hangat); `docs/mobile-fast-boot/measure-lock-dirty.sh` (kasus lock kotor). Syarat: mesin/CI heap ≥4,4 GB untuk build `dist/` (lihat §4 Fase 6).
- **Perangkat:** `startup-phases.log` (F9 — per harness), `startup-summary.sh` (cold_device, cold_process, warm_repeat per harness; S1/S2/S3 OpenClaw), video (waktu tile READY + Buka→bisa dipakai), `gateway.log` (baris `mobile boot profile enabled` + fase startup).
- **Verifikasi APK:** skill `polones_release_apk_verification` + `polones_jni_boundary_verification` (hash, pin aset, repro PRoot+QEMU uid nobody, JNI 1:1) — sebelum link APK diserahkan, seperti v0.1.124.

## 8. Urutan eksekusi (lane) + dependensi

| Lane | Fase | Dependensi | Bisa paralel dengan | Catatan |
|---|---|---|---|---|
| **Lane 0** | Fase 0 — nyalakan saklar (Polones) | Tidak ada (aset fork sudah di APK v0.1.124) | Semua lane | **Kerjakan dulu.** Satu-satunya prasyarat adalah persetujuan rencana ini + perintah push pemilik |
| **Lane 1** | Fase 6 (bagian infra) — buka blokir build `dist/` terintegrasi di CI | Tidak ada | Lane 0 | Prasyarat pengukuran semua fase fork; mulai bersamaan dengan Lane 0 |
| **Lane 2** | Fase 1 — proses depan tipis (fork) | F9 (sudah ada) + Lane 1 (untuk ukur) + keputusan pemilik §10 (kontrak probe) | Lane 3, 5 | Risiko tertinggi; kerjakan sesudah Fase 0 terverifikasi di perangkat |
| **Lane 3** | Fase 2 — prestart/warm-run/reattach (Polones) | Keputusan pemilik §10 (prestart ON + desain reattach) | Lane 2, 4, 5 | Repo/area berbeda dari Lane 2 — paralel aman |
| **Lane 4** | Fase 3 — kurangi volume I/O | `startup-phases.log` perangkat dari Fase 0 (untuk kuantifikasi I/O) | Lane 2, 3 | Bila pengukuran menunjukkan I/O porsi kecil, persempit/batalkan dengan bukti |
| **Lane 5** | Fase 4 — F5b + tunda model runtime | Design review F5b (prasyarat implementasi) | Lane 2, 3 | Design review dulu, implementasi sesudahnya |
| **Lane 6** | Fase 5 — admission/migrasi lanjutan | Pengukuran admission perangkat dari Fase 0 | Lane 2–5 | Nilai fase ini hanya terbukti sesudah ukur perangkat |
| **Lane 7** | Fase 6 — pengukuran + hardening (lanjutan) | Semua lane (untuk vonis akhir tiap fase) | — | Berjalan terus; gate sebelum tiap rilis yang membawa perubahan fase mana pun |

**Aturan urutan:** Fase 0 dulu (tanpa itu semua lane fork = mati di perangkat). Jangan mulai Fase 1 sebelum Fase 0 terverifikasi di perangkat (bila saklar ternyata tidak sampai ke gateway, semua pengukuran Fase 1 tidak bermakna). Fase 2 bisa dimulai segera sesudah keputusan pemilik — ia tidak bergantung pada fork.

## 9. Estimasi dampak kumulatif (perkiraan — baca §7.2 sebelum mengutip)

| Tahap | A (spawn → `/health` / READY) | B (Buka → bisa dipakai) | `/ready` | Chat pertama |
|---|---|---|---|---|
| **Baseline OFF** (v0.1.120/124, perangkat) | ~95–100 dtk | >135 dtk | — | >135 dtk |
| **+ Fase 0** (saklar ON) | **~70–85 dtk** | **~85–110 dtk** | ~60–90 dtk | ~85–110 dtk |
| **+ Fase 1** (proses depan tipis) | **~5–15 dtk** (socket; "hidup") | **~10–20 dtk** (shell; kirim digerbangi) | ~60–90 dtk (tidak berubah) | ~60–90 dtk (cold) |
| **+ Fase 2** (prestart, **warm**) | ~5–15 dtk (cold; warm tidak relevan) | **~2–5 dtk** (warm) | ~2–5 dtk (warm, sudah ready) | **~2–5 dtk** (warm) |
| **+ Fase 3** (kurangi I/O) | **~50–70 dtk** (cold; bila I/O porsi besar) | membaik sefraksi | membaik sefraksi | membaik sefraksi |
| **+ Fase 4** (F5b + tunda model) | — | membaik sefraksi | **~30 dtk [LAB]** (dari ~42 dtk) | +~2–5 dtk (biaya init ditunda, dibayar sekali) |
| **+ Fase 5** (admission) | tergantung sesi perangkat | tergantung sesi perangkat | tergantung sesi perangkat | tergantung sesi perangkat |
| **Gabungan — cold** | shell ~5–15 dtk | shell ~10–20 dtk; chat-ready **~40–60 dtk** | ~40–60 dtk | **~40–60 dtk** |
| **Gabungan — warm** | — | **~2–5 dtk** | sudah ready | **~2–5 dtk** |

**Kesimpulan jujur:** cold-boot penuh ke chat-ready dalam 3 detik **tidak tercapai** — lantainya puluhan detik. Yang tercapai adalah **pengalaman OpenCode**: shell dalam hitungan detik saat cold, dan shell + chat pertama dalam ~2–5 detik saat warm. Bila pemilik menginginkan angka "3 detik" untuk cold full-ready, itu membutuhkan penghapusan kontrak gateway itu sendiri — yang dilarang guardrail (N3/N5/N6/N9) dan bukan yang direncanakan di sini.

## 10. Keputusan yang butuh pemilik (tidak diputuskan di rencana ini)

| # | Keputusan | Konteks | Rekomendasi rencana (bukan keputusan) |
|---|---|---|---|
| K-1 | **Setujui rencana ini** (lanjut ke implementasi) | Tanpa persetujuan, tidak ada fase yang dimulai (kecuali Fase 0 yang sudah diperintahkan planning-nya) | Setujui — dengan catatan §0.3 (arti "3 detik" yang jujur) dibaca dulu |
| K-2 | **Prestart ON** (default OFF) | Tradeoff baterai/RAM (~1,1 GB resident) vs start instan. Hook + guard 2048 MB sudah ada (P5); yang dibutuhkan hanya menyalakan | Nyalakan, dengan guard RAM tetap aktif + kebijakan restart gateway hangat (Fase 2 butir 4) |
| K-3 | **Kontrak probe/tile sesudah Fase 1** — apa arti READY bila `/health` menjawab lebih awal | Tile saat ini mengikuti `/health`. Opsi: (a) tile mengikuti `/ready`, indikator liveness terpisah mengikuti `/health`; (b) tile menampilkan status perantara (Memulai → Hidup → Siap) | Opsi (b) — paling jujur bagi user (ia melihat progres, bukan lompatan READY palsu) |
| K-4 | **`OPENCLAW_MOBILE_SINGLE_OWNER=1` (F2)** — nyalakan atau tidak | Hanya dihormati bila A1 ON; melewati proyeksi file-lock + asersi lease; pengaman tersisa hanya bind 18789. Aman hanya karena Polones single-owner | Tunda sampai vonis perangkat Fase 0 menunjukkan kasus lock kotor memang terjadi di perangkat user; bila tidak terjadi, F2 tidak dibutuhkan |
| K-5 | **Desain reattach** — ubah urutan `start()` (cek reattach dulu, baru sapu yatim) | Saat ini `start()` menyapu yatim `gateway run` sebelum cek reattach, sehingga reattach praktis tak terjangkau | Ubah urutan (cek reattach dulu) — dengan verifikasi kesehatan sebelum reattach (Fase 2 butir 3–4) |
| K-6 | **Warm-run 7.5** (pertahankan gateway hidup lintas restart aplikasi) | Ditunda dari program percepatan start; terkait Fase 2 | Putuskan bersama K-2 (satu paket "gateway tetap hidup") |
| K-7 | **Bun / esbuild / V8 snapshot** — revisit atau tidak | Ditolak beralasan (§6); hanya bila Bun mencapai paritas + prototipe membuktikan | Jangan revisit sampai ada prototipe (bukan sekadar janji versi Bun baru) |
| K-8 | **Arti `/ready` bila model runtime ditunda** (Fase 4) | Bila model runtime ditunda ke chat pertama, apakah `/ready` tetap berarti "bisa chat" (dengan chat pertama membayar init) atau definisinya diubah | Pertahankan arti `/ready` = "bisa chat" (chat pertama boleh lebih lambat ~2–5 dtk, tetapi harus berhasil — bukan gagal) |

## 11. Referensi

**Dokumen fork (di `~/workspace/openclaw-fork/`):**
- `docs/mobile-fast-boot/DESIGN.md` — desain rombak (F1–F9, A1–A5, D1–D8, N1–N10, §8 status lane)
- `docs/mobile-fast-boot/MEASUREMENT.md` — semua angka LAB (baseline §4, F2 §8, B §9, F §10–11, F4 §12, W1–W3 §7)
- `docs/mobile-fast-boot/F4-AUDIT.md` — ruang lingkup F4 sebenarnya + penyimpangan ON/OFF
- `docs/mobile-fast-boot/W1-W3-CATALOG.md` — jalur katalog, W3 = 0 dtk
- `docs/mobile-fast-boot/F5-A3-PLUGIN-LAZY-PLAN-CACHE.md` — prosedur ukur F5/A3
- `docs/mobile-fast-boot/GUARDRAILS.md`, `REBASE-GUIDE.md`, `BUILD-PUBLISH.md`, `VERIFY.md`, `LANE-F.md`, `D2-PREBUILD-PRUNE.md`
- `FORK-LAPORAN.md` — laporan integrasi fork (status lane, baseline LAB, waiter timeout build)
- `src/gateway/mobile-boot.ts` — saklar + `singleOwner` (seluruh berkas, 145 baris)

**Dokumen riset (di `~/workspace/research-start/`):**
- `RIS-START-OPENC0DE-VS-LAINNYA.md` (655 baris) — laporan utama (OpenCode vs lainnya; "Bun vs Node" ditolak §3.2)
- `per-harness/opencode.md` (686 baris) — urutan boot OpenCode fase demi fase
- `per-harness/openclaw.md` (1.327 baris) — urutan boot OpenClaw + §9 (F1–F9, A1–A5, D1–D8, N1–N10)
- `DESAIN-mobile-fast-boot.md` — sumber desain fork (236 baris)

**Source Polones (di `~/workspace/polones/`):**
- `native/crates/engine/src/harness/plans.rs` — `openclaw_gateway_extras()` (~193; knob P3 241–247; assert ~851–857), `build_launch_plan` (416)
- `native/crates/engine/src/harness/spec_table.rs` — spec OpenClaw (~403–430; `health_url`, `ready_within_ms` 480.000)
- `native/crates/engine/src/harness/env.rs` — `launch_env_base` (72)
- `native/crates/engine/src/harness/argv.rs` — `runtime_build` (90)
- `native/crates/engine/src/harness/mobile_patch.rs` — `command` (71–94)
- `native/crates/supervisor/src/process.rs` — `spawn` (27–46; `env_clear()` 43)
- `scripts/mobile-patch/boot.mjs` (90) + `scripts/mobile-patch/child.mjs` (`gatewayEnv` 75–97; `GATEWAY_ENV_PREFIXES` 53; `spawnChild` 276)
- `harness/openclaw/src/main/java/com/polones/harness/openclaw/OpenClawHarness.kt` — `launchEnv()` (248–302; knob P3 298–300), `GATEWAY_TOKEN_ENV` (326)
- `app/src/main/java/com/polones/app/AppContainer.kt` — `sidecarEnvProvider` (~177; env TUI, bukan gateway)
- `core/runtime/.../EngineHarnessSpec.kt` — `launchPlan` (65–66), `dynamicEnv()` (77–78)
- `tests/contract/openclaw-gateway-env.test.mjs` — daftar knob (~146–164), allowlist `OPENCLAW_*` (340–348)

**Source fork (di `~/workspace/openclaw-fork/src/`):**
- `src/gateway/server-startup-finish.ts` — `http.bound` (198–200), F1 start (212–236), F4(b) (261–275), migration await + ready + late join (538–560)
- `src/gateway/server-startup-bootstrap.ts` — preparations + slot F1 (493–566), `mobileBoot` threading (112–116)
- `src/gateway/server-startup-plugins.ts` — split essential/deferred (407–551), F5 load (585–604), A3 cache (187–229)
- `src/gateway/server-startup-post-attach.ts` — sidecars (311–440), deferred load latar (464–507), F8 (566–580)
- `src/gateway/server-startup-session-migration.ts` + `src/config/sessions/startup-migration.ts` — F1/A4 (watermark 317–336, 366–373, 507–515)
- `src/infra/gateway-lock.ts` — F2 (116, 503–520)
- `src/cli/gateway-cli/run.ts` — resolve saklar (377–378), penegakan F3a (490–499)
- `src/cli/run-main.ts` — `resolveMobileBootOptions` (173)
- `src/entry-gateway.ts` — F6 (282 baris)

**Bukti perangkat:**
- Video user 25 Nov 2026 02:39 WIB (v0.1.120, Xiaomi 12): tile READY ~95 dtk; WebUI skeleton sampai akhir video 135 dtk
- Screenshot Aktivitas user 26 Nov 2026 07:31 WIB (v0.1.124): OpenClaw Memulai 07:28:34 → Berjalan 07:30:14 (~100 dtk)
- Laporan verifikasi APK v0.1.124: `~/workspace/apk-diag/v0.1.124/VERIFICATION.md`

## 12. Revisi sesudah deep-read OpenCode v2.3.2 (adendum — 26 Nov 2026)

> **Status adendum:** STUDI (bukan implementasi). **Perintah pemilik:** 26 Nov 2026 08:58 WIB — user menyetujui clone + baca detail source OpenCode v2.3.2, sesudah menanyakan apakah asisten sudah membaca semua source OpenCode mendetail (jawaban saat itu: BELUM — hanya jalur start via riset `RIS-START-OPENC0DE-VS-LAINNYA.md` dari aset build + sebagian repo). **Basis:** clone `anomalyco/opencode` @ tag `v2.3.2`, commit `c0ad18b402eb2827fc1ee71c171b1177b3fc02d1` (sama persis dengan `sst/opencode`), di `~/workspace/opencode-upstream/` (11.548 berkas, 253 MB). **Metode:** baca-kode saja (tiga lane: A entry+bind, B route/plugin/config/sesi, C model/TUI/proses/biner) — tidak ada build/run/test kode OpenCode. **Laporan lengkap:** `~/workspace/research-start/OPENCODE-DEEP-READ.md` (~66 KB). Adendum ini TIDAK menimpa rencana lama (§0–§11 tetap berlaku); ia mengoreksi asumsi yang salah, memperkuat fase yang sudah tepat, dan menegaskan batas yang baru terbukti. Implementasi TETAP DIHENTIKAN oleh user (08:15 WIB); adendum ini studi + revisi rencana.

### 12.1 Koreksi atas asumsi rencana lama (yang terbukti salah / tidak lengkap sesudah deep-read)

| # | Asumsi rencana lama | Koreksi sesudah deep-read (bukti) | Dampak ke rencana |
|---|---|---|---|
| C-1 | "OpenCode mengikat socket sebelum membangun route" (§1.3, §0.2) — benar secara garis besar, tetapi tidak menyebut mekanisme stub + registrasi dini. | **Ditegaskan + dilengkapi:** OpenCode tidak hanya bind dulu — ia memasang stub `dispatch` yang menjawab `GET /api/info` 503 + `retry-after: 1` saat starting (`process.ts:73–82, 197–199, ~215–230`), menulis file registrasi `service.json` di `onListen` SEBELUM ready (`process.ts:84–90`), dan klien mem-poll `/api/info` tiap 25 ms (`service-timing.ts:24–33`; service terdaftar ~250 ms). Tidak ada endpoint `/health` di OpenCode. | Fase 1 harus mencakup **stub dispatch + registrasi dini + polling**, bukan sekadar "ikat socket dulu". K-3 (opsi b, tile status perantara) selaras dengan ini. |
| C-2 | "Probe OpenCode mengukur bind+shell" (§1.3) — benar, tetapi tidak menyebut bahwa full-ready OpenCode belum pernah terukur. | **Ditegaskan:** "3 detik" adalah bind + stub + shell, BUKAN full-ready. Full-ready OpenCode (sesudah `Layer.build` + migrasi + plugin) **belum pernah terukur** — di perangkat maupun di LAB. Tidak ada angka waktu di kode OpenCode. | Target §0.3 dan §9 tetap — tetapi sekarang terbukti dari source, bukan sekadar dinyatakan. Pengukuran §7 harus memisahkan A(socket)/B(shell) dari A(ready)/B(chat-ready) secara eksplisit. |
| C-3 | Rencana tidak menyebut graf per-Location malas OpenCode. | **Baru:** aktivasi plugin, katalog provider/model, dan session runner OpenCode hanya dibangun saat ada request pertama untuk sebuah direktori (`LocationServiceMap.get`, `location-service-map.ts:13–14`; `instance.ts:60–127`), bukan saat server boot. | Fase 1/5 diperkuat (lihat §12.2 butir 5): pertimbangkan aktivasi plugin per-Location (per-request pertama), bukan hanya "sesudah `http.bound`". Ini pekerjaan lanjutan (butuh refactor) — dicatat sebagai batas di §12.4. |
| C-4 | Rencana menyebut model runtime diinisialisasi saat boot (Fase 4 mengusulkan menundanya) — benar, tetapi tidak menyebut bentuk akhir yang dituju. | **Dibenarkan + dilengkapi:** OpenCode membuat objek `LanguageModel` per step via `ModelResolver` (`model-resolver.ts:230–280`, `session/runner/llm.ts:134`); token OAuth diselesaikan saat eksekusi (`provider.ts:~470`); katalog model adalah snapshot ter-bundle yang di-decode lazy (`models-dev.ts:655–668`). | Fase 4 dibenarkan penuh; bentuk akhirnya kini terdefinisi persis (metadata katalog saat boot, objek model per step, kredensial disuntik saat resolusi). K-8 tetap. |
| C-5 | Rencana menyebut stall katalog 43,5 dtk dan W1/W2 membuatnya malas — benar, tetapi tidak menyebut bahwa OpenCode TIDAK PUNYA katalog yang harus "selesai". | **Ditegaskan:** OpenCode tidak memuat katalog tool/plugin di awal sama sekali; tool diregistrasi plugin saat aktivasi dan dibaca lewat `State` reaktif; `plugin.list` mengembalikan inventory apa adanya (bisa kosong di Location dingin). | Target akhir W1/W2 diperjelas: tidak ada katalog yang harus "selesai" sebelum server bisa dipakai — daftar boleh kosong/parsial dan terisi kemudian. |
| C-6 | Rencana menyebut "Bun vs Node DITOLAK sebagai penjelasan utama" (§1.3) — benar, tetapi tidak menjelaskan mengapa biner Bun tetap penting. | **Ditegaskan + dibedakan:** yang DITOLAK adalah "runtime-nya yang menentukan orde detik" (rantai import OpenCode berat dalam jumlah modul — 18 + 19 + 23 + 58 static import — tetapi hanya definisi + konstruksi Layer tanpa I/O). Yang TETAP PENTING adalah **kemasan**: biner Bun = satu file bytecode (`--smol`), tanpa `node_modules` saat runtime, WebUI + katalog ter-embed (`build.ts`). OpenClaw membayar 519 MB / 32.354 berkas dari disk. | Fase 3 diperjelas (lihat §12.2 butir 6): targetnya "bundle menjadi sedikit berkas besar agar I/O didominasi baca sekuensial"; dan batas struktural (tanpa biner tunggal, parse/load dingin tidak menyamai Bun) dinyatakan eksplisit di §12.4. K-7 tetap (jangan revisit Bun sampai ada prototipe). |
| C-7 | Rencana tidak menyebut `OPENCODE_FAST_BOOT`. | **Klarifikasi:** `OPENCODE_FAST_BOOT` BUKAN flag boot server — hanya menghilangkan overlay loading awal TUI (`app.tsx:383`, `1475–1476`). Jangan dikacaukan dengan `OPENCLAW_MOBILE_BOOT` (saklar fast-boot fork, default OFF). | Tidak ada perubahan rencana; hanya klarifikasi agar tidak ada yang salah mengira OpenCode punya saklar fast-boot yang bisa ditiru. |
| C-8 | Rencana menyebut `process-daemon` tidak relevan (tidak dibahas). | **Ditegaskan:** `packages/process-daemon/` adalah Rust crate `opencode-pty` (daemon PTY persisten), BUKAN server atau TUI, dan tidak ada di jalur boot. | Tidak ada perubahan rencana; hanya menegaskan agar tidak ada yang salah mengira daemon ini bagian dari start cepat OpenCode. |

### 12.2 Pemetaan tiap mekanisme OpenCode ke perubahan konkret di OpenClaw (urutan eksekusi)

| # | Mekanisme OpenCode (bukti) | Perubahan konkret di OpenClaw | Fase | Berkas/area |
|---|---|---|---|---|
| M-1 | **Bind dulu, bangun belakangan** — `listen()` langkah pertama (`process.ts:62`); stub `serve` (`:73–82`); `boot` sesudahnya (`:100–121`). | Pindahkan SELURUH rantai pra-listen ke sesudah `http.bound` (config, DB, model, plugin, sesi, route, Control UI); pasang stub dispatch yang menjawab probe + shell sejak bind. | Fase 1 (inti) | Fork `src/gateway/server-startup-finish.ts` (sekitar `:198` `http.listen` / `:199` `http.bound`), `src/gateway/server/http-listen.ts:52`, `src/cli/gateway-cli/run.ts` |
| M-2 | **Stub probe + registrasi dini** — `GET /api/info` 503 + `retry-after: 1` saat starting (`process.ts:197–199`); `service.json` ditulis di `onListen` sebelum ready (`:84–90`); klien polling 25 ms. | Socket menjawab probe sejak bind (stub 503/starting); tulis penanda/registrasi gateway di `http.bound` (sebelum ready) agar Polones bisa menemukan gateway yang masih starting dan mem-poll; tile tampilkan status perantara (K-3 opsi b). | Fase 1 + Fase 2 | Fork (stub dispatch + registrasi); Polones (probe/tile, K-3) |
| M-3 | **Route dibangun sekaligus sesudah bind, deklaratif; handler per-request** (`routes.ts:102–131, 193–210`; `handlers.ts:34–74`). | Pindahkan pembangunan route Control UI + handler gateway ke sesudah `http.bound`. | Fase 1 | Fork `src/gateway/server-startup-finish.ts`, route Control UI |
| M-4 | **Plugin async per-Location; server tidak menunggu** — hanya 6 endpoint menunggu maks 5 dtk (`location.ts:39–49`); aktivasi pertama saat Location pertama dipakai. | Jangan gerbangi `/ready` pada aktivasi plugin; hanya endpoint model/provider yang menunggu (maks 5 dtk, seperti OpenCode); pertimbangkan aktivasi plugin per-Location (per-request pertama) sebagai pekerjaan lanjutan. | Fase 1/5 (perkuat) | Fork `src/gateway/server-startup-plugins.ts:585–604` (essential/deferred), `src/gateway/server-startup-post-attach.ts:464–507` |
| M-5 | **Tidak ada katalog tool di awal** — tool diregistrasi plugin saat aktivasi; `plugin.list` mengembalikan apa adanya (bisa kosong). | Target akhir W1/W2: tidak ada katalog yang harus "selesai" sebelum server bisa dipakai — daftar boleh kosong/parsial dan terisi kemudian. | (Sudah W1/W2; target diperjelas) | Fork `src/gateway/server-methods/tools-catalog.ts`, `src/gateway/tool-catalog-snapshot.ts`, `ui/src/pages/agents/tools.ts` |
| M-6 | **Config dibaca sesudah bind, ringan; malformed = warning; reaktif sesudahnya** (`config.ts:~393–394`; `discovery.ts:67–168`). | Pindahkan baca + validasi config ke sesudah `http.bound` (tetap exit 78 bila invalid — N5 dipertahankan — tetapi socket sudah terikat dan menjawab 503 sementara itu). | Fase 1 | Fork (config load/validasi di jalur boot) |
| M-7 | **Sesi on-demand; migrasi V1→V2 di fiber background, no-op tanpa tabel legacy; resume hanya klaim yatim** (`v1-migration.bun.ts`; `restart.ts:370–400`). | `/ready` jangan menunggu migrasi selesai; migrasi lanjut di latar sesudah ready; gerbang RPC F1 (tahan `chat.send`/`agent` sampai migrasi selesai) tetap sebagai pengaman. | Fase 5 (perkuat) | Fork `src/gateway/server-startup-finish.ts:538–541` (tunggu migrasi), `src/config/sessions/startup-migration.ts`, `src/gateway/server-startup-bootstrap.ts:502` |
| M-8 | **Model dibuat per step; token OAuth saat eksekusi; katalog snapshot ter-bundle, decode lazy** (`model-resolver.ts:230–280`; `provider.ts:~470`; `models-dev.ts:655–668`). | Tunda init model runtime ke chat pertama (bentuk akhir: metadata katalog saat boot, objek model per step, kredensial disuntik saat resolusi). | Fase 4 | Fork (model runtime init), K-8 |
| M-9 | **Biner Bun tunggal: bytecode, `--smol`, tanpa `node_modules`, WebUI + katalog ter-embed** (`build.ts`). | Bundle `dist/` + `node_modules/` menjadi sedikit berkas besar (baca sekuensial, bukan ribuan open/stat); nyatakan batas struktural (tanpa biner tunggal, parse/load dingin tidak menyamai Bun). | Fase 3 (perjelas) | Fork + build Polones (`scripts/openclaw/build.sh`, packager) |
| M-10 | **TUI proses terpisah; server managed service terlepas (bertahan sesudah TUI keluar) atau anak `--stdio`; discovery via `service.json`; polling 25 ms** (`service.ts`, `service-timing.ts`, `service-probe.ts`). | Prestart/warm-run/reattach (K-2 + K-6 + K-5) — satu-satunya jalan ke "terasa ~3 dtk"; registrasi dini + polling seperti OpenCode. | Fase 2 | Polones (prestart/warm-run/reattach, probe/tile) |
| M-11 | **Entry ringan; handler lazy; server diimpor dinamis hanya saat `serve` dipilih** (`index.ts`, 18 import; `server-process.ts:84`). | Pastikan entry gateway tidak mengimpor graf berat sebelum bind; impor server dinamis hanya saat dibutuhkan. | Fase 1 | Fork `src/entry-gateway.ts`, `openclaw.mjs` |

### 12.3 Revisi target waktu per fase (bila deep-read mengubahnya)

| Fase | Target lama (rencana §0.4/§9) | Target sesudah deep-read | Alasan perubahan |
|---|---|---|---|
| Fase 0 | A ~95 → ~70–85 dtk; B >135 → ~85–110 dtk | **Tidak berubah.** | Deep-read tidak mengubah Fase 0 (hanya menyalakan saklar yang sudah ada). |
| Fase 1 | A (socket) ~5–15 dtk; B (shell) ~10–20 dtk cold | **Tidak berubah angkanya, tetapi definisinya diperjelas:** A(socket) = socket terikat + stub probe menjawab (seperti `/api/info` 503 OpenCode); B(shell) = shell tersaji (bukan `/ready`). Pengukuran harus memisahkan keduanya dari A(ready)/B(chat-ready). | Deep-read membuktikan milestone yang diukur OpenCode adalah bind+stub+shell, bukan full-ready. |
| Fase 2 | B (warm) ~2–5 dtk | **Tidak berubah.** | Deep-read membenarkan: OpenCode mengandalkan managed service + polling 25 ms (service terdaftar ~250 ms) — ini mekanisme yang sama dengan prestart/warm-run. |
| Fase 3 | A (cold) berpotensi ~60–70 dtk | **Tidak berubah angkanya, tetapi targetnya diperjelas:** bukan sekadar "kurangi volume I/O" melainkan "bundle menjadi sedikit berkas besar agar I/O didominasi baca sekuensial". | Deep-read menunjukkan pengali perangkat berasal dari ribuan open/stat (32.354 berkas), bukan sekadar total byte. |
| Fase 4 | `/ready` LAB ~42 → ~30 dtk | **Tidak berubah.** | Deep-read membenarkan Fase 4 (model per step) dan memberi bentuk akhirnya yang persis. |
| Fase 5 | Boot berulang + perangkat bersesi banyak membaik | **Diperkuat:** `/ready` jangan menunggu migrasi (M-7); targetnya kini eksplisit — migrasi lanjut di latar sesudah ready. | Deep-read membuktikan OpenCode tidak menunggu migrasi untuk ready. |
| Fase 6 | Prasyarat klaim apa pun | **Tidak berubah.** | — |
| **Target keseluruhan** | Shell ~3–5 dtk cold + warm ~2–5 dtk (bukan cold penuh 3 dtk) | **Tidak berubah — tetapi kini TERBUKTI dari source, bukan sekadar dinyatakan.** | Deep-read membuktikan OpenCode sendiri tidak full-ready dalam 3 detik; yang 3 detik adalah bind+stub+shell. |

### 12.4 Yang TIDAK bisa disamai (bila ada) dan mengapa — ditegaskan sesudah deep-read

1. **Cold-boot penuh ke chat-ready dalam 3 detik — TIDAK BISA.** Kontrak gateway OpenClaw tidak bisa selesai dalam 3 detik di ponsel; lantainya puluhan detik untuk full-ready. OpenCode sendiri tidak full-ready dalam 3 detik; yang 3 detik adalah bind + stub + shell. (Sudah di §0.3; deep-read ini membuktikannya dari source.)
2. **Waktu parse/load dingin setara biner Bun — TIDAK BISA tanpa kemasan biner tunggal.** OpenCode tidak membayar resolusi modul/`node_modules` saat runtime (satu file bytecode, `--smol`). OpenClaw (Node.js, 519 MB / 32.354 berkas) membayar ribuan open/stat/read dari disk di bawah overhead Groot. Fase 3 mengurangi pengali ini tetapi tidak menghilangkannya. K-7 tetap (jangan revisit Bun sampai ada prototipe) — tetapi batas ini dinyatakan eksplisit di sini, bukan disembunyikan.
3. **Graf per-Location malas penuh — SULIT tanpa refactor arsitektur plugin OpenClaw.** OpenCode membangun graf per-Location (plugin, provider/model, session runner) saat request pertama untuk direktori itu. OpenClaw punya satu gateway dengan satu workspace; memetakan "per-Location" ke "per-workspace/per-agent" butuh refactor yang lebih dalam dari Fase 1/5. Ini pekerjaan lanjutan, bukan bagian Fase 1. Dicatat sebagai utang arsitektur, bukan diabaikan.
4. **Managed service yang terlepas dan bertahan sesudah TUI keluar — BISA, tetapi butuh Fase 2.** OpenCode melakukannya via `Service.ensure` + `service.json` + `child.unref()`. Polones bisa menirunya (prestart/warm-run/reattach, K-2 + K-6 + K-5), tetapi itu pekerjaan Polones (bukan fork) dan butuh guard RAM + kebijakan restart gateway hangat.

### 12.5 Catatan keamanan / batas studi

- Studi ini baca-kode saja (clone + `muse.read`/`grep`). Tidak ada build, run, install, atau test kode OpenCode. Clone `~/workspace/opencode-upstream/` (253 MB) dipertahankan sebagai referensi; jangan jalankan isinya tanpa otorisasi terpisah.
- Isi clone sempat memicu pemeriksaan risiko eksekusi pada hasil tool (peringatan sistem) — karena itu studi ini dibatasi pada pembacaan teks berkas (yang diizinkan) dan tidak menjalankan, mengimpor, atau memuat kode clone tersebut dengan cara apa pun.
- Ambigu yang dicatat (bukan ditebak): (a) apakah syscall TCP `listen()` terjadi di `NodeHttpServer.make()` atau di `.serve()` (library Effect tidak ada di clone); (b) apakah graph Location pertama ikut dibangun saat `Layer.buildWithScope(createRoutes(...))` atau baru pada request pertama; (c) apakah `Model`/`Provider` layer memanggil `snapshot()`/`read()` secara eager di suatu tempat saat build (tidak ada pemanggilan eager yang terlihat di sekitar titik fork, tetapi kedua berkas tidak dibaca baris demi baris seluruhnya); (d) pemicu persis kapan biner `process-daemon` (opencode-pty) pertama kali di-spawn; (e) kapan persis file config server dibaca (saat `Layer.buildWithScope` atau lazy saat `get()` pertama).

---

*Dokumen ini adalah rencana (planning dulu, atas perintah pemilik 26 Nov 2026). Tidak ada implementasi yang dilakukan bersamaan dengan dokumen ini. Implementasi dimulai hanya sesudah rencana disetujui (K-1) + perintah push/eksekusi eksplisit pemilik untuk tiap fase yang menyentuh `main`.*
