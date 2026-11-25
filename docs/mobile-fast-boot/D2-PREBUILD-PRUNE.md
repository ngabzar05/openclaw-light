# D2 — Prune prebuild `.node` non-arm64-linux

Fork mobile-fast-boot, Lane F. Target: APK Polones hanya berjalan di
linux-arm64, tetapi pohon dependensi membawa prebuild native `.node` untuk
semua platform (darwin, win32, linux-x64). Berkas-berkas itu tidak pernah
dimuat di linux-arm64 dan hanya menambah ukuran paket.

## Yang dihapus (dan yang dipertahankan)

Dua bentuk prebuild di pohon:

1. **Paket opsional per platform** — direktori paket utuh yang namanya
   berakhiran suffix platform-arch, mis. `@resvg/resvg-js-linux-x64-gnu`,
   `@lydell/node-pty-linux-x64`, `@trycua/cua-driver-linux-x64-gnu`.
   Seluruh direktori dihapus.
2. **Prebuild di dalam paket** — berkas `.node` di bawah
   `prebuilds/<platform>-<arch>/`, mis. pi-tui:
   `native/darwin/prebuilds/darwin-arm64/darwin-platform.node`.
   Hanya berkas `.node`-nya yang dihapus; sumber `.c`/`.h`/`.m`, `build.sh`,
   dan `README.md` di direktori platform yang sama TETAP (bukan bagian
   dari runtime).

**Dipertahankan (keeper):** segala sesuatu yang mengandung `linux-arm64`
(`@resvg/resvg-js-linux-arm64-gnu`, `@lydell/node-pty-linux-arm64`,
`pi-tui/native/linux/prebuilds/linux-arm64/*.node`, dst.), berkas `.node`
hasil kompilasi (`build/Release/*.node`, bukan prebuild), berkas `.node`
tanpa tag platform, dan symlink (tidak pernah diikuti/dihapus).

## Bukti keamanan (mengapa tidak pernah dimuat di linux-arm64)

- **Optional packages:** npm/pnpm hanya memasang varian yang cocok dengan
  `os`+`cpu` platform instalasi; varian lain tidak pernah masuk ke
  `require.resolve` di perangkat. Varian linux-x64 dari paket yang sama
  tidak bisa dimuat oleh proses arm64 (format ELF x86-64).
- **pi-tui:** loader native-nya memilih direktori
  `prebuilds/<platform>-<arch>` berdasarkan `process.platform`/
  `process.arch` saat berjalan; di linux-arm64 hanya
  `prebuilds/linux-arm64` yang dibaca. Berkas prebuild platform lain
  tidak pernah dibuka.
- **node-pty / resvg / cua-driver:** pola yang sama — binding dipilih
  melalui nama paket opsional per platform (`*-linux-arm64-gnu`),
  bukan lewat berkas `.node` platform lain.
- **Pengaman skrip:** skrip tidak pernah menghapus jalur yang mengandung
  `linux-arm64`; `.node` tanpa tag platform tidak tersentuh; symlink
  dilewati; mode default adalah dry-run.

## Skrip

`scripts/mobile-fast-boot/prune-non-arm64-prebuilds.mjs` (Node murni, tanpa
dependensi):

```sh
# Dry run (default): daftar target + total byte, tidak menghapus apa pun.
node scripts/mobile-fast-boot/prune-non-arm64-prebuilds.mjs --root <dir>

# Terapkan:
node scripts/mobile-fast-boot/prune-non-arm64-prebuilds.mjs --root <dir> --apply
```

- `--root` harus direktori NYATA (materialized tree), bukan `node_modules`
  symlink pnpm (symlink dilewati, tidak diikuti).
- Exit 0: selesai. Exit 1: argumen salah / root bukan direktori nyata.
  Exit 2: gagal filesystem saat menghapus (keadaan parsial — jalankan
  ulang; skrip memindai ulang sesudah `--apply` dan gagal bila masih ada
  target tersisa).

