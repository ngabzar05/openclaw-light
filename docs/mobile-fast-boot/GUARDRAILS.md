# GUARDRAILS — Yang Tidak Boleh Diubah/Dihapus + Aturan Berhenti

> **Status:** dokumen pengaman fork `mobile-fast-boot`.
> **Basis fork:** `openclaw/openclaw` @ tag `v2026.11.6` (commit `06afb10d`).
> **Sumber:** `DESIGN.md` §3 (N1–N10) + `~/workspace/research-start/per-harness/openclaw.md`
> §9.4 (N1–N10), §9.1 (F7/F8), §9.2 (A2/A5), §9.3 (D1–D8), §10.
> **Sifat dokumen ini:** NORMATIF. Bila ada konflik antara dokumen ini
> dan ide optimasi apa pun (termasuk dari lane lain), dokumen ini yang
> menang sampai pemilik memutuskan sebaliknya secara eksplisit.
> Semua bagian berbahasa Indonesia.

## 0. Cara membaca dokumen ini

- **N1–N10** (§1) adalah guardrail: fungsi/perilaku yang HARUS
  dipertahankan apa pun yang terjadi. Melanggar salah satunya =
  fork rusak, bukan fork cepat.
- **Aturan berhenti** (§2): kondisi yang memaksa agen BERHENTI dan
  melapor, bukan memutuskan sendiri.
- **Daftar larangan** (§3): ide yang sudah diputuskan DITOLAK beserta
  alasan penolakannya — supaya tidak ada yang mengusulkan ulang.
- Setiap butir mencantumkan **mengapa ada** dan **apa yang rusak bila
  dilanggar** — alasan itu bagian dari guardrail, bukan hiasan:
  agen rebase berikutnya harus bisa menilai apakah suatu perubahan
  upstream menyentuh alasan tersebut.

## 1. N1–N10 — yang dipertahankan

### N1 — Auth Gateway + Control UI

**Yang dipertahankan:** `gateway.auth` (mode token/password),
`OPENCLAW_GATEWAY_TOKEN`, device-identity + origin check Control UI,
token sebagai fragment `#token=`.

**Mengapa ada:** Gateway melayani agen + seluruh riwayat chat lewat
HTTP loopback (port 18789/18790). Tanpa auth, siapa pun yang mencapai
port itu punya akses penuh ke agen dan riwayat (temuan D-05 di riset
Polones). Token datang dari SecretStore Polones, tidak pernah ditulis
ke `openclaw.json` (`plans.rs:191-192`, `OpenClawHarness.kt`).

**Apa yang rusak bila dilanggar:** akses tanpa autentikasi ke agen
pengguna — kebocoran riwayat chat, eksekusi tool tanpa izin, dan
pembatalan keputusan keamanan D-05 (Bearer gate loopback). Fork yang
melemahkan ini tidak boleh diterbitkan, secepat apa pun boot-nya.

### N2 — Bind eksklusif TCP 18789

**Yang dipertahankan:** satu proses Gateway mengikat port 18789
secara eksklusif; bind gagal = start gagal.

**Mengapa ada:** penjaga terakhir single-owner. F2 (fast-path lock)
sengaja melemahkan lock file/sqlite dengan mengandalkan jaminan
eksklusivitas dari Polones — bila jaminan itu gagal, bind eksklusif
adalah satu-satunya yang mencegah dua Gateway hidup bersamaan.

**Apa yang rusak bila dilanggar:** mengganti bind eksklusif dengan
`SO_REUSEPORT` bersama atau "deteksi lewat HTTP" menghilangkan
penjaga terakhir itu. Dua Gateway yang hidup bersamaan akan menulis
`state/openclaw.sqlite` bersamaan tanpa lock → korupsi state
(lihat N4). Tanpa N2, F2 DILARANG (openclaw.md §9.1 F2).

### N3 — State dir + integritas SQLite

**Yang dipertahankan:** `OPENCLAW_STATE_DIR`, `state/openclaw.sqlite`,
agent DB, `state-snapshot`, migrasi skema (`schemaVersions` state 36 /
agent 38, `package.json`).

