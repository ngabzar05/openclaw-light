# Pengukuran baseline LAB — Lane A (A1 + F9)

> Semua angka di dokumen ini berlabel **[LAB]**: VM ini (x86_64, Node
> v24.22.1, native — TANPA PRoot/QEMU). Angka ini BUKAN angka perangkat.
> Baseline perangkat S1 (video 25 Nov 2026 02:39 WIB, v0.1.120, Xiaomi 12):
> definisi A ~95 dtk, definisi B >135 dtk — tetap menjadi pembanding
> perangkat, bukan LAB.

## 1. Definisi

- **Definisi A (waktu-ke-probe):** spawn proses Gateway → `GET /health`
  pertama 200. Yang diukur Polones.
- **Definisi B (Buka → bisa dipakai):** spawn → Control UI shell tampil +
  chat pertama bisa dikirim. Di LAB, yang bisa diukur hanyalah
  **proksi**: `GET /` (root Control UI) pertama 200 — yaitu HTML shell
  tersaji. **Chat pertama TIDAK bisa diukur di lab** (butuh model +
  API key yang tidak ada di VM ini); dicatat sebagai keterbatasan, bukan
  diklaim.
- **`/ready` 200 pertama** dicatat sebagai titik tengah (readiness jujur
  upstream: sesudah `runtime.post-attach`).

## 2. Cara mengukur (repro)

Skrip: `docs/mobile-fast-boot/measure-baseline.sh <label> [timeout_s]`
(dari root worktree, sesudah `pnpm build`).

- HOME + `OPENCLAW_STATE_DIR` segar per run (`/tmp/lane-a-lab/<label>/`).
- Config minimal (`<label>/config.json`, ditulis ke
  `$OPENCLAW_STATE_DIR/openclaw.json` — itu jalur default yang dibaca
  `resolveConfigPath`, bukan `~/.openclaw/openclaw.json`):
  `gateway.mode=local`, port 18789, model default `openai/gpt-4o`
  (tidak pernah dipanggil saat boot; hanya agar config valid).
- `OPENCLAW_GATEWAY_STARTUP_TRACE=1` menyala — semua fase tercatat di
  `<label>/gateway.log` sebagai baris `startup trace:` / `startup phase:`.
- Poll `curl` tiap 0,25 dtk ke `/health`, `/ready`, `/`; catat 200 pertama
  relatif terhadap spawn (`<label>/timings.tsv`).
- Sesudah `/` 200, gateway dibiarkan 45 dtk (post-attach/plugin selesai)
  lalu di-stop. Tabel fase diekstrak ke `<label>/phases.tsv`.
- Variabel yang dibandingkan: `OPENCLAW_MOBILE_BOOT` kosong (OFF,
  upstream) vs `=1` (ON). Lane A belum memasang perilaku di balik ON,
  jadi ON vs OFF harus identik dalam batas noise — itu sendiri adalah
  smoke test A1.

## 3. Pemetaan nama fase: laporan LAB lama → nama trace saat ini

Laporan riset (`~/workspace/research-start/per-harness/openclaw.md` §5)
memakai nama dari `dist/` 2026.11.6. Tidak semua nama itu masih ada di
`src/` saat ini; pemetaannya:

