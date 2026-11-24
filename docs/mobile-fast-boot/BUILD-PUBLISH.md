# BUILD-PUBLISH — Panduan Build & Publish Fork OpenClaw

> **Status:** panduan operasional fork `mobile-fast-boot`.
> **Basis fork:** `openclaw/openclaw` @ tag `v2026.11.6` (commit `06afb10d`).
> **Baca dulu:** `DESIGN.md` §0–§8 + `REBASE-GUIDE.md` (rebase sebelum
> build) + `~/workspace/research-start/per-harness/openclaw.md` §9.0,
> §7 (mengapa bundling ulang tidak layak), §2 (ukuran/inventaris).
> **JANGAN ubah repo Polones** (`~/workspace/polones`) — dokumen ini
> hanya MEMBACA `scripts/openclaw/build.sh` dan
> `scripts/openclaw/release-pin.sha256` untuk menjelaskan mekanisme
> yang sudah ada. Perubahan apa pun di sisi Polones dilakukan
> lane/koordinator Polones, bukan dari fork ini.

## 0. Gambaran alur (ujung-ke-ujung)

```text
src/ fork (TypeScript)
  → pnpm install && pnpm build        (Rollup → dist/ + artefak SDK)
  → kemas tarball fork (npm pack / tarball internal)
  → pipeline aset Polones: npm install tarball fork ke tree privat
    → prune → pack openclaw-arm64.tar.zst.bin
  → publish ke rolling tag openclaw-arm64-latest (repo ngabzar05/polones)
  → re-pin hash di scripts/openclaw/release-pin.sha256
    + tests/contract/openclaw.test.mjs
  → build APK Polones → verifikasi APK persis
```

Dua tahap pertama (build fork) adalah pekerjaan dokumen ini §1–§3.
Tahap pipeline aset (§4) adalah pekerjaan Polones — dijelaskan di sini
supaya agen fork tahu persis apa yang dikonsumsi dari hasil build-nya,
bukan supaya agen fork mengubahnya.

## 1. Build fork: `pnpm install && pnpm build`

### 1.1 Toolchain (terverifikasi 25 Nov 2026)

| Alat | Lokasi / versi | Keterangan |
|---|---|---|
| Node | `node --version` → `v24.22.1` (VM ini) | Lantai runtime fork: Node 24.22.1+/26.12.1+ (N8). Rootfs Polones memakai Node 24.22.3 — build HARUS memakai Node dalam rentang engines `>=24.16 <25` atau `>=26.1`, supaya dependensi native ter-resolve untuk interpreter yang sama |
| pnpm | `~/.local/bin/pnpm` → `11.10.0` | BUKAN `pnpm` di PATH sistem — pakai path eksplisit ini. Bila `~/.local/bin/pnpm` tidak ada, JANGAN `npm i -g pnpm` sembarangan; laporkan ke koordinator |
| Kerja | dari root worktree fork | `cd ~/workspace/openclaw-fork-lanes/lane-h` (atau `~/workspace/openclaw-fork`) |

### 1.2 Perintah

```sh
cd ~/workspace/openclaw-fork-lanes/lane-h
~/.local/bin/pnpm install
~/.local/bin/pnpm build
```

Perintah `pnpm build` di `package.json` fork adalah:

```json
"build": "node --import ./scripts/tsx.mjs scripts/build-all.mts"
```

`scripts/build-all.mts` adalah orkestrasi build dengan cache
(cache-aware): ia membangun paket-paket OpenClaw + artefak plugin SDK
dan menulis stempel build (`BUILD_STAMP_FILE`,
`RUNTIME_POSTBUILD_STAMP_FILE`). Bila build gagal karena cache basi,
hapus stempel/cache build sesuai pesan error-nya — JANGAN menghapus
`node_modules` sebagai respons pertama (lihat AGENTS.md repo induk
tentang EDQUOT transient: `Disk quota exceeded` sesekali muncul dan
sembuh dengan retry).

### 1.3 Apa yang dihasilkan — bagaimana `dist/` terbentuk (Rollup)

- **Sumber kebenaran build adalah `src/` (TypeScript), bukan `dist/`.**
  `dist/` adalah hasil bundling dan TIDAK BOLEH diedit tangan
  (lihat GUARDRAILS.md §3: patch-ke-`dist` dilarang).