**Mengapa ada:** state adalah riwayat + sesi pengguna. Kebijakan
Polones adalah karantina-bukan-hapus (`OpenClawStateRecovery`):
state rusak dikarantina, bukan dihapus. Snapshot melindungi pembaca
bersamaan saat boot.

**Apa yang rusak bila dilanggar:** fork yang menghapus / me-reset
state saat boot = kehilangan riwayat + sesi pengguna secara permanen
dan diam-diam. Migrasi skema yang dilewati = DB dibaca dengan skema
yang salah → sesi basi/hilang atau crash berulang.

### N4 — Invarian lock: pemilik yang tak terverifikasi tidak pernah direklamasi otomatis

**Yang dipertahankan:** pesan upstream sendiri (§5.5 openclaw.md).
Satu-satunya pengecualian: mode `OPENCLAW_MOBILE_SINGLE_OWNER=1`
+ jaminan eksklusivitas Polones + N2 (bind eksklusif).

**Mengapa ada:** lock adalah satu-satunya yang mencegah dua Gateway
menulis sqlite bersamaan. Relaksasi tanpa jaminan eksternal yang
nyata (bukan asumsi) = korupsi state.

**Apa yang rusak bila dilanggar:** dua Gateway menulis
`state/openclaw.sqlite` bersamaan → korupsi state, sesi hilang,
dan mode gagal yang TIDAK TERDETEKSI (Gateway tampak jalan,
datanya rusak). Khusus F2: env `OPENCLAW_MOBILE_SINGLE_OWNER=1`
HANYA boleh disetel oleh plan Rust Polones, tidak pernah menjadi
default upstream, tidak pernah bocor ke pemakaian non-Polones.

### N5 — Validasi config + gerbang `gateway.mode=local` + exit 78

**Yang dipertahankan:** config invalid → exit 78 (fail-closed).

**Mengapa ada:** fail-closed mencegah restart-loop
(systemd/supervisor yang me-restart Gateway atas config rusak
tanpa henti). Polones mengandalkan exit 78 untuk karantina +
retry sekali (`recoverFromStartFailure`).

**Apa yang rusak bila dilanggar:** Gateway yang memaksa jalan atas
config invalid akan crash-loop atau berjalan dengan perilaku
setengah-benarb — dan Polones kehilangan sinyal yang dipakainya
untuk mengkarantina + mencoba sekali lagi secara terkendali.

### N6 — Migrasi sesi: ditunda boleh, dilewati TIDAK BOLEH

**Yang dipertahankan:** `assertExistingDatabaseIdentity` + validasi
kanonik sesi; RPC agen HARUS menunggu migrasi selesai (gerbang
per-RPC F1).

**Mengapa ada:** migrasi melindungi dari sesi basi/hilang. F1
memindahkan migrasi ke sesudah listen — itu sah HANYA karena gerbang
RPC menahan `chat.send`/`agent` sampai migrasi selesai (pola yang
sama sudah ada untuk model runtime).

**Apa yang rusak bila dilanggar:** bila gerbang RPC lupa dipasang
atau migrasi dilewati, agen membaca sesi setengah-migrasi —
transkrip/identitas DB tidak cocok, sesi hilang, atau agen menjawab
dengan konteks yang salah tanpa sinyal error yang jelas.

### N7 — Semantik `plugins.deny` / allow-list (deny mengalahkan segalanya)

**Yang dipertahankan:** plugin yang di-deny TIDAK BOLEH termuat —
tidak saat boot, tidak belakangan (lazy load), tidak lewat cache.

**Mengapa ada:** Polones mengandalkan `plugins.deny` untuk
`browser`/`canvas`/`cua-computer` (+3 id berat). Lazy load (F5)
+ cache rencana (A3) + cache katalog (W2) semuanya adalah jalur
baru yang BISA memuat plugin di luar jalur startup biasa — tiap
jalur baru itu harus memanggil evaluator deny yang sama.

