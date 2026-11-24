# REBASE-GUIDE — Panduan Rebase Fork ke Rilis Upstream (untuk AI Agent)

> **Status:** panduan operasional fork `mobile-fast-boot`.
> **Basis fork:** `openclaw/openclaw` @ tag `v2026.11.6` (commit
> `06afb10d3272cc9deaf38ca6a3b7b839d5935638`).
> **Branch fork:** `mobile-fast-boot` (repo lokal `~/workspace/openclaw-fork/`);
> lane kerja di `~/workspace/openclaw-fork-lanes/lane-h/` branch `lane-h/docs`.
> **Baca dulu:** `DESIGN.md` (§0–§8) + `GUARDRAILS.md` (N1–N10) +
> `~/workspace/research-start/per-harness/openclaw.md` §9.1–§9.6.
> **Bahasa dokumen ini:** Indonesia. Semua perintah dijalankan dari
> worktree fork, kecuali dinyatakan lain.

## 0. Fakta remote yang harus diketahui sebelum mulai

| Fakta | Nilai (terverifikasi 25 Nov 2026) |
|---|---|
| Remote `origin` di worktree ini | `https://github.com/openclaw/openclaw.git` — **itu UPSTREAM, bukan fork** |
| Remote fork (`ngabzar05/openclaw`) | **BELUM ADA** — pembuatan via web gagal 403 ("Must have admin rights", akun `azqifaiq02`); remote fork harus dibuat pemilik (fork via web ke org, atau repo kosong + push). Sampai ada, fork hanya hidup lokal |
| Akibatnya | **JANGAN PERNAH `git push origin`** — itu mendorong ke upstream. Semua pekerjaan fork tetap lokal sampai pemilik memberi remote fork + perintah push eksplisit |
| Tag basis | `v2026.11.6` → `06afb10d`. Verifikasi: `git rev-parse v2026.11.6` harus mencetak `06afb10d3272cc9deaf38ca6a3b7b839d5935638` |
| Skema rilis upstream | CalVer, cepat (ada beta `2026.11.5-beta.1` dua minggu sebelum `2026.11.6`). Harapkan rebase tiap rilis |

## 1. Mengambil tag upstream baru + membuat branch rebase

### 1.1 Prasyarat

1. Worktree bersih: `git status --short` harus kosong. Bila ada perubahan
   belum commit, commit dulu (Conventional Commits) atau `git stash` —
   jangan rebase dengan worktree kotor.
2. Catat posisi fork sekarang:
   `git log --oneline -3 mobile-fast-boot` dan
   `git rev-parse mobile-fast-boot`.
3. Pastikan tidak ada lane lain yang sedang memakai worktree bersama
   (`~/workspace/openclaw-fork-lanes/*/`) — rebase mengubah history
   branch; lane lain harus diberitahu koordinator.

### 1.2 Ambil tag baru

```sh
cd ~/workspace/openclaw-fork-lanes/lane-h   # atau repo fork ~/workspace/openclaw-fork
git fetch origin --tags --prune
git tag --list 'v2026.*' --sort=-v:refname | head -5
```

Pilih tag rilis stabil terbaru (bukan `-beta`, bukan `-rc`, kecuali
pemilik memerintahkan). Contoh di bawah memakai `v2026.11.7` sebagai
placeholder — **ganti dengan tag nyata yang tertera di output**.

Verifikasi tag sebelum dipakai:

```sh
git rev-parse v2026.11.7^{commit}
git log --oneline -1 v2026.11.7
```

Bila tag tidak ada di output `git tag`, JANGAN menebak namanya —
tanyakan ke koordinator/pemilik.

### 1.3 Buat branch rebase

```sh
git checkout mobile-fast-boot
git checkout -b rebase/v2026.11.7
git rebase v2026.11.7
```

Bila `git rebase` berhenti di konflik, JANGAN `git rebase --abort`
secara refleks dan JANGAN `git rebase --skip` tanpa membaca konfliknya.
Lanjut ke §2: selesaikan konflik per berkas, lalu `git add <berkas>`
dan `git rebase --continue`. Ulangi sampai rebase selesai.

Bila rebase terbukti tidak bisa diselamatkan (mis. upstream merombak
total berkas yang disentuh fork — lihat §5), jalankan
`git rebase --abort` dan laporkan ke koordinator dengan daftar konflik
yang ditemui. Branch `rebase/v2026.11.7` yang gagal DIBIARKAN apa adanya
(jangan dihapus) sebagai bukti.

