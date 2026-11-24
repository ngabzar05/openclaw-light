# VERIFY — Cara Memverifikasi Fork OpenClaw (LAB + Perangkat)

> **Status:** panduan verifikasi fork `mobile-fast-boot`.
> **Basis fork:** `openclaw/openclaw` @ tag `v2026.11.6` (commit `06afb10d`).
> **Baca dulu:** `DESIGN.md` §5 (definisi ukur) + `GUARDRAILS.md`
> (N9: sinyal readiness yang jujur) +
> `~/workspace/research-start/per-harness/openclaw.md` §5 (fase boot),
> Lampiran A (angka LAB), Lampiran C (yang belum terjawab) +
> `~/workspace/polones/docs/guides/openclaw-slow-start.md` (pengukuran
> LAB v0.1.120 — sumber angka baseline di dokumen ini).
> Semua angka di dokumen ini berlabel **[LAB]** atau **[PERANGKAT]**.
> Angka tanpa label = jangan dipercaya.

## 0. Dua definisi ukur — jangan tertukar

| Definisi | Arti | Yang mengukur | Yang dirasakan |
|---|---|---|---|
| **A — waktu-ke-probe** | spawn → `GET /health` pertama 200 | Polones (probe `/health`) | Tile berubah READY |
| **B — Buka → bisa dipakai** | spawn → Control UI shell tampil + chat pertama bisa dikirim (katalog boleh menyusul) | Pengguna (+ skrip ukur + WebView/lab) | "Bisa dipakai" |

**Mengapa dua definisi:** A adalah yang diukur Polones; B adalah yang
dirasakan pengguna. Di v0.1.120 keduanya JAUH berbeda (perangkat:
A ~95 dtk, B >135 dtk — video 25 Nov 02:39 WIB). Fork yang hanya
memangkas A tetapi tidak B belum menyelesaikan masalah pengguna.
Sebaliknya, klaim "start 2 detik" yang hanya mengukur A lewat shim
adalah readiness palsu (GUARDRAILS.md §3.1, A2-R2).

**Yang TIDAK BOLEH diklaim:** angka perangkat sebelum ronde perangkat
(§4). Angka LAB bukan angka perangkat — LAB terinflasi emulasi QEMU
(`openclaw --version` saja 2,9 dtk di VM ini).

## 1. Baseline yang sudah terukur (pembanding resmi)

### 1.1 Baseline LAB [LAB] — upstream v2026.11.6 murni, VM PRoot+QEMU, uid nobody

Sumber: `docs/guides/openclaw-slow-start.md` §2–§3 + openclaw.md
Lampiran A. Poll tiap 10 dtk.

| Run | Spawn (UTC) | Health 200 pertama (poll) | Wall ≈ | `listening` (jam internal) |
|-----|-------------|---------------------------|--------|----------------------------|
| 1 | 05:36:55 | t+293 dtk | ≈324 dtk | 266,6 dtk |
| 2 | 05:46:53 | t+292 dtk | ≈308 dtk | 261,2 dtk |
| 3 | 06:22:01 | t+283 dtk | ≈310 dtk | 259,3 dtk |
| 4b | 06:43:34 | t+322 dtk | ≈330 dtk | 291,1 dtk |

Run 4 dikeluarkan: bootstrap GAGAL atas state kotor; angka t+584 dtk
di `health-poll4.log` sebenarnya menjawab Gateway run 4b di port
yang sama.

**Pemecahan komponen waktu (run 2, terbersih)** — total ke health
≈306–308 dtk; `plugins.runtime-post-bind` 67,7 dtk berjalan
SETELAH health:

