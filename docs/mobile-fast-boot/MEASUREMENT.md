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

---

# Pengukuran Lane F — F3 + F6 + F8 + D2 (STATUS: LAB BOOT TERBLOKIR)

> **Status 25 Nov 2026 ~01:40 WIB: angka LAB ON vs OFF BELUM ADA.**
> Boot LAB membutuhkan `dist/` (tsdown) + aset Control UI prebuilt
> (`pnpm ui:build`). Keduanya gagal diselesaikan di VM ini selama Lane F
> berjalan, BUKAN karena kode Lane F, melainkan karena sumber daya mesin:
>
> - `pnpm ui:build`: percobaan 1 gagal — Vite transport invoke timeout
>   60 dtk (`control-ui-i18n-catalog.ts`, 5123 modul sudah ter-transform);
>   percobaan 2 terbunuh restart runtime; percobaan 3 gagal — lock basi
>   `.artifacts/dist-artifacts.lock` dari percobaan 2 (dibersihkan);
>   percobaan 4/5/6 gagal instant — EPERM intermiten pada redirect log
>   dan pada tulis lock (fs-safe); percobaan 7 (log ke `~/workspace`)
>   berjalan 8m16d sampai precompression 1146 aset lalu **terbunuh OOM
>   (exit 137)** — memori tersedia saat itu ~1,8 GB, load ~22.
> - `tsdown` (langkah `pnpm build`): belum dicoba — guard heap menuntut
>   ≥4.352 MB (`OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB`), sementara memori
>   tersedia 1,0–2,7 GB selama Lane F berjalan; menjalankan build 4,7 GB
>   ke mesin sekecil itu akan OOM seperti `ui:build` dan berisiko
>   membunuh pekerjaan lane lain. **JANGAN ulangi build saat memori
>   tersedia <4,5 GB.**
> - Runtime restart berulang (±3×) mematikan job latar yang panjang
>   (vitest, proof, build) di tengah jalan; artefak yang selamat hanya
>   yang tertulis ke disk persisten.
>
> Artinya: **tidak ada `/health`, `/ready`, `/`, atau angka sub-langkah
> bootstrap ON vs OFF dari Lane F.** Bagian ini mendokumentasikan apa
> yang SUDAH terukur/diverifikasi tanpa `dist/`, dan resep persis untuk
> menjalankan LAB sesudah `dist/` tersedia — agar lane integrasi (atau
> Lane F lanjutan) tidak mengulang pekerjaan ini.

## 7. Yang sudah terverifikasi tanpa `dist/` (Lane F)

### 7.1 Test unit/integrasi (vitest, semua hijau kecuali timeout load)

| Test | Hasil |
|---|---|
| D2 `test/scripts/mobile-fast-boot-prune-prebuilds.test.ts` (tooling) | **5/5 lolos** |
| F6 `src/entry-gateway.test.ts` (unit) | **4/4 lolos** |
| F8 `src/cli/run-main-update-admission.test.ts` (cli) | **10/10 lolos** (7 lama + 3 baru) |
| F3 `src/commands/config-preflight-snapshot.test.ts` (commands) | **18/23 lolos; 5 timeout 120 dtk, 0 gagal asersi** — termasuk 2/3 test baru F3 lolos di run penuh (`runStartupConfigPreflight` ON 111,2 dtk; N5 core-invalid 4,4 dtk) dan test ke-3 lolos solo (48,7 dtk). 5 timeout: 4 test lama OFF + 1 test baru — semuanya timeout, bukan asersi. Kontrol pristine: `shares startup validation` gagal JUGA tanpa perubahan Lane F (timeout); `overlaps config discovery` lolos di pristine (46,7 dtk) DAN lolos dengan perubahan Lane F saat sendirian (108,1 dtk) → timeout flaky karena load 10–26, bukan regresi. Durasi langkah tunggal terukur 35,6 dtk (`database-readiness`) di lingkungan ini vs ~1 dtk normal. |
| Oxlint 18 berkas tersentuh (biner langsung; wrapper `run-oxlint.mjs` gagal di fase persiapan — timeout artifact 300 dtk karena load, bukan temuan lint) | **0 warning, 0 error** |
| Typecheck `tsgo:core` | **BELUM SELESAI — terbunuh SIGTERM (exit 143)** sesudah ~7 mnt (mesin kehabisan memori / restart runtime; log `~/workspace/lane-f-logs/tsgo.log` hanya mencatat `[tsgo] FAILED (exit 143)`). Typecheck penuh belum pernah hijau di branch ini. |

### 7.2 D2 — penghematan ukuran (terukur, tanpa `dist/`)

Dry-run skrip prune atas pohon `pnpm install` lane-f
(`node_modules/.pnpm`, linux-x64): **41 target, 1365,4 MiB total.**
Subtotal yang relevan dengan APK (prod + task-named): **~60,4 MiB**
(pi-tui 5 berkas ~108 KiB; resvg 4,2 MiB; node-pty ~1,1 MiB;
fs-safe 4,6 MiB; proc-safe 2,4 MiB; cua-driver 47,9 MiB). Sisanya
~1.305 MiB adalah dev/transitif (konteks pohon install, BUKAN klaim
APK). Keeper linux-arm64 terverifikasi TIDAK ditargetkan. Detail +
caveat codex: `docs/mobile-fast-boot/D2-PREBUILD-PRUNE.md`.