- `pnpm build` menjalankan **Rollup** (openclaw.md §9.0:
  "`pnpm install && pnpm build` (Rollup)"). Rollup membundel `src/`
  menjadi chunk-chunk `dist/` **ber-hash** — contoh nyata dari aset
  v0.1.120: `gateway-lock-DxbXf4bl.mjs`,
  `plugin-generation-worker-B8qMMWfa.mjs`,
  `server-startup-plugins-n9i7kPDl.mjs`,
  `startup-trace-BgsyCOTn.mjs`. Nama + isi chunk berubah total tiap
  build — karena itu diff fork vs upstream HARUS dihitung di `src/`,
  dan patch `sed`/string-replace atas `dist/` akan pecah diam-diam
  tiap rilis (openclaw.md §9a).
- **Ukuran hasil (aset APK v0.1.120, [LAB]):** pohon aset total
  519 MB / 32.354 berkas; `dist/` 281 MB / 17.464 berkas
  (11.267 `.mjs` + 4.120 `.js`); `node_modules/` 237 MB.
  `dist/control-ui` 63 MB, `dist/worker-artifacts` 34 MB (1 tarball),
  `dist/extensions` 18 MB (76 entri). Angka-angka ini adalah
  baseline ukuran — bandingkan hasil build fork dengannya bila
  D2/D3 mengubah isi pohon (lihat §5).
- **Verifikasi sesudah build** (minimal, sebelum apa pun):
  `node openclaw.mjs --version` atas pohon hasil build harus mencetak
  versi fork + commit fork (format upstream:
  `OpenClaw 2026.11.6 (06afb10)` — ganti commit dengan HEAD fork).
  Bila mencetak `lifecycle incomplete` / exit 1, install tidak
  lengkap — JANGAN lanjut ke packaging (penyebab yang sudah terbukti
  di upstream: tarball mentah tanpa `npm install` kekurangan
  `@openclaw/*` workspace deps; lihat §4.1).

### 1.4 Perintah terkait (jangan dipakai sebagai pengganti build)

| Perintah | Kegunaan |
|---|---|
| `pnpm check` (`node --import ./scripts/tsx.mjs scripts/check.mts`) | typecheck + lint + format — gerbang sebelum commit |
| `pnpm lint` | lint saja |
| `pnpm test` (`node scripts/test-projects.mts`) | suite test upstream — gerbang rebase (REBASE-GUIDE.md §4.2) |
| `pnpm docs:check-links` | validasi tautan docs — gerbang docs-only |

Aturan AGENTS.md fork: docs-only → docs sanity + `git diff --check`.
Jangan menjalankan `pnpm openclaw ...` / `node --import tsx src/index.ts`
untuk menjalankan Gateway dari source (gunakan pohon hasil build).

## 2. Mengemas tarball fork

Build fork menghasilkan pohon `dist/` + `package.json` + `openclaw.mjs`
di root repo — BUKAN tarball npm yang bisa langsung dipakai
`scripts/openclaw/build.sh`. Pipeline Polones (§4) mengharapkan
**tarball npm** (seperti yang diterbitkan registry untuk upstream).
Karena itu sesudah `pnpm build` lolos:

1. Kemas tarball dari pohon fork (mis. `npm pack` di root repo fork
   — menghasilkan `openclaw-<versi>.tgz`).
2. Hitung sha256 tarball itu: `sha256sum openclaw-<versi>.tgz`.
3. Tarball + sha256 ini adalah **input** ke pipeline aset Polones —
   cara penyerahannya (registry fork internal / artefak CI / tarball
   internal) diputuskan koordinator bersama pemilik; dokumen ini
   TIDAK mengarang URL registry fork karena belum ada yang ditetapkan
   [BELUM DITETAPKAN — diputuskan koordinator/pemilik].
4. **Catatan penting dari `build.sh`:** tarball upstream saja TIDAK
   cukup untuk jalan — `npm install` dari tarball HARUS menjalankan
   lifecycle scripts (postinstall memasang bundled plugins); tanpa
   itu pohon menolak jalan ("package lifecycle is incomplete").
   Pastikan tarball fork mengandung `postinstall` yang sama seperti
   upstream (jangan menghapusnya saat mengemas).