| Rentang | Fase | Durasi |
|---------|------|--------|
| 0–6,1 dtk | Node start + `entry.run-main-import` | 1,3 dtk |
| 6,1–36,1 dtk | — TANPA FASE — (impor graf modul utama) | ~30 dtk |
| 36,1–42,8 dtk | `select-environment` + impor | ~6,7 dtk |
| 42,8–101,4 dtk | `gateway-run-bootstrap` | 58,6 dtk (`state-snapshot` 10,8; `plugin-config` 6,7; `database-runtime-import` 6,8; `session-runtime-import` 3,5; celah tanpa fase 12,6 + 29,5 dtk) |
| 101,4–113,6 dtk | celah + `lifecycle-runtime` | 3,6 dtk |
| 113,8–131,8 dtk | `gateway-lock` | 18,0 dtk |
| 132,4–144,7 dtk | — TANPA FASE — | ~12 dtk |
| 144,7–166,7 dtk | `gateway.server-start-import` | 22,1 dtk |
| 166,7–193,9 dtk | celah + `schema-preflight`/auth | ~27 dtk |
| 193,9–221,1 dtk | `sessions.admission` | 27,2 dtk |
| 221,1–304,2 dtk | — TANPA FASE — | ~83 dtk (`starting HTTP server...` ~258 dtk; `health-monitor` ~262 dtk; stall event-loop 0,3–3,9 dtk; TIDAK ADA phase log — komposisi internal TIDAK TERBUKTI) |
| 304,2–324,4 dtk | `runtime.early` | ~20 dtk — **health 200 pertama ≈306–308 dtk** |
| 324,8–392,5 dtk | `plugins.runtime-post-bind` | 67,7 dtk — SETELAH health |
| 392,8 dtk | `http server listening` tercatat | — (261,2 dtk jam internal) |

Celah tanpa fase sebelum health ≈150 dtk (~49% waktu ke health).
**Perhatian jam:** angka `listening (…; 261,2 dtk)` yang dicetak
OpenClaw dihitung sejak akhir `boot-lifecycle` (~132 dtk), BUKAN
sejak spawn — wall sebenarnya ke baris itu ~393 dtk (run 2). Jangan
pakai angka internal itu sebagai durasi boot.

**Log mentah LAB:** `~/workspace/openclaw-gateway-lab/`
(`LAB-NOTES.md`, `gateway2.log`, `health-poll2.log`, dst.).
Staging rootfs LAB (tmpfs, hilang saat reboot): `/var/tmp/oc-gw-rootfs`.
Proot LAB: 5.5.0 statik — proot 5.1.0 TIDAK menerjemahkan `statx`
dan memblokir Node 24 (lihat `LAB-NOTES.md` §1).

### 1.2 Baseline perangkat [PERANGKAT] — S1, v0.1.120, Xiaomi 12, video 25 Nov 2026 02:39 WIB

| Ukuran | Nilai |
|---|---|
| Definisi A (tile READY) | **~95 dtk** |
| Definisi B (bisa dipakai) | **>135 dtk** (video berakhir saat skeleton "Memuat..." masih tampil; belum bisa dipakai) |
| Rincian B | WebUI dibuka ~99 dtk → layar gelap ~8 dtk → skeleton "Memuat..." sampai akhir video 135 dtk |
| Tersangka utama fase B [TERBUKTI source] | stall 43,5 dtk saat membuka katalog tool (`dist/tool-catalog-*.mjs`; re-capture di `ensureStandalonePluginToolRegistryLoaded`) |

**Ini baseline S1, bukan hasil fork.** Fork dinyatakan berhasil di
perangkat hanya bila S2/S3 (§4) menunjukkan A dan B yang lebih kecil
dari angka di atas, diukur dengan metode yang sama.

### 1.3 Kontribusi tiap tuas (untuk menafsirkan hasil ukur)

| Tuas | Kontribusi ke A [LAB] | Kontribusi ke B | Status bukti |
|---|---|---|---|
| F1 (defer admission) | 27,2 dtk | sebagian | [TERBUKTI] lokasi+isi; [HIPOTESIS] hemat perangkat |
| F2 (lock fast-path) | 18 dtk bersih; hingga ~270 dtk kotor (300→30 dtk) | sama | [TERBUKTI] konstanta; [HIPOTESIS] hemat |
| F3 (pecah bootstrap) | [HIPOTESIS] 17 dtk | — | [BELUM TERUKUR] detail internal bootstrap |
| F4 (early-listen) | [HIPOTESIS] 22–80 dtk | — | Titik pisah graf [BELUM TERUKUR — diisi Lane A/G]; apakah `/health` digerbangi `runtime.early` [BELUM TERUKUR] |
| F5 (capture async + lazy) | 0 dtk ke A | 67,7 dtk ke "terasa siap" [LAB] + hapus wedge-kill palsu | [TERBUKTI] `requestSync`+`Atomics.wait` ada; [HIPOTESIS] hemat perangkat |
| F9 (instrumentasi) | 0 dtk | 0 dtk | Prasyarat — tanpa ini F3/F4 menebak |
| F6 (code-split entry) | [HIPOTESIS] satuan detik (I/O) | — | — |
| F8 (matikan update) | [BELUM TERUKUR], kecil | — | — |
| A3 (cache rencana) | [HIPOTESIS] 6,7 dtk boot berulang | — | — |
| A4 (migrasi inkremental) | [HIPOTESIS] sebagian besar 27,2 dtk boot berulang | — | — |
| W1/W2 (katalog malas + cache) | 0 dtk ke A | ≥40 dtk skeleton sesudah ready [PERANGKAT] | Tersangka [TERBUKTI source]; hemat [BELUM TERUKUR] |

