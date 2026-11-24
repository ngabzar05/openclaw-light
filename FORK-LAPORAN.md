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
| A | A1 (saklar) + F9 (instrumentasi) + baseline LAB | ⏳ BELUM | Prasyarat semua lane lain |
| B | F1 (defer admission) + A4 (migrasi inkremental) | ⏳ BELUM | |
| C | F2 (fast-path lock) | ⏳ BELUM | |
| D | F5 (capture async + lazy plugin) + A3 (cache rencana plugin) | ⏳ BELUM | |
| E | W1/W2/W3 (katalog malas + cache + bundle ringan) | ⏳ BELUM | Fase WebUI (video: ≥40 dtk skeleton) |
| F | F3 (pecah bootstrap) + F6 (code-split entry) + F8 (matikan update) + D2 (hapus prebuild non-arm64) | ⏳ BELUM | |
| G | F4 (early-listen / proses depan tipis) | ⏳ BELUM | Sesudah F9 membuktikan titik pisah graf |
| H | Dokumentasi (rebase guide, build/publish, guardrail, verifikasi) | ⏳ BELUM | Deliverable inti setara kode |

**Yang TIDAK dikerjakan:** F7 (compile cache jadi — DITOLAK); A2-R2 (shim health — DITOLAK); D1/D5/D6/D7/D8 (dilarang/belum terbukti).

## 3. Baseline LAB (diisi Lane A)

| Pengukuran | Upstream 2026.11.6 [LAB] | Fork [LAB] |
|---|---|---|
| Spawn → `GET /health` 200 pertama (definisi A) | _belum diukur_ | _belum diukur_ |
| Spawn → Control UI shell + chat pertama bisa dikirim (definisi B) | _belum diukur_ | _belum diukur_ |
| Per fase (impor, bootstrap, lock, server-import, admission, celah, plugin post-bind) | _belum diukur_ | _belum diukur_ |
| Stall katalog WebUI | 43,5 dtk (dikutip dari riset) | _belum diukur_ |

Catatan: semua angka [LAB] (VM x86_64, Node 24.22.1). Angka perangkat [BELUM TERUKUR]. Baseline perangkat S1 (video 25 Nov 02:39 WIB, v0.1.120): A ~95 dtk, B >135 dtk.

## 4. Hasil ukur vs baseline (diisi saat integrasi)

_belum ada_

## 5. Yang masih butuh pemilik

1. **Remote `ngabzar05/openclaw`** — fork via web GitHub ke org `ngabzar05` (403, akun `azqifaiq02` bukan admin org), atau repo kosong + push.
2. **Integrasi ke Polones** (langkah terpisah sesudah verifikasi): re-pin `scripts/openclaw/build.sh` + `release-pin.sha256` + test kontrak hash ke artefak fork.
3. **Prestart ON + warm-run 7.5** (keputusan pemilik terpisah — satu-satunya jalan ke "terasa instan" tanpa fork).