**Apa yang rusak bila dilanggar:** plugin yang sengaja dimatikan
pemilik hidup kembali diam-diam — termasuk plugin berat/berisiko
yang menjadi alasan deny itu ada. Pelanggaran ini diam (tidak ada
error), sehingga hanya ketahuan dari perilaku agen yang berubah.

### N8 — Lantai runtime Node (24.22.1+/26.12.1+, `node:sqlite`) + `NODE_COMPILE_CACHE`

**Yang dipertahankan:** `openclaw.mjs` menolak runtime lain;
`node:sqlite` dipakai state/agent DB.

**Mengapa ada:** fork berjalan di rootfs Polones (Node 24.22.3).
Menurunkan lantai runtime = boot gagal di perangkat. `node:sqlite`
adalah alasan Bun tidak bisa dipakai sebagai pengganti (lihat §3).

**Apa yang rusak bila dilanggar:** Gateway gagal start di perangkat
dengan error runtime yang tampak seperti "bug fork", padahal
penyebabnya lantai yang diturunkan. Juga: mengubah `NODE_COMPILE_CACHE`
secara ceroboh merusak prewarm yang sudah berjalan (cache diisi di
perangkat pada boot pertama + `gateway-prewarm.mjs` upstream).

### N9 — Sinyal readiness yang jujur: `/health` = live, `/ready` = ready

**Yang dipertahankan:** `/health` menjawab liveness (proses hidup),
`/ready` menjawab readiness (siap melayani), `h.mark("ready")`
HANYA sesudah post-attach.

**Mengapa ada:** Polones mem-probe `/health` untuk menampilkan READY
dan mengaktifkan tombol Buka. Mengubah arti `/health` menjadi
"ready" (atau menjawabnya dari shim — A2-R2) memalsukan status:
pengguna mengetuk Buka → Control UI 502 / chat gagal — sementara
sistem melaporkan semuanya sehat, termasuk Gateway yang crash-loop
di belakang shim.

**Apa yang rusak bila dilanggar:** seluruh rantai diagnosis Polones
(health probe → READY → Buka → chat) kehilangan maknanya. Mode
gagal boot menjadi TIDAK TERLIHAT — yang terburuk dari semua mode
gagal, karena tidak ada yang tahu ada yang rusak sampai pengguna
mengeluh.

### N10 — Perilaku default = upstream bila env fork tidak disetel (A1 OFF)

**Yang dipertahankan:** tanpa `OPENCLAW_MOBILE_BOOT=1`, fork
berperilaku byte-identik dengan upstream pada tag yang sama
(kecuali nomor versi).

**Mengapa ada:** satu-satunya cara rebase tetap teruji. Test
upstream berjalan atas fork dengan saklar OFF; penyimpangan hanya
di bawah saklar ON yang diuji Polones. Tanpa N10, tidak ada yang
bisa membedakan "bug upstream" dari "bug fork" — dan rebase
menjadi tidak terverifikasi.

**Apa yang rusak bila dilanggar:** fork yang mengubah perilaku
default secara diam-diam membuat test upstream tidak lagi menjadi
pengaman; regresi fork lolos ke perangkat dengan label "sudah
diuji upstream".

## 2. Aturan berhenti

**BERHENTI dan laporkan ke Lead/koordinator** (jangan putuskan
sendiri, jangan lanjut implementasi/rebase) bila salah satu terjadi:

1. Desain/implementasi membuktikan salah satu **N1–N10 HARUS berubah**
   agar fork bisa jalan.
2. Desain menabrak **Opsi A** (Gateway pemilik tunggal, WebUI
   dipertahankan — keputusan pemilik 24 Nov 2026). Contoh: usulan
   yang mengembalikan OpenClaw ke TUI-local, atau yang membagi
   kepemilikan Gateway ke dua proses.
3. Konflik rebase menyentuh N1–N10 / arti `/health`/`/ready` /
   saklar A1 (rincian di REBASE-GUIDE.md §5).
4. Bukti baru menunjukkan lantai fork (puluhan detik) tidak bisa
   dicapai tanpa melanggar guardrail — mis. satu-satunya jalan ke
   target ternyata readiness palsu.