## 3. Catatan build arm64

- **Build di VM ini (x86_64) TIDAK menghasilkan artefak arm64 yang
  benar.** Bukti: `dist/gateway-prewarm.js` hasil build x86 gagal
  dimuat karena modul native arm64 tidak termuat (openclaw.md
  Lampiran A, A9) — boot penuh HANYA bisa diukur di arm64/perangkat.
- **Build rilis fork HARUS di CI arm64** (openclaw.md §9.0:
  "Build: `pnpm install && pnpm build` (Rollup) di CI arm64").
  Build x86_64 lokal hanya untuk typecheck/lint/test logika —
  JANGAN pakai hasilnya sebagai artefak rilis, dan JANGAN mengklaim
  smoke boot lolos dari build x86.
- **Dependensi native:** beberapa dependensi membawa modul `.node`
  terkompilasi (mis. `fs-safe`, `proc-safe`, `node-pty`); `npm`
  men-resolve-nya untuk interpreter + arsitektur yang menjalankan
  install. Karena itu install tarball fork ke tree privat (§4)
  HARUS berjalan di bawah Node arm64 yang cocok dengan rootfs
  (Node 24.22.3) — bukan Node x86 VM ini.
- **D2 (hapus prebuild `.node` non-arm64-linux):** hanya
  `darwin`/`win32`/`x64` yang boleh dihapus (tidak pernah dimuat di
  linux-arm64). JANGAN hapus `.node` arm64-linux — itu modul yang
  dipakai Gateway di perangkat.

## 4. Bagaimana pipeline aset Polones memakai fork

Bagian ini MEMBACA mekanisme yang sudah ada di Polones — bukan
mengubahnya. Sumber: `~/workspace/polones/scripts/openclaw/build.sh`
(dibaca penuh 25 Nov 2026) + `~/workspace/polones/scripts/openclaw/release-pin.sha256`
+ `~/workspace/polones/scripts/openclaw/fetch-release.sh`.

### 4.1 Mekanisme `build.sh` hari ini (upstream)

1. **Input:** `OPENCLAW_VERSION` (default `2026.11.6`) +
   `OPENCLAW_SHA256` (default
   `0ad54c943c7365ff78cdb0c317c2cd73fd6af9df404da02c7cde9787ea3322ad`
   — sha256 tarball npm upstream, terverifikasi 2026-11-20).
   Keduanya bisa di-override lewat env.
2. **Node:** script me-resolve sendiri Node yang memenuhi engines
   (`>=24.16 <25` atau `>=26.1`): Node di PATH, lalu tarball Node
   yang sudah di-stage `build-assets.sh`, lalu tarball Node pin
   yang di-fetch di sini (Node 24.22.3 linux-arm64 — sama dengan
   rootfs). Tanpa ini, install bisa ter-resolve untuk Node yang
   salah.
3. **Fetch + verifikasi:** tarball diunduh dari
   `https://registry.npmjs.org/openclaw/-/openclaw-$OPENCLAW_VERSION.tgz`
   lalu sha256-nya dicocokkan dengan `OPENCLAW_SHA256` SEBELUM
   install apa pun. Hash tidak cocok = build GAGAL KERAS.
4. **Install:** `npm install --global --prefix "$OC_PREFIX"
   --allow-scripts=openclaw --no-audit --no-fund <tarball lokal>`.
   `--allow-scripts=openclaw` WAJIB — npm 12 memblokir lifecycle
   scripts kecuali paket di-allow-list; tanpanya postinstall
   dilewati dan pohon menolak jalan. Dependensi transitif
   di-resolve LIVE dari registry (tanpa lockfile).