## 2. Berkas yang disentuh fork + cara menangani konflik di masing-masing

**Prinsip umum (berlaku untuk semua berkas di bawah):**

- Diff fork vs upstream dihitung di **`src/`**, bukan di `dist/` —
  chunk `dist/` ber-hash (`gateway-lock-DxbXf4bl.mjs`, …) berubah total
  tiap build; jangan pernah menyelesaikan konflik di `dist/`
  (lihat GUARDRAILS.md: patch-ke-`dist` dilarang).
- **Pertahankan dari fork:** semua perilaku di belakang saklar
  `OPENCLAW_MOBILE_BOOT=1` (A1) dan `OPENCLAW_MOBILE_SINGLE_OWNER=1`
  (F2) — termasuk cabang `if (mobileBoot)` / `MobileBootOptions`,
  gerbang RPC F1, fast-path lock F2, capture async F5, cache A3/W2,
  watermark A4.
- **Ambil dari upstream:** perbaikan bug, perbaikan keamanan, perubahan
  API internal yang tidak terkait boot, dan SEMUA perubahan di luar
  blok yang ditandai fork. Bila upstream memindahkan fungsi yang
  dipakai fork ke berkas lain, ikuti pemindahan itu (perbarui import
  fork), jangan mengembalikan struktur lama.
- **Tandai blok fork:** setiap perubahan fork di `src/` WAJIB dibungkus
  komentar penanda (bila belum ada, tambahkan saat menyelesaikan
  konflik):
  `// FORK mobile-fast-boot: <F/A-nomor> — <satu kalimat alasan>`.
  Tanpa penanda, rebase berikutnya tidak bisa membedakan kode fork
  dari kode upstream.
- Sesudah tiap konflik selesai, jalankan typecheck cepat atas berkas
  itu bila memungkinkan (`pnpm check` penuh hanya di §4 — terlalu
  lambat untuk tiap konflik).

### 2.1 `src/infra/gateway-lock.ts` — F2 (risiko konflik: TINGGI)

- Fungsi: `acquireGatewayLock`.
- **Pertahankan dari fork:** tiga lapis F2, semuanya di belakang
  `OPENCLAW_MOBILE_SINGLE_OWNER=1` (default OFF):
  (a) lewati proyeksi file-lock + asersi lease (`acquireFileLockSync`
  atas `gateway.state.lock`, `assertGatewayOwnerLeaseStopped`);
  (b) deadline contention `GATEWAY_LIFECYCLE_LOCK_TIMEOUT_MS`
  300 dtk → 30 dtk; (c) bukti kematian lemah
  (`isPidDefinitelyDead`: kill ESRCH + `/proc/<pid>/status` hilang)
  cukup untuk reklamasi meski namespace `"unknown"`.
- **Ambil dari upstream:** perubahan konstanta timeout lain, pesan
  error baru, perbaikan klasifikasi namespace, perubahan struktur
  `GatewayLockError`.
- **Perhatian khusus:** berkas ini "aktif berubah" di upstream
  (openclaw.md §9.5). Bila upstream mengubah SIGNATUR
  `acquireGatewayLock` atau memindahkan logika lock ke berkas baru,
  adaptasi fork mengikuti signatur baru — jangan mempertahankan
  signatur lama. Bila upstream MENAMBAH lapisan lock keempat,
  lapis itu tetap jalan di mode fork KECUALI bila ia menggandakan
  lapis (a) — bila ragu, BERHENTI (lihat §5, N4).

### 2.2 `src/infra/gateway-state-owner.ts` — F2

- Fungsi: `classifyGatewayLockProcessNamespace`,
  `GATEWAY_OWNER_HEARTBEAT_STALE_MS`.
- **Pertahankan dari fork:** apa pun yang ditambahkan F2 untuk
  klasifikasi namespace di mode single-owner.
- **Ambil dari upstream:** perubahan heartbeat, format record owner,
  perbaikan `GatewayLockNamespaceError`.
- **Perhatian khusus:** perubahan upstream di sini sering berpasangan
  dengan `gateway-lock.ts` — selesaikan kedua berkas sebagai satu
  unit, jangan setengah-setengah.

### 2.3 `src/shared/pid-alive.ts` — F2

- Fungsi: `resolveGatewayOwnerStatusSync`, `isPidDefinitelyDead`.
- **Pertahankan dari fork:** penerimaan bukti kematian lemah hanya
  dalam mode single-owner.