## 2. Cara menjalankan ukur LAB

### 2.1 Prasyarat

1. **Ukur upstream murni DULU** di VM yang sama, SEBELUM membandingkan
   fork — tanpa baseline upstream di mesin yang sama, selisih angka
   tidak berarti apa-apa. (Aturan DESIGN.md §5.)
2. Lingkungan LAB = VM ini, PRoot 5.5.0 + QEMU, uid `nobody`,
   Node 24.22.1, pohon aset persis APK (bukan pohon npm mentah —
   pohon mentah gagal jalan: `lifecycle incomplete`, openclaw.md
   Lampiran A A7).
3. **Boot penuh HANYA bisa diukur di arm64/perangkat** — build x86_64
   gagal memuat modul native arm64 (Lampiran A A9). Ukur LAB
   memakai aset arm64 di bawah PRoot+QEMU, seperti run 1–4 di §1.1.
4. Siapkan state yang sama untuk tiap run yang dibandingkan
   (state segar vs state berisi sesi lama memberi angka migrasi
   yang berbeda — F1/F4 bergantung pada isi state).

### 2.2 Prosedur definisi A (waktu-ke-probe)

```sh
# 1. Catat waktu spawn (UTC, detik) — T0.
date -u +%Y-%m-%dT%H:%M:%S
# 2. Spawn Gateway (perintah luncur + env mengikuti plan Polones
#    yang berlaku; port Gateway 18789, proxy 18790 bila dipakai).
#    Simpan log Gateway ke berkas run ini (mis. gateway-fork1.log).
# 3. Poll /health tiap 10 dtk sampai 200 pertama; catat waktunya (T1).
#    (Poll 10 dtk mengikuti LAB run 1-4; wall = poll + jeda poll-start
#    ~16 dtk — catat jeda itu, jangan disembunyikan.)
while true; do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18789/health || echo 000)
  echo "$(date -u +%H:%M:%S) /health -> $code" >> health-poll-fork1.log
  [ "$code" = "200" ] && break
  sleep 10
done
# 4. Definisi A = T1 - T0 (detik).
```

**Yang dicatat per run** (satu baris per run, di laporan ukur):

- T0 spawn (UTC), T1 health-200 pertama, definisi A (dtk),
  wall (dtk, bila berbeda dari A karena jeda poll-start),
  kondisi state (segar / berisi N sesi / kotor),
  saklar (`OPENCLAW_MOBILE_BOOT=0/1`),
  tag/komit fork, Node, PRoot+QEMU,
  nama berkas log Gateway + health-poll.
- **Label [LAB]** pada setiap angka.

**Kriteria lolos A (smoke):** `/health` 200 tercapai sebelum
`readyWithinMs` 480 dtk. **Kriteria lolos kejujuran (N9):**
`/ready` 200 HANYA sesudah post-attach — bila `/ready` 200
bersamaan dengan `/health` pertama, gerbang readiness rusak
atau ada shim — BERHENTI dan selidiki (GUARDRAILS.md N9).

### 2.3 Prosedur definisi B (Buka → bisa dipakai)

Definisi B diukur dengan skrip ukur + WebView/lab (DESIGN.md §5) —
**prosedur persisnya [BELUM TERUKUR — diisi Lane A/G]** karena
memerlukan harness ukur Control UI (buka WebUI → tunggu shell tampil
→ kirim chat pertama) yang belum ditulis saat dokumen ini dibuat.
Yang sudah ditetapkan dan TIDAK BOLEH diubah:

- B selesai bila **shell chat tampil + chat pertama BISA dikirim**
  (katalog boleh menyusul — W1).
- B TIDAK selesai bila hanya `/health` 200, hanya tile READY, atau
  hanya skeleton "Memuat..." yang tampil.
- Catat rincian B seperti S1: waktu buka WebUI, durasi layar gelap,
  durasi skeleton, waktu shell tampil, waktu chat pertama terkirim.
- Label [LAB] bila diukur di VM, [PERANGKAT] bila di perangkat.

### 2.4 Instrumentasi F9 — membaca `startup-phases.log`