**Cara melapor:** sebutkan guardrail yang tertabrak (nomor N +
nama), kutipan kode/diff yang membuktikannya, dan alternatif yang
sudah dipertimbangkan + mengapa masing-masing juga menabrak
guardrail. Jangan melapor dengan "kayaknya N4 kena" tanpa bukti
baris kode.

## 3. Daftar larangan

### 3.1 A2-R2 — shim health mandiri (DITOLAK)

**Yang dilarang:** server Node mungil yang mengikat 18789 lebih dulu,
menjawab `/health` 200 seketika, lalu menyerahkan socket ke Gateway
(`SO_REUSEPORT` / handoff).

**Alasan:** readiness palsu (lihat N9). Polones menampilkan READY +
pengguna mengetuk Buka + Control UI 502 / chat gagal — sementara
angka probe terlihat "2 detik". Angka itu bohong. Satu-satunya
pembenaran R2 adalah angka probe — bukan pengalaman pengguna.
**Yang dipakai sebagai gantinya:** A2-R1 — "listen lebih awal"
(F4): rute probe didaftarkan pada server yang diikat pertama,
dijawab proses Gateway yang asli, dengan arti yang sama.

**Syarat bila suatu hari tetap diinginkan** (bukan keputusan hari
ini): Polones membedakan "WARMING" vs "READY" di UI + probe kedua
(`/readyz`) sebagai gerbang Buka — dan itu sudah bukan "start
2 detik" lagi. Memenuhi syarat ini pun tetap butuh keputusan pemilik.

### 3.2 F7 — compile cache jadi di dalam aset (DITOLAK, jangan dikerjakan)

**Yang dilarang:** mengirim compile cache yang sudah jadi di dalam
aset fork.

**Alasan [TERBUKTI: FASE-0/4]:** seed cache dari CI miss karena path
absolut + arsitektur; cache hangat terbukti TIDAK memangkas boot.
Yang benar sudah berjalan: cache diisi di perangkat pada boot pertama
(`NODE_COMPILE_CACHE` persisten) + `gateway-prewarm.mjs` upstream
(impor saja + flush). Fork TIDAK perlu mengubah apa pun di sini.

### 3.3 D1 — hapus 5 ekstensi kandidat-buang (DILARANG)

**Yang dilarang:** menghapus fisik `dist/extensions/<id>/` untuk
`telegram`, `x`, `browser`, `canvas`, `cua-computer`.

**Alasan:** keputusan pemilik 24 Nov 2026 sudah MENOLAK 4.4
(penghapusan ini). Menghapusnya membunuh janji pengembalian via
`plugins.deny` — plugin yang dihapus fisik tidak bisa dihidupkan
lagi lewat config. Hematnya pun kecil: 1,66 MB + 3 plugin startup
lebih sedikit, **0 dtk ke health**.

### 3.4 D5 — hapus `dist/control-ui` (DILARANG DIHAPUS)

**Alasan:** Opsi 1 — Control UI disajikan Gateway. Menghapusnya
membunuh WebUI yang menjadi keputusan pemilik 21 Nov 2026
(Opsi 1) dan 24 Nov 2026 (Opsi A dipertahankan). `build.sh`
menjadikannya prune-safety check — build gagal bila berkas ini
hilang sesudah prune.

### 3.5 D6 — hapus `dist/worker-artifacts/*.tar.gz` (34 MB) sebelum diidentifikasi

**Yang dilarang:** menghapus sebelum isi tarball diidentifikasi.

**Alasan:** isi tarball [BELUM TERUKUR — diisi Lane A/G]. 34 MB
adalah angka besar, tetapi menghapus artefak yang ternyata dipakai
runtime = boot gagal. Identifikasi dulu, hapus kemudian (bila
terbukti tidak dipakai).

### 3.6 D7 — hapus 46 ekstensi "tidak yakin" borongan (JANGAN)

**Alasan:** `device-pair` bersinggungan dengan pairing;
`imap` (2,60 MB) mungkin dipakai; provider tidak boleh dipangkas
tanpa tahu kunci pengguna. Penghapusan borongan tanpa inventaris
per ekstensi = kehilangan kemampuan yang tidak ketahuan sampai
pengguna membutuhkannya.