Test: `test/scripts/mobile-fast-boot-prune-prebuilds.test.ts` — pohon palsu
dengan semua bentuk di atas; menegaskan hanya target yang benar terhapus
(dan keeper/sumber/binding kompilasi tetap ada) + perilaku CLI dry-run vs
`--apply` + penolakan root hilang/symlink.

## Ukuran yang diukur

Diukur dengan skrip ini sendiri (dry-run) atas pohon hasil `pnpm install`
worktree lane-f (`node_modules/.pnpm`, linux-x64, 2026-11-25):
**41 target, 1365,4 MiB total.** Pohon ini memuat devDependencies +
dependensi transitif, jadi angkanya dipisah: (A) yang dinamai tugas +
production, (B) sisanya (konteks pohon install, BUKAN klaim penghematan
APK). Ukuran per target di bawah adalah yang dilaporkan skrip (1 desimal).

### (A) Task-named + prod — yang relevan dengan APK

| Target | Ukuran |
| --- | --- |
| pi-tui prebuild `.node` non-arm64 (5 berkas: darwin-arm64, darwin-x64, linux-x64, win32-arm64, win32-x64) | ~108 KiB |
| `@resvg/resvg-js-linux-x64-gnu@2.6.2` (paket utuh) | 4,2 MiB |
| `@lydell/node-pty-linux-x64@1.2.0-beta.15` (paket opsional utuh) | ~104 KiB |
| node-pty (paket polos) prebuild non-arm64 (7 berkas: darwin-arm64/x64, linux-x64, win32-arm64/x64 `pty.node` + `conpty*.node`) | ~1,0 MiB |
| `@openclaw/fs-safe-linux-x64-gnu@0.26.13` (paket utuh; varian arm64-nya keeper bernama riset §2) | 4,6 MiB |
| `@openclaw/proc-safe-linux-x64-gnu@0.4.2` (paket utuh; sama) | 2,4 MiB |
| `@trycua/cua-driver-linux-x64-gnu@0.36.0` (paket utuh, prod dep) | 47,9 MiB |
| **Subtotal (A)** | **~60,4 MiB** |

Keeper yang dipertahankan (terverifikasi ada di pohon ini dan TIDAK
ditargetkan skrip): pi-tui `linux-arm64/linux-platform-x11.node`
(67.240 B), node-pty `prebuilds/linux-arm64/pty.node` (69.112 B),
tree-sitter-bash `prebuilds/linux-arm64/tree-sitter-bash.node`.

### (B) Konteks pohon install (transitif/dev — belum tentu masuk APK)

| Target | Ukuran |
| --- | --- |
| `@openai/codex@0.169.0-linux-x64` (publish per-platform, lihat caveat) | 403,1 MiB |
| `@anthropic-ai/claude-agent-sdk-linux-x64@0.3.309` | 279,9 MiB |
| `@lancedb/lancedb-linux-x64-gnu@0.40.0` | 201,8 MiB |
| `@github/copilot-sdk-linux-x64@1.0.23` | 157,2 MiB |
| `@tloncorp/tlon-skill-linux-x64@0.8.1` | 92,3 MiB |
| `jscpd-linux-x64-gnu@5.4.1` | 44,2 MiB |
| `@typescript/typescript-linux-x64@7.1.0-dev.20261016.1` | 27,1 MiB |
| `@matrix-org/matrix-sdk-crypto-nodejs` (`matrix-sdk-crypto.linux-x64-gnu.node`) | 23,6 MiB |
| `@rolldown/binding-linux-x64-gnu@1.2.14` | 18,9 MiB |
| `@oxlint/binding-linux-x64-gnu@1.88.0` | 14,5 MiB |
| `lightningcss-linux-x64-gnu@1.33.0` | 9,6 MiB |
| `@solidjs/compiler-linux-x64-gnu@2.0.0-rc.18` | 9,5 MiB |
| `@oxfmt/binding-linux-x64-gnu@0.74.0` | 8,8 MiB |
| tree-sitter-bash prebuild non-arm64 (5 berkas) | ~6,9 MiB |
| `@koromix/koffi-linux-x64@3.2.1` + `@3.3.3` | ~4,6 MiB |
| `@snazzah/davey-linux-x64-gnu@0.1.12` | 1,8 MiB |
| `@ubjs/node-linux-x64-gnu@0.31.0-3` | ~724 KiB |
| `@yuku-core/binding-linux-x64-gnu@0.19.0` | ~676 KiB |
| `sqlite-vec-linux-x64@0.1.9` | ~156 KiB |
| **Subtotal (B)** | **~1.305 MiB** |