Sesudah F9 (Lane A), tiap langkah boot tercatat lewat
`measure()` (`measureGatewayBootstrapStep` /
`createGatewayDispatchStartupTrace`, `STARTUP_PROGRESS_PHASES`)
dan env `OPENCLAW_GATEWAY_STARTUP_TRACE=1` (sudah ada upstream —
mengaktifkannya saja tanpa fork sudah memberi sebagian visibilitas).

- Bandingkan fase-per-fase hasil fork dengan tabel §1.1 (run 2):
  fase mana yang hilang/berkurang (F1: `sessions.admission` tidak
  lagi pra-listen; F2: `gateway-lock` <5 dtk bersih; F4: celah
  221,1–304,2 dtk teratribusi).
- **Celah 83 dtk (221,1–304,2 dtk) adalah vonis F9:**
  komposisi internalnya [BELUM TERUKUR — diisi Lane A] — jangan
  mengklaim F4 memangkasnya sebelum F9 membuktikan titik pisahnya.

## 3. Test yang harus lolos per lane

### 3.1 Test upstream (gerbang rebase — REBASE-GUIDE.md §4.2)

- Suite test upstream atas area fork, dengan saklar OFF (N10):
  perilaku fork-OFF harus identik upstream murni (kecuali nomor
  versi). Satu test upstream gagal HANYA di fork = regresi rebase.

### 3.2 F1 — gerbang RPC

- **Setup:** state berisi sesi lama (bukan state segar — migrasi
  atas state segar hampir tidak terukur).
- **Jalankan:** boot fork (A1 ON) → catat `/health` 200 cepat →
  kirim `chat.send` pertama SEBELUM migrasi selesai.
- **Lolos bila:** `chat.send` ditahan sampai migrasi selesai, lalu
  benar (transkrip/identitas DB cocok). **Gagal bila:** agen membaca
  sesi setengah-migrasi, atau `chat.send` gagal (bukan ditahan).
- **Status test:** [BELUM ADA — dibuat Lane A/B; jangan klaim
  verifikasi F1 lengkap sebelum test ini ada dan lolos].

### 3.3 F2 — dua-Gateway

- **Setup:** dua proses Gateway bersamaan dengan
  `OPENCLAW_MOBILE_SINGLE_OWNER=1`.
- **Lolos bila:** yang kedua HARUS exit `GatewayLockError`
  (via bind eksklusif 18789), bukan korupsi state.
  Periksa `state/openclaw.sqlite` sesudahnya — tidak ada karantina
  baru, tidak ada tulis ganda.
- **Gagal bila:** kedua proses hidup bersamaan, atau state rusak.
- **Status test:** [BELUM ADA — dibuat Lane A/B].

### 3.4 F5 — fail-closed per plugin

- **Setup:** satu plugin yang capture-nya dibuat gagal (mis. artefak
  capture rusak / worker menolak).
- **Lolos bila:** plugin itu mati, Gateway tetap hidup; plugin TIDAK
  termuat diam-diam belakangan; `plugins.deny` tetap dihormati
  (plugin ter-deny tidak termuat lewat jalur lazy).
- **Gagal bila:** Gateway mati karena satu plugin gagal, atau plugin
  gagal lalu hidup lagi diam-diam.
- **Status test:** [BELUM ADA — dibuat Lane A/B].

### 3.5 Suite kontrak Polones

Suite kontrak Polones yang menyentuh OpenClaw (openclaw 16/16,
gateway-env 7/7, launcher 4/4 — angka openclaw.md §9.5; ikuti
jumlah yang berlaku di repo Polones saat verifikasi) HARUS hijau
penuh sesudah tiap rebase + rebuild aset fork.

### 3.6 Verifikasi APK persis (gerbang sebelum link diserahkan)

Mengikuti skill `polones_release_apk_verification`: unduh APK rilis,
periksa hash + aset yang terbundel + jalankan repro fungsional
PRoot+QEMU atas berkas persis dari APK itu — SEBELUM link APK
diserahkan. Build hijau di VM tidak pernah dianggap selesai tanpa
ini. Bukti perangkat tetap menjadi vonis akhir.

## 4. Ronde perangkat — hanya pemilik bisa lakukan

Ronde perangkat adalah prasyarat keputusan fork (openclaw.md §9.5b
+ Lampiran C) DAN vonis akhir tiap hasil fork. Tidak ada angka LAB
yang menggantikannya.

### 4.1 S1 — baseline (SUDAH ADA — v0.1.120, video 25 Nov 02:39 WIB)

