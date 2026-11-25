# LAPORAN — Rombak Arsitektur OpenClaw: Mobile Fast Boot (Fork)

> **Status:** DALAM PEKERJAAN — clone selesai @ 06afb10d (v2026.11.6), branch `mobile-fast-boot`; Lane A + H dimulai.
> **Basis:** `openclaw/openclaw` @ tag `v2026.11.6` (commit `06afb10d3272cc9deaf38ca6a3b7b839d5935638`).
> **Repo fork lokal:** `~/workspace/openclaw-fork/` (remote `ngabzar05/openclaw` BELUM ada — fork 403, butuh admin org; pemilik yang buat).
> **Target:** definisi B — "Buka → bisa dipakai dalam hitungan detik"; definisi A sedekat mungkin. Lantai gateway puluhan detik tetap berlaku.

## 0. Persetujuan pemilik (dicatat)

- **25 Nov 2026 03:14 WIB** — pemilik memerintahkan rombak penuh ("benar-benar merombaknya agar startnya cepat; tidak masalah jika saat ada update harus berusaha lebih keras; yang penting ada arahan dokumentasi yang detail, lengkap, dan super komprehensif agar setiap ada update nantinya bisa dilakukan oleh AI agent dengan presisi").
- **25 Nov 2026 03:24 WIB** — pemilik menjawab **"oke lanjut"** atas pertanyaan keamanan dalam kata-kata biasa: *"Clone source OpenClaw ini bisa menjalankan kode saat diproses (clone, modifikasi, build, test). Apakah kamu setuju saya memprosesnya meski ada risiko itu?"* Jawaban ini dicatat sebagai **persetujuan eksplisit** untuk memproses clone (clone, modifikasi, build, test) source OpenClaw @ `v2026.11.6`.
- **Batas arsitektur:** PERTAHANKAN Opsi A — Gateway pemilik tunggal, WebUI dipertahankan (keputusan pemilik 24 Nov 2026).

## 1. Desain

Desain lengkap: `docs/mobile-fast-boot/DESIGN.md` (di repo fork; sumber: `~/workspace/research-start/DESAIN-mobile-fast-boot.md`, 236 baris).
Spesifikasi detail: `~/workspace/research-start/per-harness/openclaw.md` §9.0–§9.6 + §10 + §5.5/§5.7/§5.8/§5.9/§5.10.

Ringkasan arsitektur baru: proses depan tipis (ikat socket dulu, graf-sisa impor dinamis sesudah `http.bound` — F4); semua yang berat ke latar/malas (F1/F3/F5/A3/A4); lock fast-path (F2); UI tidak menunggu katalog (W1–W3); satu saklar `OPENCLAW_MOBILE_BOOT=1` (A1); guardrail N1–N10.

## 2. Status lane

| Lane | Cakupan | Status | Keterangan |
|---|---|---|---|
| A | A1 (saklar) + F9 (instrumentasi) + baseline LAB | ✅ SELESAI (24 Nov 2026) | Prasyarat semua lane lain. A1: saklar + plumbing titik masuk (tanpa perubahan perilaku); F9: 15+ nama fase baru, 285 fase terukur; baseline 2× OFF + 1× ON, lihat §3 + `docs/mobile-fast-boot/MEASUREMENT.md` |
| B | F1 (defer admission) + A4 (migrasi inkremental) | ⏳ BELUM | |
| C | F2 (fast-path lock) | ⏳ BELUM | |
| D | F5 (capture async + lazy plugin) + A3 (cache rencana plugin) | ⏳ BELUM | |
| E | W1/W2/W3 (katalog malas + cache + bundle ringan) | ⏳ BELUM | Fase WebUI (video: ≥40 dtk skeleton) |
| F | F3 (pecah bootstrap) + F6 (code-split entry) + F8 (matikan update) + D2 (hapus prebuild non-arm64) | 🟡 KODE+TEST SELESAI, LAB TERBLOKIR (25 Nov 2026) | Branch `lane-f/f3-f6-f8-d2` (worktree `openclaw-fork-lanes/lane-f`). F3: preflight core-only + import runtime lazy + snapshot malas (semua digated A1; penegakan plugin-invalid pindah ke `run.ts`, exit 78 tetap). F6: `src/entry-gateway.ts` + routing `openclaw.mjs` (gated A1) + prewarm `server-start.js` paralel. F8: tolak admission (exit 2) + skip update check pasca-attach. D2: skrip prune, 41 target / 1365,4 MiB di pohon install (prod ~60,4 MiB). Test: D2 5/5, F6 4/4, F8 10/10, F3 18/23 (5 timeout load, 0 gagal asersi; kontrol pristine membuktikan bukan regresi); oxlint 0 error. **TERBUKA: typecheck tsgo (terbunuh SIGTERM), build `dist/` + LAB 2× ON/OFF (terblokir sumber daya: `ui:build` OOM exit 137, tsdown butuh ≥4,4 GB heap vs ~1 GB tersedia, restart berulang). Resep + status lengkap: `docs/mobile-fast-boot/LANE-F.md`, `D2-PREBUILD-PRUNE.md`, `MEASUREMENT.md` §7–8. |
| G | F4 (early-listen / proses depan tipis) | ✅ LAYAK — titik pisah terbukti (F9) | Titik pisah ADA di `http.bound` (~26 dtk [LAB]); kemenangan di LAB native ~13 dtk post-attach. Lihat §3 vonis F4 |
| H | Dokumentasi (rebase guide, build/publish, guardrail, verifikasi) | ⏳ BELUM | Deliverable inti setara kode |

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

## 4. Hasil ukur vs baseline (diisi saat integrasi)

_belum ada_

## 5. Yang masih butuh pemilik

1. **Remote `ngabzar05/openclaw`** — fork via web GitHub ke org `ngabzar05` (403, akun `azqifaiq02` bukan admin org), atau repo kosong + push.
2. **Integrasi ke Polones** (langkah terpisah sesudah verifikasi): re-pin `scripts/openclaw/build.sh` + `release-pin.sha256` + test kontrak hash ke artefak fork.
3. **Prestart ON + warm-run 7.5** (keputusan pemilik terpisah — satu-satunya jalan ke "terasa instan" tanpa fork).