- **Ambil dari upstream:** perbaikan pembacaan `/proc/<pid>/*`
  (start-time, cmdline), dukungan platform baru.
- **Perhatian khusus:** JANGAN melonggarkan `isPidDefinitelyDead`
  di jalur umum (di luar mode single-owner) — itu N4. Bila upstream
  MEMPERKETAT fungsi ini, ambil pengetatan itu dan pastikan cabang
  fork tetap berada di dalam `if (mobileSingleOwner)`.

### 2.4 `src/gateway/server-startup-session-migration.ts` — F1

- Fungsi: `prepareGatewayStartupSessions`.
- **Pertahankan dari fork:** pemindahan pemanggilan keluar dari
  `Promise.allSettled(z)` pra-listen menjadi pekerjaan
  pasca-`http.bound`, paralel dengan `runtime.post-attach`, PLUS
  gerbang RPC yang menahan `chat.send`/`agent` sampai migrasi
  selesai (gerbang per-RPC, bukan per-proses).
- **Ambil dari upstream:** langkah migrasi baru, perbaikan validasi
  sesi, perubahan urutan langkah di DALAM migrasi (bukan posisi
  pemanggilannya).
- **Perhatian khusus:** bila upstream memindahkan pemanggilan ini ke
  lokasi pra-listen yang BARU (mis. restrukturisasi `gateway-prewarm`),
  pindahkan lagi ke pasca-`http.bound` — posisi pasca-listen adalah
  inti F1. Bila gerbang RPC fork tidak lagi tersambung karena upstream
  mengubah jalur `chat.send`, BERHENTI (N6 — migrasi tanpa gerbang
  = agen membaca sesi setengah-migrasi).

### 2.5 `src/config/sessions/startup-migration.ts` — F1 + A4

- Fungsi: `runSessionStartupMigration`.
- **Pertahankan dari fork:** watermark A4 (revisi migrasi terakhir di
  state sqlite; hanya sesi berubah sejak watermark yang dimigrasi
  penuh; sisanya `assertExistingDatabaseIdentity`) + aturan
  "watermark ditulis hanya sesudah migrasi penuh berhasil; skema
  naik → reset → migrasi penuh".
- **Ambil dari upstream:** langkah migrasi sesi baru, perubahan
  skema, perbaikan `assertExistingDatabaseIdentity`.
- **Perhatian khusus — SELISIH NAMA BERKAS YANG TERCATAT:**
  openclaw.md §9.1 F1 menulis jalur ini sebagai
  `src/gateway/startup-migration.ts`, sedangkan DESAIN §2.1 dan
  worktree (`src/config/sessions/startup-migration.ts`, terverifikasi
  ada 25 Nov 2026) memakai `src/config/sessions/startup-migration.ts`.
  **Yang benar adalah yang ada di worktree pada tag yang di-rebase.**
  Saat rebase, periksa dengan `ls src/config/sessions/startup-migration.ts
  src/gateway/startup-migration.ts` di tag baru dan ikuti lokasi
  upstream yang baru; bila upstream memindahkannya, pindahkan kode
  fork mengikutinya dan perbarui DESAIN §2.1 + dokumen ini.

### 2.6 `src/plugins/plugin-generation-worker.ts` — F5

- Fungsi: `preparePluginGenerationArtifact`.
- **Pertahankan dari fork:** `requestSync` → `request` (async) selama
  boot; cache artefak capture di `captures/` antar boot.
- **Ambil dari upstream:** perbaikan worker, perubahan format artefak
  capture, perbaikan `request()` async itu sendiri.