- A ~95 dtk, B >135 dtk (lihat §1.2). S1 adalah pembanding resmi
  untuk semua klaim perangkat sesudahnya.
- S1 juga mencatat: tile READY ~95 dtk; WebUI dibuka ~99 dtk →
  layar gelap ~8 dtk → skeleton sampai 135 dtk.

### 4.2 S2 — fork pertama (sesudah F1+F2+F5 terpasang)

- **Yang diukur pemilik:** ketuk Start → catat waktu tile READY
  (A) → ketuk Buka → catat layar gelap, skeleton, shell tampil,
  chat pertama terkirim (B). Satu ronde = cold boot (state yang
  sama dengan S1 bila mungkin) + start kedua (lock basi — vonis F2).
- **Yang dicatat pemilik:** `startup-phases.log` (dari perangkat —
  jalur + cara mengambilnya mengikuti runbook Polones yang berlaku
  saat ronde; JANGAN ditebak di dokumen ini) + video/laporan waktu
  seperti S1.
- **Yang diputuskan dari S2:** apakah cold boot native masih
  puluhan–ratusan detik (fork layak dilanjutkan) atau ternyata
  <30 dtk (fork dibatalkan — rute (a)+(c) cukup, openclaw.md §9.5b).

### 4.3 S3 — fork penuh (sesudah F4 + W1/W2)

- Sama seperti S2, ditambah: vonis fase WebUI (apakah skeleton
  ≥40 dtk hilang), vonis start kedua/ketiga (apakah mode gagal
  "start kedua macet" hilang), dan start DSH/OpenClaw/Hermes
  bila relevan dengan rilis yang diuji.
- **Keputusan yang menunggu S3:** prestart ON/OFF + target A/B
  (DESIGN.md §4 langkah 2) — tidak diputuskan dari LAB.

### 4.4 Aturan pelaporan perangkat

- Satu angka perangkat tanpa metode = tidak dihitung. Tiap angka
  perangkat disertai: versi APK, kondisi state, A + B + rincian
  (§2.3), dan `startup-phases.log` bila ada.
- Angka perangkat 24 Nov (6,2 / 58,8 / 66,7 dtk) TIDAK terverifikasi
  di sesi riset — [BELUM TERUKUR]; jangan dipakai sebagai pembanding.
- "~2 detik" adalah observasi user, bukan ukur bermetodologi —
  jangan dipakai sebagai target angka.

## 5. Daftar [BELUM TERUKUR] dokumen ini (diisi lane lain)

| # | Butir | Diisi oleh |
|---|---|---|
| 1 | Angka ukur F9 — komposisi celah 83 dtk (221,1–304,2 dtk) + titik pisah graf F4 | Lane A (F9) |
| 2 | Apakah `/health` digerbangi `runtime.early` (menentukan hemat F4(b)) | Lane A/G |
| 3 | Prosedur persis ukur definisi B (skrip ukur Control UI) | Lane A/G |
| 4 | Hemat perangkat F1/F2/F5 (S2/S3) | Ronde perangkat pemilik |
| 5 | Hemat W1/W2 atas skeleton ≥40 dtk (S3) | Ronde perangkat pemilik |
| 6 | Graf impor per paket (D3: `npm`, `@esbuild`, `highlight.js`, `clawpdf`) | Lane A/G |
| 7 | Isi `dist/worker-artifacts/*.tar.gz` 34 MB (D6) | Lane A/G |
| 8 | Detail internal bootstrap F3 (celah 12,6 + 29,5 dtk di dalam `gateway-run-bootstrap`) | Lane A (F9) |
| 9 | Test F1/F2/F5 (apakah sudah ditulis + lolos) | Lane A/B |

## 6. Referensi

- `DESIGN.md` §5 (definisi ukur), §1 (alur lama vs baru), §8 (status).
- `REBASE-GUIDE.md` §4 (verifikasi sesudah rebase).
- `BUILD-PUBLISH.md` §3 (batas ukur x86 vs arm64).
- `GUARDRAILS.md` §1 N9 (kejujuran sinyal), §3.1 (larangan shim).
- `~/workspace/research-start/per-harness/openclaw.md` §5, §9.1,
  Lampiran A/C.
- `~/workspace/polones/docs/guides/openclaw-slow-start.md` §2–§3
  (baseline LAB + pemecahan komponen).
- `~/workspace/openclaw-gateway-lab/LAB-NOTES.md` (log mentah LAB).
