# LAPORAN — Rombak Arsitektur OpenClaw: Mobile Fast Boot (Fork)

> **Status:** INTEGRASI SELESAI (5 lane: B/C/D/E/F merge ke `mobile-fast-boot` `7e0fe28d` + `b07d3587`, 25 Nov 2026); Lane G TERBLOKIR pemberitahuan keamanan (menunggu keputusan Lead/pemilik); build `dist/` terintegrasi + ukur LAB terintegrasi menunggu jendela sepi VM (waiter berjalan).
> **Basis:** `openclaw/openclaw` @ tag `v2026.11.6` (commit `06afb10d3272cc9deaf38ca6a3b7b839d5935638`).
> **Repo fork lokal:** `~/workspace/openclaw-fork/` (remote `ngabzar05/openclaw` BELUM ada — fork 403, butuh admin org; pemilik yang buat).
> **Target:** definisi B — "Buka → bisa dipakai dalam hitungan detik"; definisi A sedekat mungkin. Lantai gateway puluhan detik tetap berlaku.

## 0. Persetujuan pemilik (dicatat)

- **25 Nov 2026 03:14 WIB** — pemilik memerintahkan rombak penuh ("benar-benar merombaknya agar startnya cepat; tidak masalah jika saat ada update harus berusaha lebih keras; yang penting ada arahan dokumentasi yang detail, lengkap, dan super komprehensif agar setiap ada update nantinya bisa dilakukan oleh AI agent dengan presisi").
- **25 Nov 2026 03:24 WIB** — pemilik menjawab **"oke lanjut"** atas pertanyaan keamanan dalam kata-kata biasa: *"Clone source OpenClaw ini bisa menjalankan kode saat diproses (clone, modifikasi, build, test). Apakah kamu setuju saya memprosesnya meski ada risiko itu?"* Jawaban ini dicatat sebagai **persetujuan eksplisit** untuk memproses clone (clone, modifikasi, build, test) source OpenClaw @ `v2026.11.6`.
- **Batas arsitektur:** PERTAHANKAN Opsi A — Gateway pemilik tunggal, WebUI dipertahankan (keputusan pemilik 24 Nov 2026).
- **25 Nov 2026 05:02 WIB** — pemilik memerintahkan **"implementasikan TOTAL sampai selesai"** (pemilik tidur; pekerjaan harus selesai saat ia bangun). Wewenang delegasi keputusan (5 Nov 2026) dipakai; berhenti hanya bila ada pemblokir sejati.
- **25 Nov 2026 ~23:41 WIB (Lane G #2)** — runtime mengeluarkan **pemberitahuan keamanan sistem BARU** atas hasil `pnpm install` di worktree lane-g (execution-risk check) yang melarang menjalankan/menginstal/build/test konten itu sampai user memutuskan. Lane G berhenti sesuai instruksi. TIDAK ada kartu persetujuan tertunda (`permissions.list_pending` kosong) dan tidak ada catatan di `permissions.history` — pemberitahuan disampaikan runtime langsung ke agen, sama polanya dengan pemberitahuan clone 03:12/03:23 WIB. **Keputusan yang dibutuhkan:** apakah konfirmasi pemilik 03:24 WIB ("oke lanjut" atas clone/modifikasi/build/test) mencakup langkah `pnpm install`/build/test di lane-g (dan semua lane), atau diperlukan jawaban eksplisit baru. Koordinator TIDAK memutuskan sendiri (pelajaran koreksi 03:23 WIB).

## 1. Desain

Desain lengkap: `docs/mobile-fast-boot/DESIGN.md` (di repo fork; sumber: `~/workspace/research-start/DESAIN-mobile-fast-boot.md`, 236 baris).
Spesifikasi detail: `~/workspace/research-start/per-harness/openclaw.md` §9.0–§9.6 + §10 + §5.5/§5.7/§5.8/§5.9/§5.10.

Ringkasan arsitektur baru: proses depan tipis (ikat socket dulu, graf-sisa impor dinamis sesudah `http.bound` — F4); semua yang berat ke latar/malas (F1/F3/F5/A3/A4); lock fast-path (F2); UI tidak menunggu katalog (W1–W3); satu saklar `OPENCLAW_MOBILE_BOOT=1` (A1); guardrail N1–N10.

## 2. Status lane

| Lane | Cakupan | Status | Keterangan |
|---|---|---|---|
| A | A1 (saklar) + F9 (instrumentasi) + baseline LAB | ✅ SELESAI (24 Nov 2026) | Prasyarat semua lane lain. A1: saklar + plumbing titik masuk (tanpa perubahan perilaku); F9: 15+ nama fase baru, 285 fase terukur; baseline 2× OFF + 1× ON, lihat §3 + `docs/mobile-fast-boot/MEASUREMENT.md` |
| B | F1 (defer admission) + A4 (migrasi inkremental) | ✅ SELESAI + MERGE (25 Nov 2026) | Commit `38937a07`; test unit 11/11; tsgo exit 0; oxlint bersih; LAB tertunda (build terblokir — 7 upaya gagal: OOM/EDQUOT/reboot VM). MEASUREMENT.md §9 |
| C | F2 (fast-path lock) | ✅ SELESAI + MERGE (25 Nov 2026) | Commit `bbef1646` + `6c24ffc5`; test single-owner 5/5 + regresi lock 163 + resolver 24/24; tsgo exit 0; build `pnpm build:runtime` exit 0 (12m6s); LAB TERUKUR: bersih ON ≈ OFF (noise); kotor ON menyelamatkan boot yang OFF-nya gagal (hemat ~82 dtk). MEASUREMENT.md §8; artefak `~/workspace/lane-c-lab/` |
| D | F5 (capture async + lazy plugin) + A3 (cache rencana plugin) | ✅ SELESAI + MERGE (25 Nov 2026) | Commit `fddd35a9`; test 18/18; tsgo exit 0; 6 kegagalan regresi terbukti bukan regresi (kontrol basis); F5b SENGAJA tidak diimplementasikan (butuh design review); LAB tertunda (build terblokir). Dokumen `F5-A3-PLUGIN-LAZY-PLAN-CACHE.md` §7 (prosedur ukur) |
| E | W1/W2/W3 (katalog malas + cache + bundle ringan) | ✅ SELESAI + MERGE (25 Nov 2026) | Commit `08af5d9d`; test 33/33; tsgo core+ui exit 0; LAB tertunda (§7.3/§7.4 TBD — butuh `dist/`); W3: tidak ada impor berat yang perlu dipindah. MEASUREMENT.md §7 |
| F | F3 (pecah bootstrap) + F6 (code-split entry) + F8 (matikan update) + D2 (hapus prebuild non-arm64) | ✅ SELESAI + MERGE (25 Nov 2026) | Merge `7e0fe28d`; branch `lane-f/f3-f6-f8-d2`. F3: preflight core-only + import runtime lazy + snapshot malas (semua digated A1; penegakan plugin-invalid pindah ke `run.ts`, exit 78 tetap). F6: `src/entry-gateway.ts` + routing `openclaw.mjs` (gated A1) + prewarm `server-start.js` paralel. F8: tolak admission (exit 2) + skip update check pasca-attach. D2: skrip prune, 41 target / 1365,4 MiB di pohon install (prod ~60,4 MiB). Test: D2 5/5, F6 4/4, F8 10/10, F3 18/23 (5 timeout load, 0 gagal asersi; kontrol pristine membuktikan bukan regresi); oxlint 0 error. **TERBUKA: typecheck tsgo (terbunuh SIGTERM), build `dist/` + LAB 2× ON/OFF (terblokir sumber daya: `ui:build` OOM exit 137, tsdown butuh ≥4,4 GB heap vs ~1 GB tersedia, restart berulang). Resep + status lengkap: `docs/mobile-fast-boot/LANE-F.md`, `D2-PREBUILD-PRUNE.md`, `MEASUREMENT.md` §10–11. |
| G | F4 (early-listen / proses depan tipis) | 🟡 KODE SELESAI, TERBLOKIR (25 Nov 2026) | KODE + TEST + DOKUMEN SELESAI (Lane G #2) tapi BELUM commit/build/test/ukur — TERBLOKIR pemberitahuan keamanan sistem atas `pnpm install` (lihat §0). Titik pisah ADA di `http.bound` (~26 dtk [LAB]); kemenangan di LAB native ~13 dtk post-attach. Lihat §3 vonis F4 |
| H | Dokumentasi (rebase guide, build/publish, guardrail, verifikasi) | ✅ SELESAI (25 Nov 2026) | Commit `551ae494`; 4 dokumen, 1.480 baris. Butir [BELUM TERUKUR] menunggu Lane A/G + ronde perangkat (lihat VERIFY.md §5). |

**Yang TIDAK dikerjakan:** F7 (compile cache jadi — DITOLAK); A2-R2 (shim health — DITOLAK); D1/D5/D6/D7/D8 (dilarang/belum terbukti).

## 3. Baseline LAB (diisi Lane A)

Semua angka **[LAB]** (VM x86_64 native, Node v24.22.1, state segar, 1 sesi
kosong, tanpa PRoot/QEMU). Detail lengkap + garis waktu per fase:
`docs/mobile-fast-boot/MEASUREMENT.md` §4–§5. Artefak run:
`/tmp/lane-a-lab/{run1-off,run2-off,run1-on}/`.

| Pengukuran | Upstream 2026.11.6 [LAB] | Fork [LAB] |
|---|---|---|
| Spawn → `GET /health` 200 pertama (definisi A) | **21,8 dtk** (run1-off) / **26,1 dtk** (run2-off) | _belum diukur_ (A1 ON: 18,9 dtk — variansi, bukan efek saklar; lihat §5 MEASUREMENT.md) |
| Spawn → `/ready` 200 pertama | **43,5 dtk** (run1-off) / **42,4 dtk** (run2-off) | _belum diukur_ (A1 ON: 32,8 dtk — variansi) |
| Spawn → Control UI shell `GET /` 200 pertama (proksi definisi B; chat pertama TIDAK terukur di lab — butuh model/API key) | **42,6 dtk** (run2-off, aset prebuilt) — run1-off 191,6 dtk adalah artefak: gateway mem-build Control UI on-demand 168,1 dtk karena `dist/control-ui/` belum ada | _belum diukur_ |
| Per fase (durasi [LAB], run2-off) | bootstrap/config-ready 6,9 dtk (`plugin-config` 1,6; `state-snapshot` 1,7; `webhook-readiness` 1,9); `gateway-lock` 1,6 dtk; `server-start-import` 1,9 dtk; `sessions.admission` 1,6 dtk; `plugins.bootstrap` 1,5 dtk; `http.bound` 26,0 dtk; `plugins.runtime-post-bind` **9,7 dtk**; `runtime.post-attach` 13,3 dtk; `post-ready.maintenance` 4,8 dtk (sesudah ready) | _belum diukur_ |
| Stall katalog WebUI | 43,5 dtk (dikutip dari riset — perangkat) | [LAB] `sidecars.control-ui-assets`: **0,5 ms** bila aset prebuilt; **168,1 dtk** bila gateway harus build UI on-demand (run1-off) |

**Vonis F9 atas celah (Lane A):** di LAB native TIDAK ada celah ~150 dtk
tanpa fase — wilayah 221,1–304,2 dtk riset lama terurai menjadi fase-fase
terukur; biaya terbesar adalah pasca-bind (`runtime-post-bind` 9,7 dtk +
`post-attach` 13,3 dtk). **Titik pisah graf untuk F4 ADA di
`http.bound`** (~26 dtk [LAB]): server menjawab `/health` 200 sementara
13,3 dtk kerja post-attach masih berjalan — proses depan tipis layak
secara teknis, dengan catatan `/ready` hari ini menunggu post-attach
selesai (F4 harus mendefinisikan ulang apa yang ditampilkan UI sebelum
itu) dan kemenangan di LAB native hanya ~13 dtk, bukan ~150 dtk.
Sisa tak terukur: celah entry ~0,8–2,0 dtk (prewarm) + graf di dalam
`gateway.server-start-import` (satu impor dinamis, 1,9 dtk [LAB]).

Catatan: semua angka [LAB] (VM x86_64, Node 24.22.1). Angka perangkat [BELUM TERUKUR]. Baseline perangkat S1 (video 25 Nov 02:39 WIB, v0.1.120): A ~95 dtk, B >135 dtk.

## 4. Hasil ukur vs baseline (integrasi)

### 4.1 Merge terintegrasi (25 Nov 2026)

Branch `mobile-fast-boot` HEAD `b07d3587` (merge F `7e0fe28d` + docs §8 `b07d3587`).
Rantai merge: `1d9ecf44` → E `d6a4969e` → D `53384fb8` → C `ebcc0998` → B
`e5432d5c` → F `7e0fe28d` → docs `b07d3587`. Konflik merge: `MEASUREMENT.md`
(3×, diselesaikan dengan mempertahankan semua seksi lane + renumber: E §7, C
§8, B §9, F §10–11) dan `server-startup-post-attach.ts` (1 baris impor —
diambil versi Lane F karena memakai nilai `MOBILE_BOOT_DISABLED` yang
didefinisikan di `mobile-boot.ts`). `server-startup-finish.ts`,
`server-startup-bootstrap.ts`, `mobile-boot.ts` auto-merge bersih. Lane G
(F4) TIDAK ikut merge (kode belum commit, terblokir pemberitahuan keamanan —
lihat §0).

### 4.2 Angka ukur per lane (yang sudah terukur — [LAB])

**F2 (Lane C, satu-satunya angka boot LAB per lane, 25 Nov ~03:41–03:54 WIB,
2× per kondisi, `dist/` lane-c):**

| Kondisi | `/health` 200 (A) | `/ready` | `/` (proksi B) | Lock step |
|---|---|---|---|---|
| Bersih OFF | 21,419 / 21,333 dtk | 37,162 / 36,397 | 37,391 / 36,589 | 1.978 / 1.492 ms |
| Bersih ON | 25,766 / 22,037 dtk | 40,994 / 36,880 | 41,314 / 37,301 | 962 / 979 ms |
| Kotor OFF | — exit 1 @ **104,616 / 104,468 dtk**, tanpa `/health` | — | — | 2.059 / 1.627 ms |
| Kotor ON | **21,423 / 22,867 dtk** | n/a | n/a | 1.612 / 1.896 ms |

Vonis F2: bersih ON ≈ OFF dalam noise; **kotor ON menyelamatkan boot yang
tadinya gagal** (OFF mati sesudah tunggu heartbeat 95 dtk; ON `/health` 200
identik boot bersih — hemat ~82 dtk). † Skrip kotor hanya mem-poll `/health`
di fase 3 (lalu berhenti 20 dtk sesudahnya) — `/ready` dan `/` tidak
tercatat untuk run kotor, bukan gagal. Artefak: `~/workspace/lane-c-lab/`
+ `~/workspace/f2-measure.log`.

**Lane lain (belum terukur — terblokir `dist/`):** B (LAB tertunda, 7 upaya
build gagal), D (LAB tertunda), E (§7.3/§7.4 TBD), F (LAB tertunda). Bukti
perilaku setara (bukan pengganti angka) ada di test handler tiap lane
(panggilan 1 core-only + pending dalam ms; snapshot hit tanpa `acquire`
tambahan; dsb.).

### 4.3 Ukur LAB terintegrasi (ON vs OFF) — MENUNGGU BUILD

Build `dist/` terintegrasi menunggu jendela sepi VM (butuh MemAvailable
≥5.500 MB + load1 < 8 selama ±12 mnt; resep terbukti Lane C: `pnpm
build:runtime` exit 0 dalam 12m6s). Waiter build integrasi berjalan
(`~/workspace/integration-build-waiter.sh`, log
`~/workspace/integration-build-waiter.log`; `pnpm install --frozen-lockfile`
di repo utama SUDAH selesai exit 0, 2m1d, `node_modules` 109 entri).
Sesudah build berhasil: ukur LAB 2× per kondisi (ON vs OFF) dengan
`docs/mobile-fast-boot/measure-baseline.sh` + cek WebUI bisa-dipakai, lalu
isi tabel di bawah ini.

| Pengukuran | Upstream 2026.11.6 [LAB] | Fork terintegrasi [LAB] |
|---|---|---|
| Spawn → `GET /health` 200 pertama (definisi A) | 21,8 / 26,1 dtk | _belum diukur_ |
| Spawn → `/ready` 200 pertama | 43,5 / 42,4 dtk | _belum diukur_ |
| Spawn → Control UI shell `GET /` 200 pertama (proksi definisi B) | 42,6 dtk | _belum diukur_ |

## 5. Yang masih butuh pemilik

1. **Jawaban atas pemberitahuan keamanan sistem Lane G** (lihat §0) — apakah `pnpm install`/build/test fork boleh dilanjutkan (ideal: mencakup semua lane). Tanpa jawaban ini, F4 (inti arsitektur: proses depan tipis) tidak bisa di-commit/build/ukur.
2. **Remote `ngabzar05/openclaw`** — fork via web GitHub ke org `ngabzar05` (403, akun `azqifaiq02` bukan admin org), atau repo kosong + push.
3. **Integrasi ke Polones** (langkah terpisah sesudah verifikasi): re-pin `scripts/openclaw/build.sh` + `release-pin.sha256` + test kontrak hash ke artefak fork.
4. **Prestart ON + warm-run 7.5** (keputusan pemilik terpisah — satu-satunya jalan ke "terasa instan" tanpa fork).
5. **Mesin build ber-heap besar (bila VM ini tidak cukup):** build `dist/` butuh heap 4.352 MB + MemAvailable ≥5.500 MB selama ±12 mnt. Bila jendela sepi VM tidak pernah terbuka, ukur LAB terintegrasi + per-lane (B/D/E/F/G) butuh mesin/CI dengan heap ≥4,4 GB. Vonis perangkat (S1/S2/S3) tetap menunggu pemilik.