- **Perhatian khusus:** berkas ini berubah antar beta upstream
  (issue #160959). Bila upstream SUDAH mengganti `requestSync`
  dengan async secara bawaan, maka bagian (a) F5 menjadi redundan —
  HAPUS cabang fork itu (jangan mempertahankan kode mati) dan catat
  di commit message rebase. Bila upstream mengubah format artefak
  capture, invalidasi cache `captures/` fork (naikkan versi cache)
  — jangan membaca artefak format lama.

### 2.7 `src/gateway/server-startup-plugins.ts` — F5

- Fungsi: `loadGatewayStartupPluginRuntime`.
- **Pertahankan dari fork:** hanya provider model terkonfigurasi +
  `memory-core` yang dimuat saat boot; sisanya lazy pada pemakaian
  pertama.
- **Ambil dari upstream:** plugin startup baru, perubahan urutan load,
  perbaikan error handling.
- **Perhatian khusus:** lazy load HARUS tetap menghormati
  `plugins.deny` (N7). Bila upstream mengubah cara `plugins.deny`
  dievaluasi, pastikan cabang fork memanggil evaluator yang baru —
  jangan menyalin logika deny lama ke dalam fork.

### 2.8 `src/gateway/server-startup-post-attach.ts` — F5

- Fungsi: `plugins.runtime-post-bind` (= `loadStartupPlugins()`).
- **Pertahankan dari fork:** capture async + lazy runtime pasca-attach.
- **Ambil dari upstream:** langkah post-attach baru.
- **Perhatian khusus:** fail-closed per plugin (plugin gagal = plugin
  itu mati, Gateway tetap hidup) harus dipertahankan; bila upstream
  mengubah semantik error post-attach menjadi fail-open diam,
  pertahankan fail-closed fork dan catat selisihnya di commit message.

### 2.9 `src/gateway/server-startup-early.ts` — F4

- Fungsi: `startGatewayEarlyRuntime` (discovery, lazy-runtime-imports,
  skills-listener).
- **Pertahankan dari fork:** pemindahan `runtime.early` seluruhnya ke
  pasca-`/health`-200 — HANYA bila F9 sudah membuktikan `/health`
  digerbangi `runtime.early` (lihat VERIFY.md; status saat dokumen
  ini ditulis: [BELUM TERUKUR — diisi Lane A/G]).
- **Ambil dari upstream:** langkah early-runtime baru.
- **Perhatian khusus:** bila F9 membuktikan `/health` TIDAK digerbangi
  `runtime.early`, maka bagian (b) F4 tidak berhemat dan TIDAK BOLEH
  dipertahankan sebagai "optimasi" — hapus pemindahan itu pada rebase
  dan catat alasannya.

### 2.10 `src/gateway/server-startup-bootstrap.ts` + `src/cli/run-main.ts` — A1 + F8

- A1: baca env `OPENCLAW_MOBILE_BOOT=1` sekali, teruskan sebagai
  `MobileBootOptions` ke lock/admission/plugin loader.
- F8: hapus jalur update-admission (`tryRunUpdateAdmissionBeforeStartup`,
  `run-main-update-admission-*.mjs`, `update-startup-*.mjs`).
- **Pertahankan dari fork:** saklar tunggal A1 + penghapusan jalur
  update.
- **Ambil dari upstream:** perintah CLI baru, perubahan parsing argv,
  perbaikan bootstrap lain.
- **Perhatian khusus:** bila upstream MENAMBAH env/config baru yang
  bertabrakan nama dengan `OPENCLAW_MOBILE_BOOT` atau
  `OPENCLAW_MOBILE_SINGLE_OWNER`, BERHENTI (§5) — tabrakan nama env
  adalah perubahan perilaku diam-diam.

### 2.11 `src/plugins/gateway-startup-plugin-loader.ts` — A3

- Fungsi: `loadGatewayStartupPluginPlanWithMetadata`.
- **Pertahankan dari fork:** simpan rencana ke
  `<stateDir>/cache/startup-plugin-plan.json` (hash config + versi
  fork); lewati discovery bila hash cocok.
- **Ambil dari upstream:** perubahan resolusi aktivasi plugin.
- **Perhatian khusus:** naikkan **versi fork di dalam cache key**
  pada tiap rebase — cache dari build fork LAMA tidak boleh dibaca
  oleh build fork BARU (format rencana bisa berubah diam-diam).
  Invalidasi bila `openclaw.json` / `dist/extensions/` berubah.

### 2.12 `src/entry-gateway.ts` — F6 (berkas BARU fork)

- Entry khusus gateway (hanya: launcher compile-cache, trace,
  `run-main` jalur gateway, `gateway-prewarm.js`).
- **Pertahankan dari fork:** seluruh berkas.
- **Ambil dari upstream:** bila upstream mengubah `entry.js` /
  `run-main.js` yang diimpor ulang oleh entry ini, sesuaikan import
  dan urutannya; entry gateway mengimpor ulang modul yang sama,
  hanya urutannya yang beda — dua entry harus dijaga sepakat.
- **Perhatian khusus:** bila upstream MEMECAH `run-main.js` atau
  mengubah nama ekspor yang dipakai entry ini, perbaiki import
  fork; jangan menyalin isi `run-main.js` lama ke dalam fork.

### 2.13 Berkas fase WebUI (W1/W2/W3) — katalog malas + cache snapshot

- Titik: `ensureStandalonePluginToolRegistryLoaded` + endpoint
  katalog tool (`dist/tool-catalog-*.mjs` di build; sumbernya di
  `src/` — cari lewat penanda `//#region src/...` di chunk hasil
  build, jangan ditebak) + cache snapshot
  `<stateDir>/cache/tool-catalog.json`.
- **Pertahankan dari fork:** katalog dimuat malas di latar sesudah
  shell tampil; UI membaca snapshot dulu, validasi di latar bila
  hash config berubah; fail-open untuk tampilan, fail-closed untuk
  eksekusi tool yang katalognya belum ada.
- **Ambil dari upstream:** perubahan format katalog, endpoint baru.
- **Perhatian khusus:** jangan pernah memalsukan katalog (N7 +
  GUARDRAILS.md W1–W3). Bila upstream mengubah struktur katalog
  sehingga snapshot lama tidak cocok, invalidasi snapshot
  (naikkan versi cache) — jangan memaksa baca format lama.

### 2.14 Berkas yang TIDAK disentuh fork — bila konflik muncul di sana

Bila `git rebase` melaporkan konflik di berkas yang TIDAK ada di
daftar §2.1–§2.13, itu hampir selalu berarti upstream merombak area
yang bersinggungan dengan fork (mis. restrukturisasi `gateway-prewarm`
atau pemindahan modul). Jangan selesaikan dengan "ambil versi kami"
atau "ambil versi mereka" secara membabi buta:

1. Baca diff upstream atas berkas itu (`git log -p v2026.11.6..v2026.11.7
   -- <berkas>`).
2. Tentukan apakah perubahan upstream menyentuh SEMANTIK yang dipakai
   fork (posisi listen, urutan migrasi, arti `/health`/`/ready`,
   evaluator `plugins.deny`, format cache).
3. Bila ya dan tidak jelas cara menggabungkannya → BERHENTI (§5).
   Bila tidak → ambil versi upstream apa adanya.

## 3. Sesudah konflik selesai — daftar periksa rebase

Jalankan SELURUH daftar ini sebelum branch rebase dinyatakan selesai.
Satu item gagal = rebase BELUM selesai.

- [ ] `git rebase --continue` selesai tanpa konflik tersisa;
  `git status --short` kosong.
- [ ] `git log --oneline v2026.11.7..rebase/v2026.11.7` hanya berisi
  commit fork (A1/F1/F2/F3/F4/F5/F6/F8/F9/A3/A4/W1–W3/D2) — tidak ada
  commit upstream yang terselip sebagai commit fork, dan tidak ada
  commit fork yang hilang. Bandingkan jumlahnya dengan
  `git log --oneline v2026.11.6..mobile-fast-boot` sebelum rebase.
- [ ] Semua blok fork masih berpenanda
  `// FORK mobile-fast-boot: <F/A-nomor>` — cek dengan
  `grep -rn "FOR [A-Z]" src/ | grep -i fork` (sesuaikan pola
  dengan penanda yang dipakai lane implementasi; bila penanda
  belum ada, tambahkan sekarang).
- [ ] `grep -rn "OPENCLAW_MOBILE_BOOT" src/` menemukan saklar A1;
  `grep -rn "OPENCLAW_MOBILE_SINGLE_OWNER" src/` menemukan F2.
- [ ] Versi cache fork dinaikkan: string versi di key cache A3
  (`startup-plugin-plan.json`) dan W2 (`tool-catalog.json`)
  menyebut tag upstream BARU (bukan `2026.11.6` lagi).
- [ ] Tidak ada perubahan di `dist/` yang ter-commit
  (`git status --short dist/` kosong — `dist/` adalah hasil build,
  bukan sumber).
- [ ] Tidak ada perubahan di luar cakupan fork (cek
  `git diff --stat v2026.11.7..rebase/v2026.11.7` — bila muncul
  berkas di luar §2, kembalikan).

## 4. Verifikasi sesudah rebase

Urutannya WAJIB seperti di bawah — jangan melompat ke smoke boot
sebelum build lolos.

### 4.1 Build fork

Lihat `BUILD-PUBLISH.md` §1–§2 untuk perintah persis. Ringkasnya:

```sh
~/.local/bin/pnpm install
~/.local/bin/pnpm build
```

Build HARUS lolos bersih (typecheck + lint + Rollup). Bila gagal,
baca error-nya: kegagalan typecheck sesudah rebase hampir selalu
berarti signatur upstream berubah dan adaptasi fork di §2 belum
lengkap — kembali ke §2, jangan menambal dengan `as any` atau
`@ts-nocheck` (dilarang AGENTS.md fork).

### 4.2 Test saklar OFF = upstream murni (N10)

Boot fork dengan saklar OFF dan bandingkan perilakunya dengan
upstream murni pada tag yang sama:

```sh
# Tanpa OPENCLAW_MOBILE_BOOT (OFF): perilaku harus identik dengan
# upstream v2026.11.7 murni, kecuali nomor versi.
openclaw --version
```

Jalankan suite test upstream yang menyentuh area fork
(`pnpm test` atas proyek yang relevan — lihat `docs/help/testing/suites.md`
di repo fork). Test upstream HARUS lolos dengan saklar OFF. Bila ada
test upstream yang gagal HANYA di fork (bukan di checkout upstream
murni), rebase membawa regresi — cari penyebabnya sebelum lanjut.

### 4.3 Smoke boot sampai `/health` 200

Ukur definisi A (lihat VERIFY.md §1–§2): spawn Gateway fork
(saklar ON, env Polones) → poll `GET /health` sampai 200 pertama.
Kriteria lolos:

- `/health` 200 tercapai (bukan timeout `readyWithinMs` 480 dtk).
- `/ready` 200 HANYA sesudah post-attach (jangan terima `/ready`
  200 yang datang bersamaan dengan `/health` pertama — itu sinyal
  readiness palsu atau gerbang yang rusak).
- Tidak ada `GatewayLockError` pada boot bersih, dan tidak ada
  korupsi state (bandingkan `state/openclaw.sqlite` sebelum/sesudah
  — bila ada karantina baru, selidiki).

### 4.4 Suite kontrak Polones

Jalankan suite kontrak Polones yang menyentuh OpenClaw
(openclaw 16/16, gateway-env 7/7, launcher 4/4 — angka dari
openclaw.md §9.5; nama/jumlah test mengikuti repo Polones saat
rebase — bila jumlah berubah, pakai jumlah yang berlaku saat itu
dan catat). Suite HARUS hijau penuh.

### 4.5 Test fork sendiri

| Test | Perintah / cara | Kriteria lolos |
|---|---|---|
| F1 gerbang RPC | Boot dengan state berisi sesi lama → `/health` 200 cepat → kirim `chat.send` pertama | `chat.send` ditahan sampai migrasi selesai, lalu benar (transkrip/identitas DB cocok); TIDAK BOLEH membaca sesi setengah-migrasi |
| F2 dua-Gateway | Jalankan dua proses Gateway bersamaan dengan `OPENCLAW_MOBILE_SINGLE_OWNER=1` | Yang kedua HARUS exit `GatewayLockError` (via bind eksklusif 18789), bukan korupsi state |
| F5 fail-closed per plugin | Boot dengan satu plugin yang capture-nya dibuat gagal | Plugin itu mati, Gateway tetap hidup; plugin TIDAK termuat diam-diam belakangan; `plugins.deny` tetap dihormati |

Bila salah satu test fork belum ada (lane implementasi belum
menulisnya), tulis sebagai [BELUM ADA — dibuat Lane <X>] di laporan
rebase dan JANGAN mengklaim verifikasi lengkap.

### 4.6 Ukur ulang baseline LAB

Ukur definisi A + B atas fork hasil rebase (prosedur di VERIFY.md)
dan bandingkan dengan baseline fork SEBELUM rebase (bukan dengan
upstream murni — rebase bukan optimasi). Regresi >10% pada definisi
A tanpa penjelasan (mis. upstream menambah fase boot baru) =
selidiki sebelum merge branch rebase ke `mobile-fast-boot`.

## 5. Kapan BERHENTI dan bertanya ke pemilik

**BERHENTI** (jangan putuskan sendiri, jangan lanjut rebase) bila
salah satu terjadi. Laporkan ke koordinator/Lead dengan: tag
upstream, berkas yang berkonflik, kutipan diff upstream yang
relevan, dan apa yang sudah dicoba.

1. **Konflik di N1–N10** (GUARDRAILS.md §1): upstream mengubah auth
   Gateway/Control UI (N1), bind 18789 (N2), format/integritas
   state sqlite (N3), invarian lock (N4), validasi config/exit 78
   (N5), migrasi sesi (N6), semantik `plugins.deny` (N7), lantai
   runtime Node (N8), arti `/health`/`/ready` (N9), atau perilaku
   default (N10) dengan cara yang memaksa fork mengubah guardrail.
2. **Upstream mengubah arti `/health`/`/ready`**: mis. `/health`
   kini berarti readiness, `/ready` dihapus, atau `h.mark("ready")`
   dipindah sebelum post-attach. Ini mengubah kontrak yang dipakai
   Polones untuk menampilkan READY — hanya pemilik yang boleh
   memutuskan adaptasinya.
3. **Upstream menyentuh saklar A1**: tabrakan nama env
   (`OPENCLAW_MOBILE_BOOT` / `OPENCLAW_MOBILE_SINGLE_OWNER` dipakai
   upstream dengan arti lain), atau upstream menambah profil boot
   sendiri yang tumpang tindih dengan A1.
4. **Upstream merombak total `gateway-prewarm` / jalur listen**:
   F4 bergantung pada titik pisah graf-listen vs graf-sisa; bila
   titik pisah itu hilang (mis. upstream sudah early-listen sendiri
   atau mengganti arsitektur listen), F4 harus dirancang ulang —
   itu keputusan desain, bukan rebase rutin.
5. **Upstream sudah mengimplementasikan F1/F2/F5 secara bawaan**:
   ini kabar baik, tetapi penghapusan kode fork yang bersangkutan
   + penyesuaian test adalah keputusan cakupan — laporkan dulu,
   jangan hapus diam-diam.
6. **Test upstream gagal di fork dengan saklar OFF** dan penyebabnya
   bukan adaptasi §2 yang terlewat, melainkan perubahan perilaku
   upstream yang disengaja.
7. **Dua rilis tertinggal**: bila fork sudah tertinggal ≥2 rilis
   upstream, JANGAN rebase sekali lompat dua rilis tanpa
   persetujuan — tiap rilis di-rebase satu per satu (§1–§4) atau
   pemilik memutuskan fork ditinggalkan (openclaw.md §9.5c:
   fork tertinggal dua rilis lebih berbahaya daripada upstream
   murni).

## 6. Checklist per rilis (salin ke laporan rebase)

```text
Rebase fork mobile-fast-boot: v2026.11.6 -> v< BARU >
Tanggal: ............  Agen: ............
- [ ] Tag baru diambil + diverifikasi (§1.2)
- [ ] Branch rebase/v< BARU > dibuat dari mobile-fast-boot (§1.3)
- [ ] Konflik per berkas diselesaikan mengikuti §2.1-§2.14
      (tuliskan berkas yang berkonflik: ...........................)
- [ ] Daftar periksa §3 lolos (blok fork berpenanda, versi cache naik,
      tidak ada perubahan dist/ di luar cakupan)
- [ ] pnpm install && pnpm build lolos (§4.1)
- [ ] Test upstream saklar OFF lolos (§4.2)
- [ ] Smoke boot /health 200 + /ready jujur (§4.3)
- [ ] Suite kontrak Polones hijau (§4.4)
- [ ] Test fork F1 / F2 / F5 lolos (§4.5)
- [ ] Baseline LAB A/B diukur ulang, tanpa regresi >10% (§4.6)
- [ ] Branch rebase di-merge ke mobile-fast-boot (fast-forward /
      merge commit — JANGAN push ke origin; push hanya ke remote
      fork bila sudah ada + ada perintah push eksplisit)
- [ ] DESAIN.md §8 + dokumen ini diperbarui (tag basis baru, tanggal)
```

## 7. Referensi

- `DESIGN.md` §2 (daftar perubahan per berkas), §3 (N1–N10), §6
  (beban maintenance: 0,5–1 hari kerja per rilis ringan).
- `GUARDRAILS.md` §1 (N1–N10 + alasan), §2 (aturan berhenti).
- `BUILD-PUBLISH.md` (build + re-pin sesudah rebase).
- `VERIFY.md` (definisi A/B + prosedur ukur).
- `~/workspace/research-start/per-harness/openclaw.md` §9.5 (beban
  maintenance), §9.6 (urutan), §9.1–§9.4 (F/A/D/N).