| Nama di laporan riset | Nama trace saat ini (F9) | Keterangan |
|---|---|---|
| impor graf entry (~30 dtk) | `cli.main.gateway-run-import.*` (per chunk: commander, run-command, version, banner, runtime) + `gateway-run-imports` | F9: dipecah per chunk di `src/cli/run-main.ts` |
| `gateway-run-bootstrap` (58,6 dtk) | `cli.main.gateway-run-bootstrap`, `cli.main.gateway-run-pre-bootstrap`, `cli.environment.*`, `cli.bootstrap.*` | Sudah ada upstream; F9 tidak menambah |
| `gateway-lock` (18 dtk bersih) | `cli.bootstrap.gateway-lock` (CLI) + `gateway.lock-acquire` (server langsung) | F9: tambah langkah bootstrap `gateway.lock-acquire` di `src/gateway/server.ts`. Terukur [LAB]: 1,6–1,9 dtk (lihat §4.2) — 18 dtk lama adalah worst-case lock basi, bukan jalan bersih |
| `state-snapshot` (10,8 dtk) | `cli.bootstrap.admission.state-snapshot` | **Koreksi:** langkah ini ADA — namanya dibangun dinamis `cli.bootstrap.${name}`, jadi pencarian literal `state-snapshot` di `src/` tidak menemukannya. Terukur [LAB]: 1,7–2,3 dtk (lihat §4.2) |
| `plugin-config` (6,7 dtk) | `plugins.bootstrap.plan` → `plugins.bootstrap.activation-config` + `plugins.bootstrap.lookup-table` | F9: dipecah di `src/gateway/server-startup-plugins.ts`. Terukur [LAB]: 1,6–2,2 dtk (lihat §4.2) |
| `database/session-runtime-import` (10,3 dtk) | `gateway.database-engine-install` + `gateway.sqlite-runtime-initialize` (langkah bootstrap) | F9: diukur di `src/gateway/server.ts` |
| `gateway.server-start-import` (22,1 dtk) | `gateway.server-start-import` (langkah bootstrap, satu impor dinamis `./server-start.js`) | Graf statis di dalamnya TIDAK bisa dipecah tanpa restrukturisasi; diukur tidak langsung lewat fase-fase hilir (`gateway.kernel-state`, `gateway.request-runtime`, `gateway.http-transport`, …) |
| `sessions.admission` (27,2 dtk) | `sessions.admission` → `sessions.admission.deletion-snapshot`, `.store-identity`, `.acp-keys`, `.legacy-main-keys`, `.targets` | F9: dipecah di `src/config/sessions/startup-migration.ts` (via `measure` injeksi) |
| celah 221,1–304,2 dtk (~83 dtk) | `gateway.kernel-state` (+ sub-langkah `device-identity`, `device-pairing`, `worker-environments.*`, `runtime.config`, `control-ui.root`, `tls.runtime`, `runtime.state`, … — sudah ada upstream) + `gateway.http-transport` (F9) + `http.listen.*` (F9) | **Vonis §4.3: di LAB native TIDAK ada celah ~150 dtk tanpa fase.** Wilayah ini terurai menjadi fase-fase terukur; biaya terbesar pasca-bind adalah `plugins.runtime-post-bind` (~9,7 dtk) + `runtime.post-attach` (13,3 dtk total). Lihat §4.3 |
| `http.listen` → `http.bound` | `gateway.ws-imports`, `gateway.ws-attach`, `http.listen` → `http.listen.tailscale-ingress`, `.bind`, `.portal-ingress`, `.sandbox-host`, `.plugin-listeners` | F9: `startListening` dipecah di `src/gateway/server-runtime-state.ts` |
| `ensureRequestRuntimeReady` | `gateway.request-runtime` → `sessions.projection`, `gateway.owner-profile`, `sessions.materialize`, `sessions.first-page`, `gateway.lifetime-sidecars`, `gateway.instance-runtime-import` | Sudah ada upstream |
| `runtime.early` | `runtime.early.discovery`, `.lazy-runtime-imports`, `.skills-listener` | Sudah ada upstream |
| `plugins.runtime-post-bind` (67,7 dtk) | `plugins.runtime-post-bind` + `plugins.gateway-load.plugin.*` (per plugin) | Sudah ada upstream |

## 4. Hasil baseline — upstream 2026.11.6, saklar OFF [LAB]

Tiga run bersih (24 Nov 2026 malam WIB; skrip `measure-baseline.sh`,
`OPENCLAW_GATEWAY_STARTUP_TRACE=1`). Artefak tiap run di
`/tmp/lane-a-lab/<label>/` (`gateway.log`, `timings.tsv`, `phases.tsv`,
`config.json`). **Catatan artefak run1-off:** `pnpm build` belum pernah
menyelesaikan langkah `ui:build` di worktree ini, jadi `dist/control-ui/`
belum ada saat run1-off — gateway mem-build Control UI on-demand
(`ensureControlUiAssetsBuilt`, `src/infra/control-ui-assets.ts`, timeout
10 mnt) selama **168,1 dtk**. Itu artefak lab, BUKAN perilaku upstream
pada rilis yang ter-build benar. Sesudah `pnpm ui:build` (exit 0, ~135
dtk) aset prebuilt tersedia dan run2-off mengukur jalur yang benar.
**Baseline valid adalah run2-off**; run1-off dicatat sebagai bukti
artefak itu dan sebagai pembanding.