5. **Pemeriksaan pasca-install:** `openclaw.mjs`,
   `dist/control-ui/index.html`, `package.json` harus ada; versi
   terinstall harus SAMA dengan `OPENCLAW_VERSION` (bukan "apa pun
   yang ada di tarball").
6. **Prune:** hapus `*.md` / `*.d.ts` / `*.map` / `CHANGELOG*` di
   seluruh pohon + direktori `test`/`tests`/`__tests__`/`docs`/
   `doc`/`example`/`examples` HANYA di root paket dependensi
   (direktori langsung di dalam `node_modules`, termasuk `@scope`).
   Root-only itu disengaja — pelajaran FAST-2 V4: hapus by-name di
   sembarang kedalaman merusak boot karena paket `yaml` menyimpan
   modul asli di `dist/doc/`. TIDAK ADA berkas `.js`/`.json`/`.node`
   yang disentuh. Prune membawa bundle 2026.10.9 dari ~173 MB
   menjadi ~146 MB (perbandingan).
7. **Pemeriksaan pasca-prune:** `openclaw.mjs`, `package.json`,
   `dist/control-ui/index.html` tetap ada + `dist/extensions`
   tetap ada — bila prune menghapus salah satunya, build GAGAL.
   (Catatan: `dist/control-ui` dipertahankan sebagai prune-safety
   check meskipun Polones menjalankan OpenClaw TUI-only di v0.1.120;
   di fork Opsi 1 Control UI disajikan Gateway — D5 melarang
   menghapusnya.)
8. **Launcher:** `usr/local/bin/openclaw` ditulis sebagai skrip `sh`:
   `exec node --import /opt/polones/node-preload/flush-compile-cache.mjs
   /usr/local/lib/node_modules/openclaw/openclaw.mjs "$@"`.
9. **Pack:** `tar --create -I 'zstd -19 -T0'` → 
   `app/src/main/assets/openclaw-arm64.tar.zst.bin` + 
   `openclaw-version.txt` (berisi versi saja).
10. **Perintah pemakaian:** `scripts/openclaw/build.sh`
    (env: `OUT_DIR`, `WORK`, `OPENCLAW_VERSION`, `OPENCLAW_SHA256`,
    `KEEP_WORK`).

### 4.2 Yang berubah bila sumbernya fork (bukan upstream)

Perubahan ini dilakukan DI SISI POLONES (lane/koordinator Polones),
bukan dari repo fork — dicantumkan di sini supaya agen fork tahu
kontraknya:

| Elemen | Hari ini (upstream) | Dengan fork |
|---|---|---|
| Sumber tarball | registry npm (`registry.npmjs.org/openclaw/-/openclaw-<ver>.tgz`) | **tarball fork** (registry fork / tarball internal — [BELUM DITETAPKAN]) |
| `OPENCLAW_VERSION` | `2026.11.6` | versi fork (CalVer upstream + penanda fork — skema penamaan [BELUM DITETAPKAN — diputuskan koordinator/pemilik]; JANGAN memakai nomor versi upstream murni untuk artefak fork, supaya tidak tertukar dengan upstream) |
| `OPENCLAW_SHA256` | sha256 tarball npm upstream | **sha256 tarball fork** (dihitung dari tarball §2 langkah 2) |
| `release-pin.sha256` | pin hash aset `openclaw-arm64.tar.zst.bin` | **re-pin** (lihat §4.3) |
| `tests/contract/openclaw.test.mjs` | hash aset yang diharapkan | **diperbarui** ke hash aset fork (lihat §4.3) |
| Prune / launcher / pack | tidak berubah | **tidak berubah** — fork TIDAK mengubah `build.sh` kecuali sumber tarball + pin |

### 4.3 Cara re-pin hash aset fork

**Fakta dasar (dari `release-pin.sha256` + NOTE `build.sh` 24 Nov 2026):**
hash aset TIDAK stabil antar rebuild — `npm install` me-resolve
dependensi transitif LIVE (tanpa lockfile), jadi rebuild bisa menarik
transitif yang lebih baru (contoh nyata: `brace-expansion` 5.0.13 →
5.1.0, `hono`) sementara aplikasi sendiri byte-identik (`dist` +
`package.json` 2026.11.6, sha256 tarball pin tidak berubah —
terverifikasi member-by-member: 25 berkas berbeda, semuanya
transitif `node_modules`). **Karena itu re-pin WAJIB sesudah SETIAP
rebuild — tidak ada pengecualian.**

Langkah re-pin (dilakukan di repo Polones, sesudah aset fork
diterbitkan ke rolling tag `openclaw-arm64-latest`):

```sh
# 1. Unduh aset yang diterbitkan
gh release download openclaw-arm64-latest --repo ngabzar05/polones \
     --pattern openclaw-arm64.tar.zst.bin --dir /tmp/openclaw-pin

# 2. Hitung hash dari berkas yang diunduh
sha256sum /tmp/openclaw-pin/openclaw-arm64.tar.zst.bin

# 3. Masukkan hash itu sebagai baris pertama (64 hex lowercase)
#    di scripts/openclaw/release-pin.sha256 — menggantikan hash lama —
#    dan perbarui baris "Pinned version:" dengan versi fork dari
#    openclaw-version.txt unduhan yang sama.
#    (Format berkas + komentar cara re-pin sudah tertulis di dalam
#    berkas itu sendiri — ikuti komentar itu.)

# 4. Perbarui hash yang diharapkan di tests/contract/openclaw.test.mjs
#    (satu commit yang sama dengan langkah 3 — aturan Polones:
#    pin + test kontrak diperbarui bersamaan).

# 5. Cross-check: bandingkan hash lokal dengan .sha256 sidecar yang
#    diterbitkan bersama rilis (harus identik). Sidecar HANYA
#    consistency check — ia ikut bersama aset sehingga tidak bisa
#    mendeteksi aset yang diganti; yang mengikat adalah pin lokal
#    di release-pin.sha256 (lihat komentar kepala berkas itu).
```

Riwayat pin yang tercatat di `release-pin.sha256` (supaya tidak
diulang kesalahannya): pin pertama 2026-11-21 (build run 44810649378,
hash dihitung lokal + cross-check sidecar identik); re-pin 2026-11-24
(build run 45425866998, program branch
`perf/pasca-program-implementasi`, hash `e0a51ccdc54ae2c1824cd1bfdaaa78b4af3c713b9a9912b43ebcff1e6bc08c6b`).
Pin npm tarball upstream (BUKAN aset) yang tercatat di berkas yang
sama: `2026.11.6`, sha256
`0ad54c943c7365ff78cdb0c317c2cd73fd6af9df404da02c7cde9787ea3322ad`.

### 4.4 `fetch-release.sh` — sisi unduh

`fetch-release.sh` (satu direktori dengan `build.sh`) memverifikasi
aset yang diunduh terhadap nilai pada baris pertama
`release-pin.sha256` yang dimulai dengan 64 hex lowercase. Bila pin
tidak diperbarui sesudah rebuild fork, unduhan aset baru akan
DITOLAK di sini — itu perilaku yang benar (fail-closed), bukan bug.
Jangan pernah "memperbaiki" dengan mengosongkan pin atau mematikan
verifikasi.

## 5. Dampak ukuran (D2/D3) — yang boleh diklaim

- D2 (hapus prebuild `.node` non-arm64-linux): mengurangi MB APK,
  ~0 dtk boot (tidak pernah dimuat di linux-arm64). Aman tanpa
  bukti impor.
- D3 (`node_modules/npm` 14 MB + `@esbuild` 9,9 MB +
  `highlight.js` 9,0 MB + `clawpdf` 5,4 MB): HANYA sesudah bukti
  impor (graf impor per paket [BELUM TERUKUR — diisi Lane A/G]);
  `npm` hanya boleh dihapus bila F8 menghapus jalur update.
  Jangan klaim penghematan ukuran D3 sebelum bukti impor ada.
- Prune `build.sh` (§4.1 langkah 6) sudah memangkas markdown/d.ts/
  map + direktori junk root-paket; JANGAN menambah pola prune baru
  tanpa membuktikan berkas itu tidak diimpor (pelajaran FAST-2 V4).

## 6. Referensi

- `REBASE-GUIDE.md` (rebase → build → verifikasi).
- `VERIFY.md` (smoke boot + ukur LAB sesudah build).
- `DESIGN.md` §2.3 (D1–D8), §6 (beban maintenance).
- `~/workspace/research-start/per-harness/openclaw.md` §9.0
  (cara kerja fork + build), §7 (dist/bundling), §2 (ukuran).
- `~/workspace/polones/scripts/openclaw/build.sh` (mekanisme
  pipeline aset — dibaca, bukan diubah).
- `~/workspace/polones/scripts/openclaw/release-pin.sha256`
  (format pin + riwayat re-pin).
- `~/workspace/polones/docs/guides/openclaw.md` §5 (pin tarball
  npm upstream, verifikasi 2026-11-20/21).