Total yang ditemukan skrip di pohon install ini (A+B): **41 target,
1365,4 MiB**. **Yang boleh diklaim sebagai penghematan APK hanya subset
yang benar-benar disalin staging APK** — staging Polones (langkah prune
`build.sh`) menentukan itu. Angka (A) adalah batas atas yang aman untuk
paket production yang dinamai tugas + kelas yang sama; angka (B)
dilaporkan apa adanya sebagai konteks, bukan klaim.

Catatan: paket opsional linux-arm64 TIDAK terpasang di pohon install ini
(pnpm memasang varian platform host, x86_64) — sisi keeper diverifikasi
lewat unit test atas pohon palsu + keeper prebuild di dalam paket yang
sudah diperiksa di atas.

### Caveat: paket berversi platform (`@openai/codex`)

`@openai/codex` diterbitkan per platform LEWAT STRING VERSI
(`0.169.0-linux-x64`, `package.json` menyatakan `"os": ["linux"],
"cpu": ["x64"]`, isi hanya `vendor/`) — bukan lewat nama paket opsional.
Skrip menangkapnya hanya bila string versi itu menjadi bagian dari nama
direktori (layout store pnpm: `.pnpm/@openai+codex@0.169.0-linux-x64`).
Di tree yang sudah di-flatten (`node_modules/@openai/codex`, tanpa versi
di path), skrip TIDAK menangkapnya — batasan yang diketahui, dicatat di
sini. Penghapusannya tetap aman untuk target arm64 (varian arm64 memakai
string versi `...-linux-arm64`, yang dilindungi aturan keeper). Praktisnya
tidak berdampak pada APK Polones: Codex sudah dihapus dari Polones
(v0.1.101).

## Adopsi di pipeline Polones (sisi Polones, bukan fork)

`BUILD-PUBLISH.md` §4.1 langkah 6: prune `build.sh` TIDAK menyentuh
`.js`/`.json`/`.node` hari ini; §4.2: fork TIDAK mengubah `build.sh`
kecuali sumber tarball + pin. Jadi langkah adopsi (di repo Polones):

1. Salin skrip ini (atau panggil dari tarball fork) pada langkah prune
   `build.sh`, dengan `--root` menunjuk ke staging tree yang akan
   dikemas (materialized, bukan symlink pnpm).
2. Jalankan dry-run dulu di CI; bandingkan daftar target dengan tabel (A)
   di atas; bila ada target baru yang tidak dikenal, telaah sebelum
   `--apply`.
3. Verifikasi pasca-prune: boot gateway dari APK hasil prune (smoke boot
   + `openclaw health`) — D2 mengubah ukuran, bukan perilaku; boot harus
   identik.
4. Jangan jalankan skrip terhadap `node_modules` hasil `pnpm install`
   langsung di worktree pengembangan x86_64 (akan menghapus binding x64
   yang dipakai tooling host) — hanya terhadap staging tree target
   linux-arm64.

## Batasan jujur

- Uji boot LAB Lane F memakai pohon PRISTINE (x86_64 butuh berkas x64);
  keamanan prune dibuktikan via unit test + telaah loader, bukan via boot
  pohon ter-prune di LAB.
- Penghematan APK final = subset (A) yang disalin staging; angka pastinya
  diputuskan saat adopsi `build.sh` (Polones).
- D2 ≈ 0 dtk pengaruh boot (hanya ukuran paket).