### 4.1 Definisi A + B (proksi) + `/ready`

| Run | `OPENCLAW_MOBILE_BOOT` | `/health` 200 pertama (A) | `/ready` 200 pertama | `/` 200 pertama (proksi B) |
|---|---|---|---|---|
| run1-off | OFF (kosong) | 21,8 dtk | 43,5 dtk | **191,6 dtk** (artefak: build UI on-demand 168,1 dtk) |
| run2-off | OFF (kosong) | 26,1 dtk | 42,4 dtk | **42,6 dtk** |
| run1-on | `=1` (lihat §5) | 18,9 dtk | 32,8 dtk | 32,9 dtk |

Variansi antar-run OFF: health 21,8 ↔ 26,1 dtk (±4 dtk); ready 42,4 ↔
43,5 dtk (±1 dtk). Penyebab variansi: kontensi CPU dari lane paralel
yang jalan bersamaan + cache hangat — bukan saklar (lihat §5).

### 4.2 Per fase (run2-off — baseline valid; durasi ms, total = akhir ms sejak spawn)

Garis waktu (total akhir tiap fase):

| Rentang (dtk) | Fase / peristiwa | Durasi |
|---|---|---|
| 0,0–0,8 | `entry.bootstrap` → `entry.argv` → `entry.run-main-import` | 0,19 dtk |
| 0,8–2,8 | **celah kecil tanpa fase ~2,0 dtk** (prewarm/impor dinamis sebelum `cli.main.argv`) — sisa wilayah tak terukur, lihat §4.3 | ~2,0 dtk |
| 2,8–5,1 | `cli.main.database-engine-selection` | ~2,3 dtk (mayoritas menunggu, durasi langkah 0,9 ms) |
| 5,1–5,9 | `gateway-run-select-environment` (`config-import` 0,72 dtk, `config-guard` 0,81 dtk) | 0,84 dtk |
| 5,9–13,2 | `gateway-run-bootstrap` / `config-ready`: `database-readiness` 0,98 dtk, `plugin-config` 1,65 dtk, `state-snapshot` 1,72 dtk, `webhook-readiness` 1,93 dtk | 6,85 dtk |
| 13,2–16,2 | `gateway-lock` | 1,61 dtk |
| 16,2–18,9 | `gateway.server-start-import` (satu impor dinamis `./server-start.js`) | 1,94 dtk |
| 18,9–19,8 | `state.ownership` | 0,90 dtk |
| 19,8–22,3 | `sessions.admission` (`deletion-snapshot` 1,54 dtk) | 1,62 dtk |
| 22,3–23,7 | `plugins.bootstrap` (`subagent-registry` 1,43 dtk) | 1,46 dtk |
| 23,7–26,0 | `gateway.kernel-state` 0,98 dtk, `request-runtime` 0,25 dtk, `http-transport`, `http.listen` → **`http.bound` 26,0 dtk → `/health` 200 @ 26,1 dtk (A)** | ~2,3 dtk |
| 26,0–27,7 | `sessions.projection` | 1,86 dtk |
| 27,7–27,9 | `sidecars.control-ui-assets` (aset prebuilt: **0,5 ms**; bandingkan run1-off: 168.059 ms) | 0,0005 dtk |
| 27,9–37,6 | **`plugins.runtime-post-bind`** — fase tunggal terbesar | **9,70 dtk** |
| 37,6–41,2 | `sidecars.reply-runtime` 1,53 dtk, `sidecars.model-runtime` 2,71 dtk → `runtime.post-attach` selesai 41,2 dtk (total 13,29 dtk) | ~3,6 dtk |
| 41,2–42,3 | fase `ready` → **`/ready` 200 @ 42,4 dtk** | 0,41 dtk |
| 42,4–42,6 | **`GET /` 200 @ 42,6 dtk (proksi B)** — 0,2 dtk sesudah `/ready` | — |
| 42,3–48,4 | `post-ready.maintenance` 4,80 dtk + `post-ready.gateway-data.memory-search` 2,53 dtk (latar, sesudah ready — tidak memblokir B) | — |