### 3.7 D8 — hapus `memory-core` / `active-memory` (DILARANG DIHAPUS)

**Alasan:** memori agen. `OPENCLAW_DISABLE_BUNDLED_PLUGINS=1`
sengaja tidak dipakai justru karena mematikan ini. F5 hanya
memuat `memory-core` saat boot — bukan menghapusnya.

### 3.8 Patch-ke-`dist` (DILARANG — fork tanpa nama)

**Yang dilarang:** mengubah `dist/` hasil build dengan `sed` /
string-replace / edit tangan, sebagai pengganti mengubah `src/`.

**Alasan:** chunk Rollup ber-hash berubah nama + isi tiap rilis
CalVer upstream yang cepat; patch pecah diam-diam atau salah
sasaran; tidak ada test upstream yang berjalan atas `dist/`
ter-patch; `dist/` juga memuat `.source-module-urls/` +
`postinstall-inventory.json` yang memverifikasi integritas pohon
(postinstall menolak pohon tak lengkap — terbukti §3.1 openclaw.md).
**Patch ke `dist/` = fork tanpa nama, dengan seluruh beban fork
dan nol keuntungan fork** (tidak ada `src/`, tidak ada test, tidak
ada rebase yang terstruktur). Satu-satunya patch aset yang tahan
lama adalah yang hidup di LUAR `dist/`: launcher, env, config,
dan penghapusan direktori ber-id eksplisit
(`dist/extensions/<id>/`).

### 3.9 Esbuild penuh / V8 snapshot / port Bun (DITOLAK)

- **Bundling esbuild penuh atas `dist/`** — DITOLAK (Fase 8.2,
  openclaw.md §7): tidak layak sebagai bundling ulang.
- **V8 snapshot** — DITOLAK (Fase 8.3, §7).
- **Bun single-executable ala OpenCode** — DITOLAK: OpenClaw memakai
  `node:sqlite`, worker threads + `Atomics`, modul native (`.node`:
  `fs-safe`, `proc-safe`, `node-pty`), dan `process.execve` — Bun 1.4
  tidak menyediakan semuanya dengan paritas; porting = fork total,
  bukan modifikasi. [HIPOTESIS — belum ada prototipe; dicatat sebagai
  penolakan beralasan, bukan vonis final.]
- **Zip `dist/`/`node_modules/`** — DITOLAK tanpa prototipe (analogi
  zipimport Hermes Fase 8.1: zip lebih lambat 2,7× untuk modul Python;
  untuk Node, `import()` dari zip butuh loader kustom — upaya besar,
  hemat tak terbukti).

### 3.10 Larangan operasional (dari AGENTS.md fork + Polones)

- **Jangan push ke `origin`** — itu upstream
  (`https://github.com/openclaw/openclaw.git`), bukan remote fork.
  Remote fork belum ada; push hanya atas perintah pemilik sesudah
  remote fork dibuat.
- **Jangan ubah repo Polones** dari lane fork — baca saja.
- **Jangan menaikkan anggaran** `readyWithinMs` 480→540 dtk atau
  `WEDGE_KILL_AFTER` 45→90 dtk tanpa bukti (keduanya bukan percepatan,
  hanya toleransi — dan menutupi mode gagal yang seharusnya diperbaiki
  F5).
- **Jangan klaim angka perangkat** sebelum ronde perangkat (S1/S2/S3
  + `startup-phases.log`) — lihat VERIFY.md.

## 4. Referensi

- `DESIGN.md` §3 (N1–N10 + aturan berhenti), §2.3 (D1–D8),
  §2.2 (A5), §4 (urutan).
- `REBASE-GUIDE.md` §5 (kapan berhenti saat rebase).
- `VERIFY.md` (definisi A/B + ronde perangkat).
- `~/workspace/research-start/per-harness/openclaw.md` §9.4 (N1–N10),
  §9.3 (D1–D8), §9.2 (A2/A5), §10 (rekomendasi + larangan).