### 7.3 Efek yang diperkirakan (hipotesis terukur, menunggu LAB)

- **F3(a):** ~0 dtk wall di LAB (plugin-config paralel penuh dengan
  rantai readiness). Nilai di perangkat (I/O emulasi) + via A3.
- **F3(b):** 0 (netral perilaku, sengaja).
- **F3(c):** ~0 di LAB state segar (eager sudah short-circuit); hemat
  nyata pada warm state.
- **F6 prewarm:** potensial ~1,9 dtk (`gateway.server-start-import`
  menjadi cache-hit), dikurangi kompetisi CPU/disk dengan preflight —
  efek bersih HARUS diukur, bisa nol/negatif.
- **F8:** ~0 dtk boot (update check memang deferred); efeknya
  penghapusan jalur, bukan kecepatan.
- **D2:** ~0 dtk boot; hanya ukuran paket.

## 8. Resep LAB Lane F (untuk integrasi / lanjutan)

Jalankan HANYA bila memori tersedia ≥4,5 GB dan load <5
(cek `free -m` + `uptime` dulu; bila tidak memenuhi, JANGAN mulai —
build akan OOM dan membunuh pekerjaan lane lain):

1. `pnpm ui:build` (aset Control UI prebuilt; bila gagal timeout
   transport Vite 60 dtk, tunggu load reda lalu retry sekali —
   jangan ubah kode karena timeout itu).
2. Langkah tsdown inti SAJA (bukan full `pnpm build`):
   `OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB=4608 node --import
   ./scripts/tsx.mjs scripts/build-all.mts tsdown`
   (bila guard tetap menolak / OOM, laporkan blocked dengan bukti
   persis — jangan paksa).
3. `--version` via kedua entry:
   `node openclaw.mjs --version` (OFF, entry.js) dan
   `OPENCLAW_MOBILE_BOOT=1 node openclaw.mjs --version` (ON,
   entry-gateway.js). Keduanya harus mencetak versi yang sama.
4. Smoke boot + `openclaw health` (ON dan OFF).
5. Ukur dengan skrip yang sama seperti Lane A (jangan ubah skrip):
   `docs/mobile-fast-boot/measure-baseline.sh lanef-run1-off`,
   `lanef-run2-off`, `lanef-run1-on`, `lanef-run2-on`
   (label baru — JANGAN menimpa artefak Lane A di `/tmp/lane-a-lab/`;
   artefak Lane F di `/tmp/lane-f-lab/<label>/`).
   Tiap run: `OPENCLAW_GATEWAY_STARTUP_TRACE=1`, state segar, port
   18789, sleep 45 dtk pasca-`/` 200.
6. Isi tabel di bawah dari `timings.tsv` + `phases.tsv` tiap run.
   Periksa juga di `phases.tsv` ON: tidak ada
   `post-attach.update-check`, dan baris log
   `mobile boot: self-update check disabled` ada (F8); langkah
   `admission.plugin-config` ada tapi tanpa
   `admission.plugin-metadata-completion` (F3a); dan
   `gateway.server-start-import` mengecil vs OFF (F6 prewarm).

### 8.1 Definisi A + B (proksi) + `/ready` — Lane F (ISI SESUDAH LAB)

| Run | `OPENCLAW_MOBILE_BOOT` | `/health` 200 pertama (A) | `/ready` 200 pertama | `/` 200 pertama (proksi B) |
|---|---|---|---|---|
| lanef-run1-off | OFF (kosong) | — | — | — |
| lanef-run2-off | OFF (kosong) | — | — | — |
| lanef-run1-on | `=1` | — | — | — |
| lanef-run2-on | `=1` | — | — | — |

### 8.2 Per fase (ISI SESUDAH LAB)

Bandingkan khususnya: `gateway-run-bootstrap` / `config-ready`
(`admission.plugin-config`, `admission.state-snapshot`,
`admission.database-runtime-import`, `admission.session-runtime-import`,
`admission.database-readiness`), `gateway.server-start-import`,
`gateway-lock`, `sessions.admission`, `plugins.bootstrap`,
`plugins.runtime-post-bind`, `runtime.post-attach`.

### 8.3 Keterbatasan yang berlaku juga untuk LAB Lane F

Sama seperti §6 (VM native x86_64, state segar + 1 sesi kosong, tanpa
model/API key — chat pertama tidak terukur di lab), ditambah: variansi
antar-run di lingkungan ini sangat besar (test yang sama bervariasi
46 ↔ 131 dtk) — 2× per kondisi adalah minimum, dan perbedaan <±4 dtk
di `/health` harus dinyatakan sebagai noise, bukan efek lane.