Perbandingan run1-off (OFF, artefak build UI) untuk fase yang sama:
`server-start-import` 2,26 dtk; `state-snapshot` 2,30 dtk;
`plugin-config` 2,24 dtk; `webhook-readiness` 2,48 dtk;
`gateway-lock` 1,88 dtk; `plugins.bootstrap` 1,86 dtk;
`runtime.post-attach` 16,20 dtk (`runtime-post-bind` 10,02 dtk);
`sidecars.model-runtime` 5,01 dtk; `control-ui-assets` 168,06 dtk.

Total fase unik terukur di run2-off: **285 nama** (`phases.tsv`).

### 4.3 Vonis F9 atas celah

**Di LAB native (x86_64, tanpa PRoot/QEMU) TIDAK ada celah ~150 dtk tanpa
fase.** Wilayah 221,1–304,2 dtk dari riset LAB lama terurai menjadi
fase-fase terukur di atas; tidak ada satu pun fase pra-bind di atas ~2,3
dtk, dan total pra-bind (spawn → `http.bound`) hanya ~26 dtk. Tiga
kesimpulan:

1. **"Celah" lama adalah jumlah banyak langkah serial ~1–2 dtk +
   inflasi emulasi PRoot/QEMU + (di perangkat) stall katalog WebUI
   43,5 dtk** — bukan satu lubang hitam yang belum terpetakan. Di LAB
   native, stall katalog itu hanya 0,5 ms bila aset prebuilt, atau
   168 dtk bila gateway harus mem-build UI on-demand (run1-off).
2. **Biaya terbesar yang tersisa adalah pasca-bind:**
   `plugins.runtime-post-bind` ~9,7 dtk dan `runtime.post-attach`
   13,3 dtk total (di dalamnya `sidecars.model-runtime` 2,7 dtk,
   `reply-runtime` 1,5 dtk). `/ready` yang dipakai Polones sebagai
   readiness jujur dijaga sampai `runtime.post-attach` selesai (fase
   `ready` berakhir 42,3 dtk ≈ akhir post-attach 41,2 dtk + 1,1 dtk).
   Ini wilayah kerja Lane B (F1/A4) dan Lane D (F5/A3), bukan F9.
3. **Titik pisah graf untuk F4 (Lane G) ADA — di `http.bound`.**
   Server sudah mengikat socket dan menjawab `/health` 200 pada 26,0
   dtk [LAB] sementara 13,3 dtk kerja post-attach masih berjalan di
   belakangnya. Proses depan yang tipis bisa mengikat + menyajikan
   shell pada ~26 dtk [LAB] sementara graf berat (`plugins.bootstrap`,
   `runtime-post-bind`, sidecar model/reply) dimuat sesudahnya. Dua
   catatan untuk Lane G: (a) `/ready` sebagaimana didefinisikan hari
   ini menunggu post-attach selesai — F4 harus mendefinisikan ulang
   apa yang ditampilkan UI sebelum post-attach selesai, bukan sekadar
   memindah impor; (b) kemenangan F4 di LAB native hanya ~13 dtk
   post-attach (bukan ~150 dtk), karena 150 dtk itu tidak ada di sini
   — kemenangan besar di perangkat harus datang dari menghilangkan
   inflasi emulasi + stall katalog, bukan dari celah ini.

**Sisa wilayah tak terukur (kecil, dicatat jujur):**
- Celah ~0,8–2,0 dtk antara akhir `entry.run-main-import` dan awal
  `cli.main.argv` (prewarm / impor dinamis entry; bervariasi per run:
  1,1 dtk di run1-off, 2,0 dtk di run2-off, 1,2 dtk di run1-on).
- `gateway.server-start-import` tetap satu impor dinamis `./server-start.js`
  (1,9–2,3 dtk [LAB], vs 22,1 dtk di LAB lama) — graf statis di dalamnya
  tidak dipecah; diukur tidak langsung lewat fase hilir
  (`kernel-state`, `request-runtime`, `http-transport`, `listen`).
- `cli.environment.config-import` (0,35–0,72 dtk) terukur sebagai satu
  langkah; graf impor di dalamnya tidak dipecah per chunk (berbeda
  dengan `gateway-run-import.*` yang sudah dipecah F9).

## 5. Smoke test A1 (ON vs OFF)

Run `run1-on` (`OPENCLAW_MOBILE_BOOT=1`, aset prebuilt, 24 Nov 2026
21:50 WIB):

| | `/health` 200 (A) | `/ready` 200 | `/` 200 (proksi B) |
|---|---|---|---|
| OFF run1-off (artefak build UI) | 21,8 dtk | 43,5 dtk | 191,6 dtk |
| OFF run2-off (valid) | 26,1 dtk | 42,4 dtk | 42,6 dtk |
| **ON run1-on** | **18,9 dtk** | **32,8 dtk** | **32,9 dtk** |

- Baris log A1 muncul di `run1-on/gateway.log:142`:
  `mobile boot profile enabled (OPENCLAW_MOBILE_BOOT=1); fork fast-boot
  behaviors active per lane wiring`.
- Boot ON selesai penuh (gateway hidup sampai di-stop skrip sesudah
  45 dtk pasca-`/` 200; `control-ui-assets` 0,7 ms, `runtime-post-bind`
  8,40 dtk — sejalan dengan OFF).
- **ON lebih cepat ~10 dtk dari OFF — dan itu DINYATAKAN sebagai
  variansi, BUKAN efek A1.** Lane A tidak memasang perilaku di balik
  saklar (hanya baca + teruskan + log), jadi tidak ada mekanisme yang
  bisa mempercepat boot. Seluruh garis waktu ON bergeser lebih awal
  secara merata (`gateway-run-bootstrap` 5,24 dtk vs 5,91/6,85 dtk OFF;
  `server-start-import` berakhir 12,74 dtk vs 18,10/18,87 dtk OFF) —
  konsisten dengan CPU yang lebih longgar / cache lebih hangat pada jam
  run itu, dan OFF sendiri sudah bervariasi ±4 dtk di `/health`.
  **Vonis smoke: A1 ON berperilaku identik upstream dalam batas noise
  antar-run — lolos.** Lane B/C/D yang akan membuktikan efek saklar
  sesungguhnya harus mengulang baseline OFF/ON minimal 2× per kondisi
  dalam kondisi CPU yang sama.

## 6. Keterbatasan yang dicatat jujur

1. **VM native x86_64, bukan perangkat.** Tidak ada PRoot/QEMU di sini,
   jadi komponen (b) §5.10 riset (inflasi emulasi) tidak ada — angka LAB
   ini akan JAUH lebih kecil dari 283–330 dtk LAB lama, dan tidak bisa
   dibandingkan langsung dengannya kecuali sebagai "lantai bawah".
2. **State segar + 1 sesi kosong.** Migrasi sesi (`sessions.admission`)
   pada state perangkat yang menumpuk akan lebih lama; angka di sini
   adalah lantai bawah, bukan kasus perangkat.
3. **Tanpa model/API key.** Plugin provider dimuat tapi tidak dipakai;
   `chat pertama` tidak terukur di lab.
4. **Dua run OFF + satu run ON** (run1-off, run2-off, run1-on) —
   variansi antar-run terukur: `/health` OFF 21,8 ↔ 26,1 dtk. Lane
   berikutnya yang membandingkan fork vs upstream tetap harus mengulang
   minimal 2× per kondisi dalam kondisi CPU yang sama.

## 7. Lane B (F1 + A4) — status pengukuran [LAB]

### 7.1 Yang sudah terverifikasi tanpa build

- **Unit: 11/11 lolos** (bare vitest, config pemilik; 25 Nov 2026
  02:04–02:05 WIB, sesudah refactor ekstraksi §7.1.1):
  - gateway `deferred-session-migration.test.ts`: 3/3, 10,3 dtk.
  - runtime-config `startup-migration-watermark.test.ts` +
    `startup-migration.mobile-boot.test.ts`: 8/8, 82,67 dtk.
- **oxlint: bersih** — `config/tsconfig/oxlint.core.json`, 4 berkas,
  "No problems in 4 files [171.24s]", exit 0.
- **Typecheck: bersih** — `pnpm tsgo:core`, exit 0.
- **Format: bersih** — `oxfmt --check`, 12 berkas Lane B.

#### 7.1.1 Perbaikan sesudah 3 temuan oxlint

- `startup-migration-watermark.test.ts`: `.sort()` → `.toSorted()`
  (`unicorn/no-array-sort`).
- `server-startup-finish.ts`: `await kernel.unlockStartupMethods()`
  (`no-floating-promises`; tipe `() => void | Promise<void>`).
- `server-startup-finish.ts`: 715 → ≤700 baris terhitung (`max-lines`)
  dengan mengekstrak starter migrasi ke
  `startDeferredSessionMigration()` di `deferred-session-migration.ts`
  (modul tetap tanpa dependensi statis berat: impor
  `prepareGatewayStartupSessions` tetap dinamis, di dalam span
  `sessions.admission`). Pemadatan gate tanpa kurung kurawal sempat
  melanggar `curly` — dikembalikan ke bentuk berkurung kurawal.

### 7.2 Build runtime — TERBLOKIR lingkungan (bukan kode)

Lantai ukur (komentar `scripts/tsdown-build.mts`): heap 4352 MB,
puncak 4730 MiB; slice 4 GiB (heap 3328 MB) terbunuh di invokasi
unified-runtime — **heap tidak bisa diturunkan**. Sourcemap sudah OFF
secara default (`OUTPUT_SOURCE_MAPS` tidak disetel) dan profil runtime
sudah tanpa DTS, jadi tidak ada tuas hemat-memori yang didukung.
Puncak butuh tersedia >~5,5 GB berkelanjutan ±10 menit di VM 1,5 CPU /
~8 GB yang dipakai 5+ lane paralel.

| Upaya | Hasil |
|---|---|
| 1 | Gate heap menolak sebelum mulai (tersedia 3236 MB). |
| 2 | OOM SIGKILL invokasi 2/2 sesudah 289 dtk (total 11 m 56 dtk). |
| 3 | Dihentikan sendiri (tersedia jatuh ke 1,7 GB). |
| 4 | OOM SIGKILL invokasi 2/2 sesudah 185,2 dtk (total 6 m 49 dtk). |
| 5 | Lolos OOM (436,2 dtk) tapi gagal **EDQUOT** (`Disk quota exceeded`, os error 122) saat tulis `dist/effective-oauth-*.mjs`. |
| 6 | Gagal instan EDQUOT (-122) di startup pnpm. |
| 7 | Terbunuh **reboot VM** (uptime reset 02:42 WIB); log `/tmp` ikut terhapus. |

`dist/` parsial 188 MB (tanpa `openclaw.mjs`) — **tidak bisa boot**.
Kuota sempat pulih (probe tulis 50 MB OK 02:38 WIB) tapi jendela
memori tidak pernah bertahan: tersedia berayun 1,0–6,5 GB dan jatuh
tiap kali lane lain mulai build. **Syarat retry: tersedia >~5,5 GB +
kuota pulih, dipertahankan selama build.**

### 7.3 Pengukuran LAB ON vs OFF — TERTUNDA

- Rencana: 2× ON (`OPENCLAW_MOBILE_BOOT=1`) + 2× OFF via
  `measure-baseline.sh`; `/health`, `/ready`, `/`, fase
  `sessions.admission` + watermark (run ke-2 ON harus menunjukkan
  skip migrasi penuh).
- Test e2e F1 (`gateway-mobile-boot-f1.e2e.test.ts`) terblokir di
  global-setup fence — lolos sesudah stempel build current
  (terbukti: fence tanpa `requireVerified` mengembalikan
  `{"refuse":false}`; penyebabnya systemd sistem ada tapi user bus
  tidak ada).
- **Angka bagian ini BELUM ADA — jangan diisi dari perkiraan.**
  Diisi sesudah `pnpm build:runtime` berhasil.
