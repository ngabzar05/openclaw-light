# DESAIN — Fase 1: Proses Depan Tipis yang Sesungguhnya (True Early-Listen)

> **Status:** TERIMPLEMENTASI (Lane F1-I, 26 Nov 2026 — commit lokal di `main` fork, belum push, belum terverifikasi CI/perangkat). Lihat §13 untuk catatan implementasi + penyimpangan dari desain ini.
> **Lane:** F1-R (rekognisi + desain). **Tanggal:** 26 Nov 2026.
> **Basis:** fork `ngabzar05/openclaw-light`, `main` `e701152a` (bersih, tanpa commit dari lane ini).
> Rencana: `docs/mobile-fast-boot/PLAN-OPENCODE-PARITY.md` §4 Fase 1, §5 (N1–N14), §12.1 (C-1–C-8), §12.2 (M-1–M-11).
> Audit OpenCode: `~/workspace/research-start/OPENCODE-DEEP-READ.md` §0–§2 (tiga inversi, `process.ts` bind-dulu, stub 503, registrasi dini).
> **Aturan penulisan:** setiap nomor `berkas:baris` di dokumen ini terverifikasi dari source fork yang dibaca langsung pada 26 Nov 2026 (bukan dari ingatan rencana). Bila klaim rencana ternyata salah sesudah membaca source, dikoreksi dan ditandai **KOREKSI**. Keputusan lane dicatat dengan alasan (user sedang tidur; keputusan pemilik tetap dicadangkan bila ditandai **BUTUH KEPUTUSAN PEMILIK/LEAD**).

## 0. Ringkasan eksekutif

### 0.1 Masalah

Seluruh rantai pra-listen (impor graf + bootstrap config + sqlite + kernel + request-runtime + transport) berjalan sebelum `http.listen` (`src/gateway/server-startup-finish.ts:198`). `/health` baru menjawab sesudah ~26 dtk [LAB] / ~95 dtk (perangkat). F4 yang sudah merge hanya lazy-import + tunda join — ia tidak memindahkan satu pun fase pra-listen ke sesudah `http.bound`, kecuali admission (F1). Fase 1 memindahkan titik bind ke paling awal: proses mengikat 18789 dengan **graf-listen minimal**, menjawab probe + shell sejak bind, dan mengerjakan seluruh graf-sisa sesudah `http.bound`.

### 0.2 Keputusan lane (dipilih sendiri, dengan alasan)

| # | Keputusan | Alasan |
|---|---|---|
| D-1 | Stub dispatcher adalah **satu dispatcher permanen dengan `handlerRef` yang bisa diganti** (bukan swap listener `server.on("request")`). | `server.on("request")` dipasang sekali saat konstruksi (`src/gateway/server-http.ts:26`) dan handler dicatat di `WeakMap` (`server-http.ts:10,28`). Mengganti listener berarti menyentuh kepemilikan itu. Satu wrapper `((req,res) => handlerRef.current(req,res))` membuat pergantian atomik (satu assignment) dan tidak mengubah `server-http.ts` secara struktural. |
| D-2 | **`/ready` tetap berarti "bisa chat" (Opsi A).** Yang dilepas hanya `await` eksplisit di `server-startup-finish.ts:538-541`; gerbang tunggal arti `/ready` menjadi readiness checker (`src/gateway/server/readiness.ts`). Opsi B (mendefinisikan ulang `/ready`) **tidak** diputuskan di lane ini — lihat §5.5. | Mengubah arti `/ready` diam-diam adalah readiness palsu (N9) dan menabrak K-8 (arti `/ready` = "bisa chat" sudah diputuskan pemilik untuk kasus model runtime; kasus migrasi analog tetapi belum diputuskan). Opsi A memberi perbaikan nyata tanpa mengubah kontrak. |
| D-3 | Pelepasan gerbang `/ready` dari plugin di Fase 1 bersifat **konservatif**: yang keluar dari jalur ready adalah himpunan **deferred** F5, startup log, update check, control-ui-assets, transcripts sidecar, dan handler prewarm. **Essential attach + migrasi + `unlockStartupMethods` tetap di jalur ready.** Varian penuh ("ready tanpa attach plugin sama sekali") ditandai untuk pemilik — lihat §5.4. | `chat.send` membutuhkan essential registry yang sudah ter-attach (provider owner, dst.) untuk bisa berhasil; `/ready` = "bisa chat" (D-2) tidak bisa 200 sebelum itu. Yang bisa dilepas tanpa mengubah arti adalah pekerjaan yang tidak dibutuhkan `chat.send`. |
| D-4 | **Kontrak probe adalah perubahan wajib sisi-Polones; berkas registrasi adalah opsional (nice-to-have).** | Polones hari ini menemukan gateway murni lewat probe (`health.rs`, `spec_table.rs` — lihat §4.1); tidak ada pembaca berkas registrasi di Polones. Probe + tile status perantara (K-3 opsi b) adalah kontrak minimal yang membuat Fase 1 jujur. Berkas registrasi meniru OpenCode `service.json` tetapi tanpa pembaca ia tidak berguna. |
| D-5 | **Config: baca murah pra-bind tetap, validasi otoritatif pindah pasca-bind.** Yang tetap pra-bind: preflight core-only F3a + pemakaian snapshot itu untuk port/bind/auth-env. Yang pindah pasca-bind: full-metadata read (`run.ts:474`), penegakan invalid-config (`run.ts:490-499`), `gateway.mode=local` guard (`run.ts:709`), dan seluruh `prepareGatewayServerBootstrap`. Invalid tetap exit 78 (N5), hanya waktunya sesudah bind. | Socket tidak bisa dibangun tanpa port/bind; token env untuk stub auth tidak butuh config. Validasi penuh (plugin metadata, secrets, schema) adalah bagian mahal dan tidak dibutuhkan untuk mengikat socket. |
| D-6 | **Stub shell = halaman "memulai" minimal yang di-embed (bukan Control UI penuh).** Halaman ini menampilkan status jujur "memulai", menonaktifkan kirim, dan mem-poll `/startup` sampai ready lalu beralih ke Control UI penuh. | Control UI penuh butuh config + `controlUiRoot` + modul `control-ui.js` (lazy, berat) — semuanya graf-sisa. Halaman placeholder nol-dependensi pada `dist/control-ui` (63 MB) dan memenuhi N11. |
| D-7 | **Gunakan kembali `handleGatewayProbeRequest` + `classifyGatewayProbePath` untuk stub** (dengan checker stub yang membaca `phase` yang bisa berubah), bukan menulis ulang semantik probe. | Satu pemilik untuk semantik probe (aturan "one owner" `AGENTS.md` repo fork). Stub hanya menyuplai `getReadiness`/`getStartup` palsu yang membaca fase berjalan. |

### 0.3 Hasil yang diharapkan (perkiraan, bukan janji — ukur di Fase 6)

| Metrik | Sebelum Fase 1 (ON, pasca-Fase 0) | Sesudah Fase 1 (perkiraan) |
|---|---|---|
| A' — socket terikat + `/health` 200 ("hidup") | ~70–85 dtk | **~5–15 dtk** (perangkat; Node startup + impor graf-listen + overhead Groot) |
| B' — shell placeholder tampil (cold) | ~85–110 dtk | **~10–20 dtk** |
| `/ready` 200 (full, arti tidak berubah) | ~60–90 dtk | **membaik sefraksi** (deferred plugin + startup log + update check keluar dari jalur; essential + migrasi tetap) — bukan puluhan detik sekaligus bila migrasi mendominasi |
| Chat pertama bisa dikirim (cold) | ~85–110 dtk | **~60–90 dtk** (tetap menunggu migrasi + essential attach) |

### 0.4 Yang SUDAH ada vs yang BARU (temuan follow-up — baca dulu sebelum mendesain)

Bagian ini menjawab temuan follow-up secara eksplisit: beberapa berkas yang "mungkin sudah berisi mesin early-boot" ternyata **bukan** mesin early-boot. Desain ini memakai yang sudah ada dan tidak menduplikasinya.

**SUDAH ADA — pakai, jangan duplikasi:**

| Berkas | Apa isinya sebenarnya | Peran di Fase 1 |
|---|---|---|
| `src/gateway/server-startup-early.ts` (193 baris) | **KOREKSI (lihat §10 K-8): BUKAN early-boot.** Ini *early runtime* pasca-listen: discovery (mDNS), skills remote, cron maintenance (`startGatewayEarlyRuntime`). Dipanggil dari core runtime; F4(b) menunda *join*-nya. | Tidak dipakai untuk graf-listen. Pola lazy-import-nya saja yang ditiru. Discovery/skills/cron tetap graf-sisa. |
| `src/gateway/server-startup-minimal-boot.test.ts` | Boot gateway sungguhan + poll `/readyz`; komentarnya sudah menyatakan "The HTTP listener comes up before the readiness boundary" (listener naik sebelum ready — karena transport + listen terjadi sebelum post-attach). | Perluas, bukan ganti: jadikan pola uji urutan listen-vs-ready. |
| `src/gateway/server-startup-handler-prewarm.ts` (199 baris) | **Post-ready idle prewarm** (`chat.history`, `chat.send`, `sessions.list`, `agent-events`, `memory-search`, dst.). Bukan pra-listen. | Tetap post-ready; item-itemnya TIDAK boleh masuk graf-listen (butuh config + registry). |
| `src/gateway/server-startup-readiness.ts` (65 baris) | `logGatewayReady` + `createGatewayReadyAnnouncer` — pengumuman ready digerbangi `isChatSendAvailable` + `areSidecarsReady`. | Tetap dipakai: announcer adalah satu-satunya tempat keputusan "ready diumumkan". Fase 1 tidak membuat pengumum kedua. |
| `src/gateway/server-startup-finish.mobile-boot.test.ts` | Pola uji F4(b): gate early runtime, probe `/health` 200 selagi `/ready` 503 (ON) vs `/ready` tetap 503 (OFF). | Templat untuk uji stub Fase 1 (lihat §8). |
| `src/gateway/server-startup-plugins.mobile-boot.test.ts` | Uji split essential/deferred F5. | Tetap; Fase 1 memperluas pemakaian split, bukan mengubahnya. |
| `src/gateway/deferred-session-migration.ts` (98 baris) | Pemilik migrasi tertunda F1 (dependency-free di load time; `start` pertama menang). | Tetap dipakai sebagai gerbang migrasi; JANGAN bangun gerbang kedua. |
| `src/gateway/server-http-probes.ts` + `src/gateway/gateway-http-route-contracts.ts` | Semantik probe (`/health` live → 200 tanpa auth; `/ready`/`/startup` 200/503 + detail hanya untuk local/auth). | Dipakai ulang oleh stub dengan checker stub (D-7). |
| `src/gateway/server/http-listen.ts` (80 baris) | `listenGatewayHttpServer` — bind + retry EADDRINUSE 20× @ 500 ms. | Dipakai ulang untuk bind stub; satu pemilik semantik bind. |
| `src/gateway/server-startup-post-attach.ts:555-557` | Pola `sidecarStartup === "defer"`: `sidecarsPromise` tidak di-await. | Model untuk mengeluarkan sidecar dari jalur ready. |
| `src/entry-gateway.ts:216-235` | Prewarm F6: `void import("./gateway/server-start.js")` paralel dengan `runCli`. | Tetap; membantu impor `server-start.js` walau listen pindah lebih awal. |

**BARU — harus ditulis di Fase 1:**

| Baru | Keterangan |
|---|---|
| Modul stub listen (mis. `src/gateway/server/listen-stub.ts`) | Dispatcher stub + halaman placeholder + pemegang fase (`ListenPhase`) + checker stub. Dependency-free di load time (seperti `deferred-session-migration.ts`). |
| `GatewayHttpHandlerRef` + wiring di `server-http.ts` / `server.ts` | Satu wrapper request permanen yang membaca `handlerRef.current`; stub dipasang pra-bind, handler penuh dipasang saat transport dibuat. |
| Penulis berkas registrasi (bila diputuskan) | Tulis atomik di `http.bound`, update di ready, hapus saat close bersih. |
| Pemindahan validasi config pasca-bind (`run.ts`, bootstrap) | Lihat §6. |
| Uji-uji baru | Lihat §8. |

---

## 1. Urutan operasi saat ini sebelum `http.listen`

Rantai dieksekusi di bawah ini adalah yang berjalan hari ini (ON maupun OFF; perbedaan ON/OFF dicatat per langkah). Semua nomor baris terverifikasi 26 Nov 2026 di `main` `e701152a`.

### 1.1 Entry + CLI (proses → `runCli`)

| # | Langkah | Berkas:baris | Keterangan |
|---|---|---|---|
| 1 | Guard argv: hanya foreground gateway run; selain itu exit 2 | `src/entry-gateway.ts:110-122` | Berlaku hanya bila ON (routing `openclaw.mjs` → `entry-gateway.js` bila `OPENCLAW_MOBILE_BOOT=1`; OFF tetap `entry.js`). |
| 2 | Runtime guard + compile-cache respawn + `watchCliRespawnParent` | `src/entry-gateway.ts:139-177` | |
| 3 | **Prewarm F6:** `void import("./gateway/server-start.js")` paralel dengan `runCli` (gagal → lanjut cold, hanya warning) | `src/entry-gateway.ts:216-235` | Impor saja, tidak start gateway (kontrak `gateway-prewarm`). |
| 4 | `runCli(process.argv, …)` | `src/entry-gateway.ts:245-258` | |
| 5 | **Resolve saklar sekali per proses:** `resolveMobileBootOptions(process.env)` | `src/cli/run-main.ts:173` (dikutip di `src/gateway/mobile-boot.ts`); konsumsi di `src/cli/gateway-cli/run.ts:377-378` | Satu-satunya tempat baca env `OPENCLAW_MOBILE_BOOT` di jalur ini (N10: tidak ada pembacaan env kedua). |
| 6 | **Preflight config (baca config #1):** `bootstrapGatewayRun` → `ensureCliExecutionBootstrap` → `readAdmittedConfigSnapshot` | `src/cli/gateway-cli/run-command.ts:23-76`; threading mobileBoot di `src/gateway/mobile-boot.ts` (komentar F3) | **F3(a): bila ON, snapshot preflight core-only** (`includePluginMetadata:false`, `skipPluginValidation:true`). Baca ini murah (JSON + parse) dan TETAP pra-bind menurut D-5. |
| 7 | `runGatewayCommandOnce` — resolve saklar ulang dari opts (fallback env), `clearGatewayRunConfigEnvironment()` | `src/cli/gateway-cli/run.ts:369-380` | |
| 8 | Impor modul server (`cli.server-import`, banner/spinner menunggu) | `src/cli/gateway-cli/run.ts:418-440` | Impor `../../gateway/server.js` — graf besar pertama yang dievaluasi. |
| 9 | **Baca config #2 (full, termasuk plugin metadata):** `readGatewayStartupConfigWithShellEnv` → `readGatewayStartupConfig` | `src/cli/gateway-cli/run.ts:474`; definisi `run.ts:136-160` | `readConfigFileSnapshotWithPluginMetadata({ isolateEnv:true, observe:false })`; throw bila read failure (`run.ts:155-157`). **Pindah pasca-bind (§6).** |
| 10 | **Penegakan F3(a):** bila ON + snapshot ada + invalid + bukan read-failure → `throw createInvalidConfigError(...)` → `runGatewayCommand` → recovery offer → **exit 78** | `src/cli/gateway-cli/run.ts:490-499`; `EXIT_CONFIG_ERROR = 78` di `run.ts:106`; `runGatewayCommand` di `run.ts:960-990` | **Pindah pasca-bind (§6).** OFF tidak pernah mencapai cabang ini dengan snapshot invalid (preflight sudah memblokir). |
| 11 | Future-config guard, `applyFinalGatewayRunConfigEnv` | `src/cli/gateway-cli/run.ts:501-540` | Butuh snapshot config; bagian yang hanya env → tetap pra-bind, bagian yang butuh validasi penuh → ikut pindah (§6). |
| 12 | Port/bind/auth: `parseTcpPort`, `resolveGatewayPort`, `getGatewayStartGuardErrors` (**`gateway.mode=local` guard**), `resolveGatewayAuth` | `src/cli/gateway-cli/run.ts:555-560` (port), `:709-720` (guard), `:730-742` (`resolveGatewayAuth`) | Guard + auth resolve butuh `cfg` — ikut pindah pasca-bind kecuali yang bisa dipenuhi dari env + snapshot preflight (D-5). |
| 13 | `runGatewayLoop` (+ supervised lock recovery) → `startGatewayServer(port, { bind, mobileBoot, … })` | `src/cli/gateway-cli/run.ts:888-904`, `:925-935` | |

### 1.2 `startGatewayServer` → kernel → transport (masih pra-listen)

| # | Langkah | Berkas:baris | Keterangan |
|---|---|---|---|
| 14 | Resolve `mobileBoot` (fallback bila caller tidak memberi), `installGatewayDatabaseEngine`, `initializeSqliteRuntime` | `src/gateway/server.ts:81-96` | **Akses sqlite pertama** (engine install + runtime init) — pra-listen, pindah pasca-bind. |
| 15 | **`acquireGatewayLock`** (bila tidak ada `gatewayStateOwner`) | `src/gateway/server.ts:104-115` | Lock file/lease. **Pindah ke segera sesudah bind (§3.4)** — bind eksklusif (N2) menutup celah antar-bind-dan-lock; tidak ada akses sqlite di antaranya. |
| 16 | Spawn broker (Linux + transport tersedia) | `src/gateway/server.ts:196-230` | |
| 17 | `startGatewayServerCore` → `createGatewayKernel(port, opts, { deferEarlyRuntime:true, deferRequestRuntime:true })` | `src/gateway/server-start.ts:26-48`; `src/gateway/server-kernel.ts:106-148` | `defer*` berarti early/request runtime *dibangun* di kernel tetapi *join*-nya ditunda (lihat langkah 26–27). |
| 18 | **Kernel:** snapshot katalog model remote + impor `prepared-model-runtime.js` (paralel) | `src/gateway/server-kernel.ts:135-145` | Impor model runtime pra-listen — graf-sisa (Fase 4 menunda init-nya lebih jauh; Fase 1 hanya memindahnya). |
| 19 | **Bootstrap — baca config #3:** `readConfigFileSnapshotWithPluginMetadata` (snapshot read) + `assertConfiguredWorkspaceStateReady` | `src/gateway/server-startup-bootstrap.ts:140-160` | Pindah pasca-bind. |
| 20 | **Bootstrap:** state ownership (`assertOpenClawStateWriteAllowedAtPath`) + schema preflight sqlite (`preflightOpenClawDatabaseSchemas`, throw bila incompatible) | `src/gateway/server-startup-bootstrap.ts:162-215` | Pindah pasca-bind. |
| 21 | **Bootstrap:** network bootstrap (undici dispatcher), agent-CLI shim, impor `server-startup-config.js` | `src/gateway/server-startup-bootstrap.ts:216-247` | Pindah pasca-bind. |
| 22 | **Bootstrap:** `loadGatewayStartupConfigSnapshot` + auth bootstrap (`prepareGatewayStartupConfig`) + GitHub profile cleanup | `src/gateway/server-startup-bootstrap.ts:247-320` | Pindah pasca-bind. Termasuk `applyLoggingConfig`, `setGatewayRestartPolicy`, dsb. |
| 23 | **Bootstrap — slot F1:** `createDeferredSessionMigration()` bila ON (hanya membuat owner; migrasi TIDAK jalan di sini) | `src/gateway/server-startup-bootstrap.ts:493-500` | OFF: slot ini menjalankan `prepareGatewayStartupSessions` pra-listen (`bootstrap.ts:527-536`). |
| 24 | **Bootstrap — `preparations` (paralel, `Promise.allSettled`):** worker-environments store import; sessions admission (OFF saja; ON mengembalikan `[]`); `plugins.bootstrap-imports`; cron store path | `src/gateway/server-startup-bootstrap.ts:501-566` | Pindah pasca-bind. |
| 25 | **Bootstrap:** `prepareGatewayPluginBootstrap` (rencana plugin + subagent registry + A3 cache) + publish metadata snapshot | `src/gateway/server-startup-bootstrap.ts:559-589` | Pindah pasca-bind. |
| 26 | **Kernel state:** `prepareGatewayKernelState` — terminal policy, wizard imports, TLS runtime, channel manager, **`startupState` + `createStartupChecker` + `createReadinessChecker`** | `src/gateway/server-runtime-state-prepare.ts:400-490` | `startupState = { sidecarsReady, pendingReason:"startup-sidecars", dispatchReady:false }` (`:427-431`); `getStartup`/`getReadiness` dibuat di `:477-490`. **Pembuatan checker-nya sendiri murah** (closure + state) — tetapi dependensinya (channel manager, TLS, dsb.) berat. Di Fase 1, checker stub dibuat di graf-listen (D-7) dan checker penuh dibuat pasca-bind seperti sekarang. |
| 27 | **Kernel:** lifecycle, core runtime (`startGatewayCoreRuntime`), request runtime (`prepareGatewayKernelRequestRuntime` — chat-metadata lifecycle, config-revision projector, request context, **`sessions.projection`** `server-kernel-request-runtime.ts:65-75`) | `src/gateway/server-kernel.ts:180-230`; `src/gateway/server-kernel-request-runtime.ts:35-110` | `ensureRequestRuntimeReady` didefinisikan di `server-kernel-request-runtime.ts:186` dan di-join di finish (`finish.ts:240`). Pindah pasca-bind. |
| 28 | **Transport dibuat:** `createGatewayHttpTransport` — objek `httpServer` + `wss` + **handler request dipasang di konstruksi** (`server.on("request", …)`) | `src/gateway/server-start.ts:80-121`; `src/gateway/server-runtime-state.ts:200-440`; `src/gateway/server-http.ts:20-31` | Handler penuh butuh config, auth, registry, readiness — inilah alasan transport tidak bisa dipakai begitu saja sebagai graf-listen (§10 K-7). |
| 29 | `finishGatewayStartup`: impor `ws-connection.js` + `attachGatewayWsConnectionHandler` | `src/gateway/server-startup-finish.ts:150-194` | WS attach pra-listen hari ini; pindah pasca-bind (§3.5) — `isConnectPending` sudah menahan koneksi dini. |
| 30 | **`http.listen` → `http.bound`** | `src/gateway/server-startup-finish.ts:198-199` | `await startupTrace.measure("http.listen", () => runtime.startListening())`; `startupTrace.mark("http.bound")`. `startListening` sendiri (`server-runtime-state.ts:529-627`) masih melakukan: tailscale ingress, bind per host (`:562-597`, memanggil `listenGatewayHttpServer`), `onListening` (`:601` → `gatewayStateOwner.markListening`, `server-start.ts:74`), portal ingress, sandbox host, plugin legacy listeners. **KOREKSI presisi (§10 K-9): `http.listen` bukan satu syscall bind** — bind terjadi di dalam `http.listen.bind`; portal/sandbox/plugin-listeners adalah pasca-bind di dalam await yang sama. |

### 1.3 Sesudah `http.bound` hari ini (sudah pasca-listen — tetap, kecuali yang ditandai)

| # | Langkah | Berkas:baris | Keterangan |
|---|---|---|---|
| 31 | **F1:** mulai migrasi sesi tertunda (paralel dengan post-attach) | `src/gateway/server-startup-finish.ts:212-236` | Tetap; starter-nya `startDeferredSessionMigration` (`deferred-session-migration.ts:52-98`). |
| 32 | Human presence (ON, pasca-listen) | `src/gateway/server-startup-finish.ts:238-250` | Tetap. |
| 33 | Join `requestRuntimeReady` (`ensureRequestRuntimeReady` + `setDispatchReady(true)` + aktivasi agent-DB startup) | `src/gateway/server-startup-finish.ts:240-258` | Tetap. |
| 34 | Early runtime start; ON: tidak di-join sebelum post-attach (F4(b), mark `runtime.early.deferred`); OFF: `Promise.allSettled` | `src/gateway/server-startup-finish.ts:261-275` | Tetap. |
| 35 | **Post-attach** (`startGatewayPostAttachRuntime`): system-CA warmup, load startup plugins (essential bila ON), sidecars (worker env, channels, cron), startup log, update check (di-skip bila ON, F8), deferred plugin load latar (F5) | `src/gateway/server-startup-post-attach.ts:1-591` (inti: `:200-300` load plugins, `:311-440` sidecars, `:464-507` deferred F5, `:566-580` F8) | **Di sinilah pelepasan gerbang §5 bekerja** — sebagian langkah keluar dari jalur ready. |
| 36 | **`await deferredSessionMigration.ready`** (F1) | `src/gateway/server-startup-finish.ts:538-541` | **DILEPAS (Opsi A, §5.2)** — diganti gerbang tunggal di readiness checker. |
| 37 | `getReadiness.prepare()` → `publish().ready` → `mark("ready")` + `log.info("gateway ready")` | `src/gateway/server-startup-finish.ts:544-551` | Tetap; ini publikasi ready yang dipertahankan. |
| 38 | Late join early runtime + re-refresh discovery (ON) | `src/gateway/server-startup-finish.ts:560-571` | Tetap. |
| 39 | Config reloader, TLS renewal, post-ready maintenance, handler prewarm (idle) | `src/gateway/server-startup-finish.ts:573-873` | Tetap (post-ready). |

**Kesimpulan §1:** yang harus pindah ke sesudah `http.bound` adalah langkah **8–29** (minus yang murah dan tetap pra-bind menurut D-5: preflight core-only langkah 6, resolusi port/bind langkah 12-sebagian, resolve saklar langkah 5). Titik pisah yang baru bukan `finishGatewayStartup` — melainkan **di dalam `startGatewayServer` / `startGatewayServerCore`**, sebelum langkah 14 (lihat §3.1).

---

## 2. Definisi "graf-listen" — himpunan minimal untuk ikat socket + layani `/health` + `/` + auth gate

Graf-listen adalah himpunan modul yang **boleh** diimpor sebelum `http.bound`. Syarat masuk: (a) dibutuhkan untuk mengikat socket dan menjawab tiga hal di bawah; (b) tidak melakukan I/O berat (tidak baca sqlite, tidak baca config penuh, tidak memindai `extensions/`, tidak impor plugin runtime); (c) bebas efek samping top-level selain yang disebutkan.

### 2.1 Yang harus bisa dijawab sejak bind

| Permintaan | Jawaban stub | Auth |
|---|---|---|
| `GET /health`, `GET /healthz` | 200 `{"ok":true,"status":"live"}` | Tidak (seperti hari ini — `server-http-probes.ts:128-131` mengembalikan 200 untuk `live` tanpa auth, dan `server-http-request.ts:223-236` memanggilnya sebelum auth) |
| `GET /ready`, `GET /readyz` | 503 `{"ready":false}` (+ detail `failing:["starting"]` untuk local/auth, seperti `server-http-probes.ts:100-127`) + header `Retry-After: 1` (meniru OpenCode `process.ts:197-199`) | Status tanpa auth (seperti hari ini); detail hanya local/auth |
| `GET /startup`, `GET /startupz` | 503 `{"ok":false,"status":"starting","pendingReason":"<fase>"}` selagi starting; 200 sesudah started | Status tanpa auth; detail hanya local/auth (`server-http-probes.ts:26-37,100-127`) |
| `GET /` (dan aset shell placeholder) | Halaman placeholder "memulai" (D-6) — hanya sesudah cek token | **Ya, token wajib** (N1) — kecuali bila tidak ada token env sama sekali, maka 503 `starting` (bukan shell, bukan 401 — lihat §3.3) |
| Semua path lain | 503 `{"code":"service_starting"}` + `Retry-After: 1` (meniru OpenCode `process.ts:209,233-245`) | Tidak perlu (tidak ada data yang bocor; body generik) |
| WS upgrade (`Upgrade: websocket`) | Tutup socket (atau 503) — tidak ada `wss` di fase stub | — |

### 2.2 Daftar berkas persis graf-listen

| Berkas | Peran di graf-listen | Status |
|---|---|---|
| `node:http` (builtin) | `createServer`, `listen` | Ada |
| `src/gateway/server/http-listen.ts` | `listenGatewayHttpServer` — bind + retry EADDRINUSE 20× @ 500 ms (`:52-80` inti) | Ada, pakai ulang |
| `src/gateway/gateway-http-route-contracts.ts` | `classifyGatewayProbePath` (`/health`→live, `/ready`→ready, `/startup`→startup) | Ada, pakai ulang |
| `src/gateway/server-http-probes.ts` | `handleGatewayProbeRequest` — semantik jawaban probe (D-7) | Ada, pakai ulang **dengan checker stub**; verifikasi impornya tidak menarik graf berat (lihat risiko R-1) |
| `src/gateway/server/listen-stub.ts` | **BARU.** Dispatcher stub + halaman placeholder + `ListenPhase` + checker stub + auth stub (cek bearer token env). Dependency-free di load time (hanya `node:http` + kontrak route + probe handler). | Baru |
| `src/gateway/server-http.ts` (diubah minimal) | `createGatewayHttpServer` + `handlerRef` wrapper (D-1). Satu wrapper `((req,res) => handlerRef.current(req,res))` dipasang sekali di `server.on("request")` (`:26`). | Ubah kecil |
| `src/gateway/auth.ts` (sebagian) | `authorizeHttpGatewayConnect` / perbandingan token untuk stub — **hanya bila impornya ringan**; bila `auth.ts` menarik graf berat, stub memakai perbandingan token lokal minimal (timing-safe compare terhadap token env) dan auth penuh mengambil alih pasca-bind. **Keputusan ini diserahkan ke implementasi dengan syarat: buktikan lewat uji graf impor (§8.4) bahwa yang dipakai tidak menarik graf-sisa.** | Verifikasi dulu |
| `src/gateway/mobile-boot.ts` | `MobileBootOptions` (type) + `MOBILE_BOOT_DISABLED` — sudah diimpor di mana-mana, ringan. | Ada |
| `src/config/paths.ts` (sebagian) | `resolveStateDir` saja, untuk penulisan berkas registrasi (bila diputuskan). Tanpa membaca isi config. | Ada, bila dibutuhkan |
| `src/gateway/server-startup-trace.ts` (sebagian) | `startupTrace.mark("http.bound")` dan mark fase stub — hanya bila impornya ringan; bila tidak, stub memakai `console`/logger minimal dan trace bergabung pasca-bind. | Verifikasi dulu |

**Yang secara eksplisit BUKAN graf-listen** (dan tidak boleh diimpor sebelum bind): `server-startup-bootstrap.ts`, `server-kernel.ts`, `server-runtime-state-prepare.ts`, `server-runtime-state.ts` (transport penuh), `server-core-runtime.ts`, `server-kernel-request-runtime.ts`, `server-startup-plugins.ts`, `plugins/runtime.js`, `server-startup-post-attach.ts`, `server-startup-early.ts`, `control-ui.js` (modul Control UI — lazy di `server-http-modules.ts:3`), `server-methods/*`, `server/model-catalog.js`, `config/io.js` (baca config penuh), `state/*` (sqlite), `infra/gateway-lock.js` (lock — sesudah bind, §3.4).

### 2.3 Yang TIDAK perlu ada di graf-listen (keputusan sadar)

- **TLS.** Di Polones, gateway di-bind loopback tanpa TLS (probe 127.0.0.1:18789; TLS hanya relevan bila `gateway.tls.enabled` di config — yang belum dibaca saat bind). Stub mengikat HTTP polos di loopback. Bila config pasca-bind ternyata mengaktifkan TLS, server stub **tidak bisa** di-upgrade ke HTTPS di tempat (objek server sudah dibuat polos). Resolusi: **baca "transport facts" minimal pra-bind** — satu baca JSON mentah atas `gateway.tls` + `gateway.port`/`gateway.bind` dari berkas config, TANPA validasi/semantik, hanya untuk memutuskan jenis server. Bila baca mentah itu gagal (berkas tidak ada/rusak), anggap TLS off dan biarkan validasi pasca-bind yang gagal → exit 78. Pengecualian ini dicatat eksplisit karena satu-satunya yang dibaca pra-bind hanyalah fakta transport, bukan keputusan trust. **Bila di perangkat Polones TLS selalu off, langkah ini boleh dilewat (dead code) — implementasi harus membuktikannya dari config perangkat, bukan berasumsi.**
- **Control UI penuh.** Diganti placeholder (D-6). Aset `dist/control-ui` tidak di-stat/dibaca di fase stub.
- **WebSocket.** Tidak ada `wss` di fase stub; upgrade ditutup. Klien WS (TUI bridge, Control UI) baru terhubung sesudah ready — dan `isConnectPending` (`server-startup-finish.ts:181`) sudah dirancang untuk menahan koneksi dini, sehingga pemindahan WS attach ke pasca-bind tidak mengubah perilaku klien.
- **State/sqlite apa pun.** Tidak ada.

---

## 3. Restrukturisasi: titik pisah, apa yang pindah, bagaimana stub bekerja

### 3.1 Titik pisah — di dalam `startGatewayServer`, BUKAN di `finishGatewayStartup`

**KOREKSI atas asumsi rencana (§10 K-7):** rencana menyebut "titik pisah graf ADA di `http.bound`" — benar sebagai *trace mark*, tetapi **tidak ada seam kode di sana**. `finishGatewayStartup` menerima `kernelRuntime` yang sudah jadi (kernel + transport + readiness sudah dibangun, §1.2 langkah 17–28). Memakai `http.bound` sebagai titik pisah proses mengharuskan restrukturisasi di hulu:

```
SEBELUM (hari ini):
  run.ts ──► startGatewayServer (server.ts)
               ├─► lock, sqlite init, spawn broker
               ├─► startGatewayServerCore (server-start.ts)
               │     ├─► createGatewayKernel ──► bootstrap + kernel-state + lifecycle
               │     │                            + core runtime + request runtime
               │     ├─► createGatewayHttpTransport (server + handler penuh)
               │     └─► finishGatewayStartup ──► ws-attach ──► http.listen ──► post-attach ──► ready
SESUDAH (Fase 1, bila ON):
  run.ts ──► startGatewayServer (server.ts)
               ├─► [L0] resolve mobileBoot, port/bind dari snapshot preflight (D-5)
               ├─► [L1] GRAF-LISTEN: buat handlerRef + stub dispatcher
               │         + createGatewayHttpServer(stub) + listenGatewayHttpServer
               │         + mark("http.bound") + tulis registrasi + log "listening (starting)"
               ├─► [L1b] acquireGatewayLock (segera sesudah bind, §3.4)
               ├─► [L2] startGatewayServerCore ──► SEMUA langkah §1.2 (14,16–28)
               │         dipindah ke sini, dengan handler penuh dipasang ke
               │         handlerRef.current saat transport dibuat (D-1)
               │         + ws-attach (§3.5) + F1 + request runtime + post-attach
               └─► [L3] ready publication (arti tidak berubah, D-2)
               OFF: urutan lama utuh (N10) — cabang `if (mobileBoot.enabled)` di server.ts.
```

**Seam yang dipakai ulang:** `createGatewayHttpTransport` sudah menerima `testListener?: HttpServer` (`server-runtime-state.ts:176-190`) — server yang sudah terikat dari luar. Fase 1 **tidak** memakai parameter itu untuk produksi (semantiknya test-only + ada constraint TLS/bindHost), tetapi memakai **pola yang sama**: opsi baru `preboundListener` (atau nama setara) yang menerima server stub + `handlerRef`, sehingga transport tidak membuat server kedua. Bila transport tetap membuat server sendiri, akan ada dua server dan bind kedua gagal EADDRINUSE — ini bug yang harus dicegah oleh uji (§8).

### 3.2 Apa yang pindah ke sesudah `http.bound`

| Pindah (dari §1.2) | Ke mana | Catatan |
|---|---|---|
| Impor `server.js` (§1.1 langkah 8) | Tetap pra-bind sebagian: impor modul `server.js` (ringan, hanya `startGatewayServer` + lazy `loadServerStart`) tetap di `run.ts`; **impor `server-start.js` yang berat** tetap di-prewarm F6 tetapi tidak di-await pra-bind | `server.ts:loadServerStart` sudah lazy (`server.ts:25-30`); yang dipindah adalah *pemanggilan* rantai kernel, bukan impor tipisnya |
| Baca config #2 full (`run.ts:474`), penegakan F3(a) (`run.ts:490-499`), `gateway.mode=local` guard (`run.ts:709`), `resolveGatewayAuth` dari cfg (`run.ts:730-742`) | Pasca-bind, ke dalam bootstrap (§6) | Diganti pra-bind oleh: snapshot preflight (port/bind) + auth env (token/password dari env) |
| `installGatewayDatabaseEngine`, `initializeSqliteRuntime` (`server.ts:84-96`) | Pasca-bind, segera sesudah lock | |
| `acquireGatewayLock` (`server.ts:104-115`) | **Segera sesudah bind** (§3.4) — bukan sesudah seluruh bootstrap | |
| Spawn broker (`server.ts:196-230`) | Pasca-bind (tetap membungkus `startGatewayServerCore`) | |
| Seluruh `createGatewayKernel` (langkah 18–27) | Pasca-bind | Termasuk bootstrap, kernel-state, lifecycle, core runtime, request runtime |
| `createGatewayHttpTransport` — pembuatan server | **Diganti stub** pra-bind; pembuatan transport penuh pasca-bind, dengan server stub dipakai ulang | Handler penuh dipasang ke `handlerRef.current` |
| WS attach (`finish.ts:150-194`) | Pasca-bind, segera sesudah transport dibuat (sebelum `http.bound` kedua? tidak — lihat §3.5) | |
| Semua langkah §1.3 langkah 31–39 | Tetap pasca-listen (tidak bergerak) | |

### 3.3 Bagaimana stub dispatch bekerja

**Pemegang fase.** Satu objek mutable kecil, dibuat di `server.ts` sebelum bind dan di-thread ke stub + ke bootstrap/kernel lewat `GatewayServerOptions` (atau param eksplisit):

```ts
type ListenPhase =
  | { status: "listening"; reason: "bootstrap" }      // stub hidup, graf-sisa berjalan
  | { status: "listening"; reason: "config-invalid" } // terminal sesaat sebelum exit 78
  | { status: "ready" };                              // handler penuh mengambil alih
```

`ListenPhase` juga membawa: `bootId` (dibuat di sini bila kernel belum membuatnya — `randomUUID`, seperti `server-kernel.ts:123`), `startedAtMs`, `pendingReason` (diperbarui tiap fase bootstrap: `"config"`, `"plugins"`, `"sessions"`, `"sidecars"` — dipakai jawaban `/startup`), dan `authToken` (token env, bila ada).

**Dispatcher stub (baru).** Pseudocode perilaku (bukan kode final):

```
onRequest(req, res):
  path = pathname(req.url)
  kind = classifyGatewayProbePath(path)            // gateway-http-route-contracts.ts
  if kind == "live":                              // /health, /healthz
      return handleGatewayProbeRequest(req, res, path, stubAuth, [], false,
                                       undefined, stubReadiness, stubStartup)
      // stubReadiness.publish() -> { ready:false, coreReady:false, failing:["starting"] }
      // → 200 {"ok":true,"status":"live"} (cabang live di probes.ts:128-131)
  if kind == "ready" or kind == "startup":        // /ready, /startup (+z)
      return handleGatewayProbeRequest(...)        // → 503 + Retry-After: 1 (TAMBAH header ini;
                                                   // probes.ts hari ini tidak menyetel Retry-After)
  if path == "/" or path == "/starting" or path.startsWith("/starting/"):
      return handleStubShell(req, res)             // §3.3a
  return 503 {"code":"service_starting"} + Retry-After: 1
```

**§3.3a Shell placeholder + auth gate (N1).** Aturan auth stub — fail-closed, tiga kasus:

1. **Token env ada** (`OPENCLAW_GATEWAY_TOKEN` atau `OPENCLAW_GATEWAY_PASSWORD` — yang di Polones selalu disetel lewat `dynamicEnv` dari SecretStore; rencana §3.1): shell hanya dilayani bila `Authorization: Bearer <token>` cocok (timing-safe compare) atau cookie/token query `#token=` cocok — **mekanisme yang sama dengan gate Control UI penuh** (token `#token=` disebut N1). Bila tidak cocok → 401 (tanpa body yang membocorkan fase).
2. **Token env TIDAK ada:** shell menjawab 503 `starting` (bukan shell, bukan 401). Alasan: tanpa token env, stub tidak bisa membedakan mode `none` (yang baru diketahui sesudah config dibaca) dari mode token-yang-belum-dibaca; fail-closed berarti jangan sajikan shell tanpa keputusan auth. Sesudah config dibaca dan auth penuh diputuskan, handler penuh mengambil alih dan mode `none` kembali melayani seperti biasa. **Konsekuensi yang dicatat jujur:** di luar Polones (desktop, mode `none`, tanpa token env), shell placeholder tidak tampil sampai ready — regresi pengalaman kecil di luar Polones, diterima demi N1. (Di Polones tidak berdampak karena token selalu ada.)
3. **Loopback-only.** Stub hanya mengikat host loopback yang sama dengan bind target (`127.0.0.1` atau sesuai `resolveGatewayBindHost`). Tidak ada pengecualian LAN di fase stub — bila bind target adalah LAN, stub tetap mengikat loopback dulu dan bind LAN dilakukan pasca-bind oleh transport penuh? **Tidak** — itu akan mengubah arti bind (dua bind). Keputusan: stub mengikat **persis host yang sama** dengan yang akan dipakai transport (dari snapshot preflight); auth token tetap wajib. Loopback-only bukan lapisan tambahan di sini; token adalah lapisannya. (Bila implementasi menemukan bind LAN + token env tidak ada, fallback ke kasus 2: 503.)

**Placeholder yang disajikan.** HTML statis kecil yang di-embed di modul stub (bukan dibaca dari `dist/`): judul + status "Memulai gateway…" + alasan fase (`pendingReason` dari `/startup`) + polling `GET /startup` tiap 500 ms; bila `/startup` 200 dan `/ready` 200 → `location.reload()` ke `/` (Control UI penuh). Placeholder **tidak** menampilkan tombol kirim / input chat (N11 — tidak ada yang bisa diklik untuk mengirim). Placeholder memakai token yang sama di query (`?token=…` diteruskan saat reload — sama seperti Control UI hari ini).

**Peralihan stub → penuh.** Saat `createGatewayHttpTransport` selesai, ia memasang handler penuh ke `handlerRef.current` (D-1) dan `ListenPhase.status = "ready"` **hanya sesudah** `mark("ready")` di finish (`finish.ts:544-551`) — bukan saat transport dibuat. Artinya: antara transport dibuat dan ready dipublikasikan, request non-probe tetap dijawab stub (503 starting). Ini disengaja: handler penuh belum boleh melayani `chat.send` sebelum `unlockStartupMethods`. Satu assignment atomik; tidak ada jendela di mana dua handler aktif.

### 3.4 Lock sesudah bind (N4 — penalaran eksplisit)

Hari ini: lock dulu (`server.ts:104-115`), bind kemudian. Fase 1 (ON): bind dulu, lock segera sesudahnya, sebelum akses state apa pun. Penalaran keamanan:

- **Eksklusivitas proses:** bind TCP 18789 eksklusif (N2) adalah klaim eksklusivitas *pertama*; proses kedua yang mencoba bind mendapat EADDRINUSE dari `listenGatewayHttpServer` dan gagal sebelum menyentuh state. Jadi tidak ada dua proses yang bisa sama-sama lolos dari bind ke lock.
- **Eksklusivitas state:** tidak ada akses sqlite/state antara bind dan lock — semua akses itu ada di bootstrap/kernel yang berjalan sesudah lock. Satu-satunya tulisan di jendela itu adalah berkas registrasi (§4) — ditulis atomik (tulis-ke-temp + rename) dan tidak dibaca oleh gateway lain sebagai otoritas (hanya informasi).
- **Kegagalan lock pasca-bind:** bila lock gagal (pemilik lain yang sah memegang lock tetapi tidak memegang port — mis. gateway lama yang crash tanpa melepas lock file), proses menutup socket stub dan gagal seperti hari ini (error lock → exit). Perilaku luar sama; hanya urutannya berubah.
- **F2 `singleOwner`:** tidak berubah — `acquireGatewayLock` tetap menerima `mobileBoot` yang sama (`server.ts:104-115`); mode single-owner tetap melewati proyeksi file-lock seperti hari ini. **Ditandai untuk review Lead:** ini perubahan urutan pada mekanisme keamanan (N4) — bukan perubahan aturan, tetapi implementasi wajib menegaskan penalaran di atas dalam komentar + uji (dua proses berebut port → satu gagal di bind, bukan di lock).

### 3.5 WS attach pasca-bind

`attachGatewayWsConnectionHandler` (`finish.ts:150-194`) pindah ke sesudah transport penuh dibuat (masih sebelum post-attach). Alasan tidak ada perubahan perilaku:

- `isConnectPending: () => !startupState.dispatchReady` (`finish.ts:181`) sudah menahan koneksi WS dini; klien yang terhubung sebelum ready mendapat status pending, bukan penolakan.
- `startupMethodsReady: kernel.startupMethodsReady` (`finish.ts:180`) sudah digerbangi deferred.
- Selama fase stub (sebelum transport), upgrade WS ditutup di stub (§2.1) — klien WS yang mencoba terlalu dini akan retry (perilaku reconnect sudah ada di Control UI / TUI bridge; verifikasi di §8).

### 3.6 Apa yang TIDAK berubah di fase ini

- Urutan di dalam bootstrap/kernel/post-attach **tidak** diubah (hanya dipindah blok). Tidak ada refactor `prepareGatewayServerBootstrap` atau `prepareGatewayKernelState` di Fase 1 — mereka dipanggil lebih lambat, bukan ditulis ulang.
- `http.listen` tetap memakai `runtime.startListening()` — tetapi kini `startListening` dipanggil dengan server yang **sudah terikat** (stub): `startListening` harus menjadi no-op untuk bind (server sudah listening) dan hanya menjalankan pasca-bind-nya (portal ingress, sandbox host, plugin listeners — `server-runtime-state.ts:603-622`). Alternatif yang lebih bersih: pecah `startListening` menjadi `bind()` + `startPostBindServices()`; stub memanggil `bind()`, transport memanggil sisanya. **Direkomendasikan pemecahan itu** (lebih eksplisit daripada flag "sudah terikat"), dengan `startListening` dipertahankan sebagai pembungkus untuk pemanggil lama (OFF + test).
- `markListening` (`server-start.ts:74`, via `onListening` di `server-runtime-state.ts:601`) harus dipanggil **saat stub bind**, bukan saat transport listen — karena itulah arti "listening". Implementasi memindahkan pemanggilan `onListening` ke titik bind stub (dan tidak memanggilnya dua kali).

---

## 4. Mekanisme registrasi dini + kontrak dengan Polones

### 4.1 Bagaimana Polones menemukan gateway hari ini (terverifikasi dari source Polones)

- **Spec (sumber kebenaran Rust, ADR 0023):** `native/crates/engine/src/harness/spec_table.rs:403-430` — OpenClaw: `workdir /root/openclaw/workspace`, `LaunchCommand::Proxy { front_port: 18790, upstream_command: "openclaw gateway run --allow-unconfigured" }`, **`health_url http://127.0.0.1:18789/health`**, **`ready_within_ms` 480.000** (480 dtk), `health_path: "/health"`.
- **Probe:** `native/crates/supervisor/src/health.rs` — `probe_http(port, timeout_ms, path)` (`:106-111`) melakukan TCP connect loopback (v4 lalu v6) + `GET /<path>` telanjang (tanpa token) dan membaca satu baris status; `status_is_healthy` (`:61-63`): **hanya 2xx yang Healthy** (pengecualian: 401 hanya di path root `""`, temuan #93 — tidak berlaku untuk `/health`); 503/500/404 = Down. `probe_http_status` (`:124-135`) mengembalikan juga kode terakhir yang teramati (untuk `startup-phases.log`).
- **Wait:** `native/crates/supervisor/src/start.rs:71,132,339-379` — `wait_ready` mem-probe `GET /health` berulang sampai Healthy atau `ready_within_ms` habis; sesudah itu tile menjadi READY (Berjalan). **Tidak ada pembedaan "hidup" vs "siap" hari ini — satu probe, satu status.**
- **Monitor berjalan:** `native/crates/supervisor/src/monitor.rs:207,363` — probe yang sama dipakai untuk memantau gateway yang sedang berjalan.
- **Proxy depan:** front port 18790 (mobile-patch `boot.mjs`/`proxy.mjs`) meneruskan ke 18789; WebView memuat lewat 18790. Proxy harus meneruskan status 503 + `Retry-After` dari stub tanpa mengubahnya menjadi 200/500 — **item verifikasi perangkat (§8.6)**.
- **Tidak ada berkas registrasi hari ini** — tidak ada pembaca `service.json` di Polones, dan fork tidak menulis berkas semacam itu (hanya `gatewayStateOwner.markListening`, `server-start.ts:74`).

**Konsekuensi langsung untuk Fase 1:** bila fork hanya memajukan `/health` 200 ke ~5–15 dtk tanpa perubahan Polones, **`wait_ready` akan menyatakan READY pada ~5–15 dtk dan tile menunjukkan "Berjalan" padahal chat belum bisa dikirim** — persis mode gagal yang dilarang N12. Maka **Fase 1 tidak selesai tanpa perubahan pendamping Polones** (K-3). Perubahan fork dan perubahan Polones harus dirilis bersamaan dalam satu APK (atau fork menahan `/health` 200 sampai… tidak — menahan `/health` membatalkan Fase 1; yang benar adalah mengubah Polones).

### 4.2 Kontrak probe yang diusulkan (wajib — sisi fork + sisi Polones)

| Sinyal | Arti | Sumber fork | Konsumsi Polones |
|---|---|---|---|
| `GET /health` 200 | **Hidup**: proses gateway hidup + socket terikat + stub menjawab. Bukan "siap". | Stub (§3.3); hari ini sudah 200 tanpa auth (`server-http-probes.ts:128-131`) | `wait_ready` tahap 1: tile **"Memulai" → "Hidup"**; mulai polling `/ready` (bukan langsung READY) |
| `GET /ready` 200 | **Siap**: post-attach + migrasi + essential plugin + `chat.send` tersedia (arti tidak berubah, D-2). | `getReadiness.publish().ready` (`finish.ts:544-551`, `readiness.ts`) | Tile **"Hidup" → "Siap"**; tombol Buka aktif penuh. Inilah yang hari ini disebut READY. |
| `GET /ready` 503 | Belum siap (body `{"ready":false}`; detail `failing` untuk local/auth) | Stub → checker penuh | Tetap di "Hidup"; polling lanjut |
| `GET /startup` 503 + `pendingReason` | Fase starting saat ini (`"startup-sidecars"`, `"agent-database-inspection"`, atau fase stub baru `"bootstrap"`/`"plugins"`/`"sessions"`) | `createStartupChecker` (`readiness.ts:33-57`); stub mengembalikan `pendingReason` dari `ListenPhase` | Sub-status di tile / log `startup-phases.log` (jejak N14) |
| Socket tidak menjawab / connection refused | Belum bind / proses mati | — | "Memulai" (seperti hari ini) |

**Perubahan Polones yang dibutuhkan (bukan bagian fork; dicatat sebagai dependensi):**

1. `wait_ready` (`start.rs:339-379`): dua tahap — tahap 1 tunggu `/health` 200 (batas tetap `ready_within_ms`, tetapi tile sudah boleh menunjukkan "Hidup"); tahap 2 tunggu `/ready` 200 (batas yang sama) sebelum READY. Status perantara ditampilkan di tile (K-3 opsi b — sudah diputuskan pemilik 26 Nov 08:12 WIB untuk rencana ini: "tile status perantara (Memulai → Hidup → Siap)").
2. Interval polling: 25 ms seperti OpenCode (`service-timing.ts:24-33`, via laporan audit) adalah agresif untuk perangkat; **usulan lane: 100 ms** (kompromi: responsif tanpa membanjiri daemon single-threaded — `health.rs:1-7` mencatat daemon melayani IPC di runtime single-threaded; polling 25 ms × 2 stack (v4+v6) × 2 endpoint dapat membebani). Keputusan akhir interval di tangan lane Polones; yang penting **polling `/ready` dimulai segera sesudah `/health` 200, bukan sesudah timeout**.
3. `monitor.rs`: pemantauan berjalan tetap memakai `/health` (liveness) — tidak berubah; tetapi bila `/ready` berubah 200 → 503 pada gateway yang sudah READY (mis. plugin reload), tile harus menunjukkan "Siap → Memulai" (atau "Terganggu"), bukan tetap READY. Ini mencegah READY yang menempel.
4. `probe_last_status` di `startup-phases.log` sudah mencatat kode terakhir (`health.rs:109-122`) — tambahkan kode `/ready` juga agar A' vs `/ready` terpisah di log perangkat (metrik §7 rencana: A' vs `/ready`).

### 4.3 Berkas registrasi dini (opsional — meniru OpenCode `service.json`)

OpenCode menulis `~/.local/state/opencode/service.json` (0600, berisi `url, pid, version, password`) di `onListen`, sebelum ready (`process.ts:84-90`, laporan audit §2). Padanan OpenClaw:

- **Lokasi:** `<stateDir>/gateway-registration.json` — `stateDir` dari `resolveStateDir(process.env)` (tanpa membaca config; `OPENCLAW_STATE_DIR` atau default). Di Polones, state dir gateway adalah `~/.openclaw` di dalam home harness (`/root/openclaw/.openclaw`).
- **Isi:** `{ "url": "http://127.0.0.1:18789", "port": 18789, "pid": <pid>, "bootId": "<uuid>", "status": "starting" | "ready", "version": "<versi>", "startedAtMs": <epoch> }`. Ditulis **atomik** (temp + rename) di `http.bound`; `status` diperbarui ke `"ready"` di `mark("ready")`; dihapus saat close bersih (bila crash, berkas basi dengan `pid` + `bootId` memungkinkan deteksi basi — pembaca wajib memvalidasi `pid` masih hidup dan `bootId` cocok, seperti `service-probe.ts` OpenCode).
- **Tidak ada password di berkas ini** (berbeda dengan OpenCode — token gateway Polones sudah dikelola SecretStore; menulis token ke berkas adalah pelanggaran N1).
- **Status keputusan:** **OPSIONAL, bukan prasyarat Fase 1** (D-4). Alasan: Polones tidak punya pembaca untuk berkas ini (polonesd berjalan di host Android; rootfs memang direktori di storage sehingga berkas *bisa* dibaca — tetapi jalurnya harus dipetakan dari rootfs guest `/root/openclaw/.openclaw` ke path host, dan itu pekerjaan Polones baru). Lane merekomendasikan **menulis berkasnya** (murah, berguna untuk debug + klien masa depan seperti TUI bridge) tetapi **tidak memblokir Fase 1** pada pembaca Polones. Bila Lead memutuskan berkas tidak perlu, hapus butir ini tanpa memengaruhi desain lain.

---

## 5. Pelepasan gerbang `/ready` dari aktivasi plugin + migrasi sesi

### 5.1 Peta gerbang `/ready` hari ini (semua harus dibaca sebelum melepas satu pun)

`/ready` 200 hari ini adalah hasil **rantai empat gerbang**, bukan satu `await`. Melepas satu tanpa memahami tiga lainnya adalah cara paling pasti memalsukan readiness.

| # | Gerbang | Berkas:baris | Apa yang ditahan |
|---|---|---|---|
| G1 | `await deferredSessionMigration.ready` sebelum publikasi ready | `src/gateway/server-startup-finish.ts:538-541` | `/ready` menunggu migrasi sesi fleet-wide selesai (atau gagal → startup gagal, N6). |
| G2 | `unlockStartupMethods` wrapper menunggu migrasi | `src/gateway/server-startup-finish.ts:367-376` | `chat.send`/`agent` (dan semua `STARTUP_UNAVAILABLE_GATEWAY_METHODS`) tetap UNAVAILABLE sampai migrasi selesai; baru lalu `kernel.unlockStartupMethods()` (`src/gateway/server-lifecycle.ts:275-279`) menghapusnya dari `unavailableGatewayMethods` + resolve `startupMethodsReady`. |
| G3 | Readiness checker: `isChatSendAvailable() === false` → `ready:false, failing:["chat-startup"]` | `src/gateway/server/readiness.ts:136-139`; `isChatSendAvailable: () => !unavailableGatewayMethods.has("chat.send")` di `src/gateway/server-runtime-state-prepare.ts:486` | **Ini gerbang yang sebenarnya menentukan `/ready`** — `getReadiness.publish().ready` di `finish.ts:544-548` membaca checker ini. Selama G2 belum dibuka, G3 menahan `/ready` apa pun yang dilakukan G1. |
| G4 | `createGatewayReadyAnnouncer` + `logGatewaySidecarsReady` | `src/gateway/server-startup-readiness.ts:21-64` | Pengumuman "gateway ready" digerbangi `isChatSendAvailable() && areSidecarsReady()` (`:33-38`). `markSidecarsReady` dipanggil dari `onSidecarsReady` (`server-lifecycle.ts` → post-attach observers `server-startup-post-attach.ts:536-545`). |
| G5 | Startup checker: `dispatchReady && sidecarsReady && unavailableGatewayMethods kosong` | `src/gateway/server/readiness.ts:33-57`; `isGatewayStartupPending` di `server-runtime-state-prepare.ts:466-476` | `/startup` 503 selagi salah satu belum terpenuhi; readiness `readReadiness` mengembalikan `failing:[pendingReason]` bila startup masih `"starting"` (`readiness.ts:109-112`). |
| G6 | Channel health di readiness | `src/gateway/server/readiness.ts:155-185` | Bila ada channel account yang `!healthy` dan tidak dalam grace/restart-handoff, `ready:false, failing:[channelId]` — **bahkan sesudah G1–G5 lolos**. |

Tambahan konteks: `STARTUP_UNAVAILABLE_GATEWAY_METHODS` = semua core method dengan `startup:true` di spesifikasi (`src/gateway/methods/core-method-policy.ts:27-31`); `unlockStartupMethods` dipanggil dari `runGatewayStartupObservers` (`server-startup-post-attach.ts:540-545`) **sesudah** `sidecarsPromise` selesai — jadi hari ini urutannya: plugin attach → sidecars → observers → unlock → (finish) ready. Dan `sidecarsPromise` di-await di `post-attach.ts:555-557` kecuali `sidecarStartup === "defer"`.

### 5.2 Yang dilepas di Fase 1 (Opsi A — arti `/ready` tidak berubah)

| Await / gerbang | Tindakan | Pengganti |
|---|---|---|
| **G1** — `await deferredSessionMigration.ready` di `finish.ts:538-541` | **HAPUS.** | G3 menjadi gerbang tunggal untuk migrasi: selama migrasi belum selesai, G2 menahan `chat.send`, G3 menahan `/ready`. Tidak ada gerbang kedua; tidak ada perubahan arti. Migrasi tetap berjalan di latar (sudah paralel sejak `finish.ts:212-236`); kegagalannya tetap menggagalkan startup — tetapi kini kegagalan itu terdeteksi di G2/G3 (unlock tidak pernah terjadi → `/ready` tetap 503 → `wait_ready` Polones timeout → start gagal), **bukan** lewat throw di finish. **Konsekuensi yang dicatat jujur:** mode gagal migrasi berubah dari "throw cepat + exit" menjadi "`/ready` tidak pernah hijau + timeout Polones". Agar tidak menjadi kegagalan diam-diam (N14), migrasi yang gagal harus juga (a) menulis log error + `startupTrace` mark, (b) mengeset `ListenPhase.pendingReason = "session-migration-failed"`, dan (c) — bila memungkinkan tanpa mengubah kontrak — mengakhiri proses dengan exit 1 setelah timeout singkat, supaya Polones tidak menunggu 480 dtk untuk sesuatu yang sudah pasti gagal. Butir (c) adalah **detail implementasi yang wajib diputuskan di implementasi** (bukan di desain ini): exit proaktif vs menunggu timeout. |
| **G2** — wrapper `unlockStartupMethods` menunggu migrasi (`finish.ts:367-376`) | **TETAP.** | Ini gerbang RPC F1 (M-7) — satu-satunya yang menahan `chat.send`/`agent` sampai migrasi selesai. Tanpa ini, chat pertama bisa membaca sesi yang belum termigrasi (N6). |
| **G3** — `isChatSendAvailable` di readiness checker | **TETAP.** | Gerbang tunggal arti `/ready`. |
| **G4** — announcer | **TETAP** (tetapi `areSidecarsReady` diubah maknanya — lihat §5.3). | |
| **G5** — startup checker | **TETAP**, dengan `sidecarsReady` yang didefinisikan ulang (§5.3). | |
| **G6** — channel health | **TETAP**, dengan catatan §5.3 tentang flapping. | |

### 5.3 Yang keluar dari jalur ready (pelepasan plugin + sidecar — D-3 konservatif)

Di dalam `startGatewayPostAttachRuntime`, yang hari ini di-await sebelum `sidecarsPromise` selesai (dan karena itu sebelum `unlockStartupMethods` di observers dan sebelum ready):

| Pekerjaan | Berkas:baris | Tindakan Fase 1 | Alasan bisa keluar |
|---|---|---|---|
| Load **deferred** startup plugins (F5) | Sudah latar: `server-startup-post-attach.ts:464-507` | Tetap latar (tidak berubah) | Sudah bukan di jalur ready (fire-and-forget, gagal → warn). |
| Load **essential** startup plugins | `server-startup-post-attach.ts:200-300` (`loadStartupPluginsIfNeeded`, fase `plugins.runtime-post-bind`); dipanggil dari `startSidecars` `:320-330` | **TETAP di jalur ready** (D-3) | `chat.send` butuh essential registry (provider owner, dst.). Lihat §5.4 untuk varian penuh. |
| Startup log (`logGatewayStartup`) | `server-startup-post-attach.ts:260-300` (`startStartupLog`, di-await di `startSidecars` `:411-412` + `startupLogSettled`) | **KELUAR dari jalur ready** — jadikan fire-and-forget seperti deferred load (gagal → warn, tidak menggagalkan). | Log bukan prasyarat chat. |
| Update check | `server-startup-post-attach.ts:566-580` (F8: sudah di-skip bila ON) | Tetap skip bila ON (tidak berubah) | Sudah keluar. |
| Control-UI-assets sidecar | `server-startup-post-attach.ts:154-171` (`controlUiRootLifecycle.start` sebagai sidecar) | **KELUAR dari jalur ready** — start-nya tetap berjalan tetapi tidak di-await sebelum ready; Control UI penuh tetap bisa dilayani dari `controlUiRoot` state (verifikasi §8.5) atau, bila belum, placeholder stub tetap tampil sampai sidecar ini selesai. | Aset UI bukan prasyarat `chat.send`. |
| Transcripts sidecar + handler prewarm | `server-startup-post-attach.ts:429-448` (`scheduleGatewayPrewarm`, `scheduleTranscriptsSidecar`) | **KELUAR dari jalur ready** — sudah berupa idle task; pastikan tidak ada await tersembunyi sebelum ready. | Prewarm hanya latensi. |
| Worker-environment sidecar start | `server-startup-post-attach.ts:360-375` | **TETAP di jalur ready** | Worker runtime dibutuhkan `chat.send` (placement). |
| Channels start (`startGatewaySidecars`) | `server-startup-post-attach.ts:377-410` | **TETAP di jalur ready untuk channel yang terkonfigurasi autostart** — tetapi dengan batas: channel yang gagal start tidak boleh menahan `/ready` selamanya bila channel itu bukan prasyarat chat (lihat catatan flapping di bawah). | Channel inbound bukan prasyarat `chat.send` dari WebUI; tetapi channel yang *gagal* vs *belum mulai* harus dibedakan (G6 sudah membedakannya lewat grace + restart-handoff). |

**Definisi ulang `sidecarsReady` (G4/G5).** Hari ini `sidecarsReady` berarti "semua sidecar + observers selesai". Fase 1 mendefinisikan ulang menjadi **"scaffolding sidecar selesai + worker env + channels yang terkonfigurasi sudah *dimulai* (bukan selesai start)"** — yaitu titik di mana `onSidecarsReady` boleh dipanggil tanpa menunggu startup log / control-ui-assets / transcripts / prewarm. Implementasi: `onSidecarsReady` dipanggil dari observers seperti sekarang, tetapi observers dipanggil lebih awal (sesudah `startGatewaySidecars` mengembalikan handle, bukan sesudah semua sidecar latar selesai). **Risiko flapping (G6):** bila channel masih dalam grace period saat `/ready` pertama 200, lalu grace habis dan channel ternyata gagal → `/ready` berbalik 503. Itu perilaku **benar** (readiness memang harus mencerminkan channel yang gagal), tetapi Polones harus menanganinya (tile "Siap → Terganggu", §4.2 butir 3) — bukan menyembunyikannya. Yang **dilarang** adalah membuat `/ready` 200 lalu diam-diam tidak pernah mengecek lagi.

### 5.4 Varian penuh — "ready tanpa attach plugin sama sekali" (TIDAK diputuskan; ditandai untuk pemilik)

Rencana §12.2 M-4 (mengikuti OpenCode: hanya 6 endpoint menunggu plugin maks 5 dtk) menyarankan `/ready` tidak digerbangi aktivasi plugin sama sekali. Setelah membaca source, lane menyatakan **varian ini tidak bisa diimplementasikan tanpa mengubah arti `/ready`**:

1. `chat.send` adalah core method yang handler-nya membutuhkan model runtime + session projection + **essential plugin registry** (provider owner untuk model yang terkonfigurasi). Bila essential belum ter-attach, `chat.send` akan gagal (bukan menunggu) — sehingga `/ready` = "bisa chat" tidak bisa 200.
2. Satu-satunya cara varian penuh bekerja adalah mendefinisikan ulang `/ready` menjadi "server bisa melayani request non-chat + shell" dan menambahkan sinyal kedua untuk chat-ready (mis. field `chatReady:false` di body `/ready`, atau endpoint baru). Itu adalah **perubahan N9** (arti `/ready`) + perubahan kontrak probe Polones (K-3) + perubahan arti yang dibaca tile.
3. OpenCode bisa melakukannya karena arsitekturnya per-Location malas: handler menjawab "apa yang sudah termuat" dan aktivasi terjadi per-request pertama (laporan audit §4). OpenClaw tidak punya pemetaan per-Location (rencana §12.4 butir 3: "SULIT tanpa refactor arsitektur plugin").

**Rekomendasi lane:** implementasikan **Opsi A (§5.2–5.3)** di Fase 1. Varian penuh dicatat sebagai **pekerjaan lanjutan Fase 5** (aktivasi plugin per-request / malas penuh) + **keputusan pemilik** (perubahan arti `/ready`, analog K-8). Jangan diam-diam mengubah arti — nyatakan dan minta keputusan. (Ketegangan dengan N9 ini dinyatakan eksplisit di sini, sesuai perintah tugas.)

### 5.5 ANALISIS KEJUJURAN (N9/N6) — apa arti `/ready` sesudah dilepas

**Jawaban jujur, dalam satu kalimat:** sesudah Fase 1 Opsi A, **`/ready` tetap berarti "bisa chat"** — tidak ada perubahan arti; yang berubah hanyalah *pekerjaan apa yang tidak lagi ditunggu* sebelum arti itu dinyatakan (startup log, deferred plugin, control-ui-assets, prewarm), sementara pekerjaan yang *membuktikan* arti itu (migrasi via G2/G3, essential attach, worker env, unlock) tetap ditunggu.

**Jendela "Hidup tetapi belum Siap" dan status UI-nya.** Selama jendela itu (stub hidup ~5–15 dtk → ready ~60–90 dtk), UI harus menampilkan:

| Keadaan | Tile Polones | WebView (placeholder) | Yang bisa dilakukan user |
|---|---|---|---|
| Socket belum terikat | **Memulai** | (belum bisa dibuka — proxy belum menjawab) | Menunggu |
| `/health` 200, `/ready` 503 | **Hidup** (baru — K-3 opsi b) + sub-status `pendingReason` | Placeholder "Memulai gateway…" + fase (`pendingReason` dari `/startup`); **tidak ada input kirim** | Melihat progres; tidak bisa chat |
| `/ready` 200 | **Siap** | Control UI penuh; input chat aktif | Chat pertama (boleh ~2–5 dtk lebih lambat bila init model ditunda — K-8, Fase 4) |
| `/ready` 200 → 503 lagi (channel gagal / reload) | **Terganggu** (baru) | Control UI penuh tetap tampil + banner "sebagian layanan belum siap" | Chat tetap bisa (core ready); channel yang gagal dilaporkan jujur |

**Yang TIDAK boleh terjadi:** tile "Siap"/"Berjalan" saat `/ready` 503; placeholder yang menampilkan input chat aktif; `/ready` 200 saat `chat.send` masih UNAVAILABLE. Ketiganya adalah readiness palsu (N9/N11) dan masing-masing harus dicegah oleh uji (§8).

**Ketegangan yang tersisa (dinyatakan, bukan disembunyikan):**

- **T-1 (N9 vs M-7):** rencana M-7 ("`/ready` jangan menunggu migrasi") bertentangan dengan N9 + G3 bila dibaca harfiah. Resolusi lane (Opsi A): `/ready` tidak lagi *menunggu migrasi lewat G1*, tetapi tetap *tidak bisa hijau sebelum migrasi selesai* lewat G2/G3. Bila pemilik menginginkan M-7 harfiah (ready hijau selagi migrasi berjalan), itu adalah **Opsi B** (definisi ulang `/ready` + sinyal chat-ready kedua) dan butuh keputusan eksplisit — lane tidak mengambilnya sendiri.
- **T-2 (N9 vs kecepatan):** perbaikan `/ready` dari Fase 1 Opsi A adalah **sefraksi, bukan orde-besaran** — bila migrasi/essential mendominasi, `/ready` tetap puluhan detik. Yang orde-besaran membaik adalah A' (hidup) dan B' (shell). Klaim "Fase 1 membuat `/ready` 3 detik" adalah **salah** dan tidak boleh disampaikan. Perbaikan `/ready` yang besar membutuhkan Fase 4 (model) + Fase 5 (hidrasi malas sesi).
- **T-3 (G6 vs kecepatan):** channel health bisa menahan `/ready` sesudah semua gerbang lain lolos. Bila perangkat user punya channel yang lambat/gagal, `/ready` tetap lambat. Itu benar secara kejujuran — tetapi lane mencatatnya agar tidak ada yang terkejut saat pengukuran perangkat menunjukkan `/ready` tidak membaik sebanyak A'.

---

## 6. Config sesudah `http.bound` (M-6) — tetap exit 78 bila invalid (N5)

### 6.1 Di mana config dibaca/divalidasi hari ini

| Tempat | Berkas:baris | Isi | Nasib di Fase 1 |
|---|---|---|---|
| Preflight | `src/cli/gateway-cli/run-command.ts:23-76` → `ensureCliExecutionBootstrap` → `readAdmittedConfigSnapshot` (`src/commands/config-preflight-snapshot.ts`, `src/commands/startup-config-preflight.ts`) | Baca snapshot config; **F3(a): core-only bila ON** (`includePluginMetadata:false`, `skipPluginValidation:true`) | **TETAP pra-bind** (D-5). Ini baca murah (JSON + parse, tanpa metadata plugin, tanpa secrets, tanpa state snapshot penuh) dan hasilnya dipakai untuk port/bind. |
| CLI run | `src/cli/gateway-cli/run.ts:474` → `readGatewayStartupConfig` (`run.ts:136-160`, full `readConfigFileSnapshotWithPluginMetadata`) | Baca full + throw bila read failure | **PINDAH pasca-bind.** `run.ts` memakai snapshot preflight untuk kebutuhannya (port/bind/auth-env); baca full dilakukan bootstrap pasca-bind. |
| CLI run — penegakan invalid | `src/cli/gateway-cli/run.ts:490-499` → `throw createInvalidConfigError` → `runGatewayCommand` recovery offer → exit 78 | Validasi plugin-invalid | **PINDAH pasca-bind** (ke titik yang sama dengan bootstrap validation; lihat §6.2). |
| CLI run — mode guard | `src/cli/gateway-cli/run.ts:709-720` `getGatewayStartGuardErrors` (`gateway.mode=local`) | Tolak start bila mode bukan local (kecuali `--allow-unconfigured`) | **PINDAH pasca-bind** — keluarannya sama (exit 78), hanya waktunya sesudah bind. |
| CLI run — auth resolve | `src/cli/gateway-cli/run.ts:730-742` `resolveGatewayAuth({ authConfig: cfg.gateway?.auth, … })` | Token/password/mode dari config + override | **DIBELAH:** pra-bind hanya auth-env (token/password dari env, §3.3); resolve penuh dari config pasca-bind, lalu `handlerRef` auth diganti ke auth penuh. |
| Bootstrap | `src/gateway/server-startup-bootstrap.ts:140-160` (snapshot read) + `:247-258` (`loadGatewayStartupConfigSnapshot`) + `:289-303` (`prepareGatewayStartupConfig`, aktivasi secrets) + `setAppliedRuntimeConfigSnapshot` | Baca + validasi + aktivasi penuh | **TETAP di bootstrap — yang pindah adalah bootstrap-nya sendiri** (pasca-bind). Tidak ditulis ulang. |

### 6.2 Alur baru (ON)

```
pra-bind:
  1. Preflight core-only (tetap) → snapshot murah { config, valid?, exists? }
     - Bila snapshot TIDAK ADA (fresh install, --allow-unconfigured): lanjut
       (kasus ini memang tidak punya config untuk divalidasi).
     - Bila snapshot ada tetapi JSON-nya tidak bisa di-parse SAMA SEKALI
       (read failure): TETAP gagal pra-bind seperti hari ini
       (run.ts:155-157 throw createConfigReadError) — karena tanpa parse,
       port/bind pun tidak bisa diputuskan. Ini satu-satunya validasi yang
       tersisa pra-bind, dan ia murah (parse-only, bukan validasi semantik).
  2. run.ts memakai snapshot preflight untuk: port (resolveGatewayPort),
     bind (defaultGatewayBindMode), transport-facts peek TLS (§2.3),
     auth-env (token/password env).
  3. STUB BIND (http.bound) — /health 200, /ready 503, shell 503/placeholder.
pasca-bind:
  4. Bootstrap penuh: baca full + validasi semantik + aktivasi secrets
     (langkah bootstrap yang sama, hanya lebih lambat).
  5. Bila invalid (snapshot.valid === false, plugin-invalid, mode != local):
     a. Log error yang sama persis dengan hari ini (issue lines via
        renderConfigValidationIssueLines — yang dipakai run.ts:490-499).
     b. Set ListenPhase.pendingReason = "config-invalid".
     c. Tutup socket stub, bebaskan lock, **exit 78** (EXIT_CONFIG_ERROR,
        run.ts:106) — JANGAN exit 1. Jalur exit-nya harus SAMA dengan hari
        ini (runGatewayCommand → defaultRuntime.exit(EXIT_CONFIG_ERROR)),
        hanya pemicunya dipindah. Polones melihat proses mati + wait_ready
        gagal → start gagal → karantina + retry sekali, persis seperti hari
        ini (rencana §5 N5: "Polones mengandalkan exit 78 untuk karantina
        + retry sekali").
     d. JANGAN tawarkan recovery interaktif pasca-bind (recovery offer
        hari ini adalah prompt CLI; gateway Polones non-interaktif —
        tawarkan hanya bila stdin adalah TTY, seperti hari ini).
  6. Bila valid: lanjut kernel → transport → ready seperti biasa.
```

### 6.3 Hal yang harus dijaga

- **Socket yang sempat terikat lalu proses exit 78** bukan "server setengah jalan": Polones `wait_ready` melihat `/health` 200 sebentar lalu connection refused — dan `status_is_healthy` + `wait_ready` sudah menangani peer yang hilang (probe berikutnya Down; `health.rs:106-135`). Tile tidak boleh sempat menampilkan "Hidup" permanen untuk proses yang mati — tahap "Hidup" harus selalu diikuti polling `/ready` dan deteksi kematian proses (monitor tetap mem-probe; bila probe gagal sesudah "Hidup", kembali ke "Memulai"/gagal). Ini pekerjaan lane Polones (§4.2), dicatat di sini agar tidak hilang.
- **Crash-loop breaker:** exit 78 pasca-bind tetap dihitung sebagai boot yang gagal oleh breaker (`run.ts` `beginBoot`/`completeBoot`, `run.ts:826-880`) — sama seperti hari ini. Tidak ada perubahan perilaku breaker.
- **Config reload pasca-start tidak berubah:** `startManagedGatewayConfigReloader` (`finish.ts:573+`) tetap bekerja dari snapshot yang sama; Fase 1 tidak menyentuh jalur reload.
- **N5 dipertahankan penuh:** tidak ada config invalid yang bisa menghasilkan gateway yang jalan; satu-satunya perbedaan adalah socket sempat menjawab 503 (bukan 200-ready) sebelum exit. Itu jujur (N9): 503 berarti "starting", dan proses yang akan mati memang masih "starting" saat itu.

---

## 7. Analisis risiko + guardrail N1–N14

### 7.1 Risiko implementasi

| # | Risiko | Dampak bila terjadi | Mitigasi (di desain) |
|---|---|---|---|
| R-1 | **Stub menarik graf berat.** `server-http-probes.ts` mengimpor `auth.js`, `ingress-attribution.js`, `server-http-modules.js` (lazy) — bila salah satunya menarik `server-startup-*`/plugin runtime di top-level, graf-listen bocor dan A' tidak membaik. | A' tetap puluhan detik; Fase 1 gagal diam-diam. | Uji graf impor (§8.4) sebagai gate: impor modul stub di proses terisolasi dan assert tidak ada modul berat di `require.cache`/import map. Bila bocor, stub tidak memakai `handleGatewayProbeRequest` melainkan implementasi probe minimal inline (duplikasi kecil yang diizinkan dengan komentar + uji paritas) — keputusan fallback ini dicatat di sini agar implementasi tidak diam-diam memilih. |
| R-2 | **Siklus impor / `ReferenceError`.** Modul graf-sisa yang dipindah mungkin diimpor statis oleh modul graf-listen (atau sebaliknya). | Crash saat boot / `ReferenceError` di runtime. | Aturan: modul stub **tidak boleh** mengimpor statis apa pun di luar daftar §2.2; semua yang dibutuhkan pasca-bind diimpor dinamis di titik pakai (pola F4(a) yang sudah terbukti). Audit impor dilakukan per langkah (§9) dengan `madge`-like check atau `node --check` + uji impor terisolasi. |
| R-3 | **Dua server / bind ganda.** Transport penuh membuat server kedua di port yang sama → EADDRINUSE → startup gagal. | Boot gagal total (regresi fatal). | Transport menerima `preboundListener` (pola `testListener`, §3.1); uji boot penuh ON + OFF (§8.2) menangkapnya. |
| R-4 | **Handler penuh tidak pernah mengambil alih** (bug `handlerRef`): stub tetap menjawab 503 selamanya. | `/ready` tidak pernah 200; start timeout. | `handlerRef.current` di-assert di uji boot (request `/` sesudah ready mengembalikan Control UI penuh, bukan placeholder); `ListenPhase` di-log di tiap transisi (N14); monitor Polones mendeteksi `/ready` tak kunjung 200. |
| R-5 | **Auth stub lebih lemah dari auth penuh** (mis. token query diterima di stub tetapi tidak di penuh, atau sebaliknya). | Akses tanpa auth (N1) atau lockout sah. | Paritas auth diuji eksplisit (§8.3): matriks token benar/salah/tidak ada × stub/penuh × `/`/`/ready`/`/health`. Token yang dipakai stub HANYA token env yang sama dengan yang dipakai penuh (tidak ada sumber token kedua). |
| R-6 | **TLS (bila enabled).** Stub polos + config TLS → server tidak bisa di-upgrade. | Boot gagal / TLS tidak aktif (regresi keamanan transport). | Transport-facts peek (§2.3) + uji config TLS di CI (uji: config dengan `gateway.tls.enabled` → stub tetap mengikat dengan benar atau gagal eksplisit pra-bind, bukan diam-diam polos). Di Polones TLS off — verifikasi dari config perangkat. |
| R-7 | **WS klien dini.** Klien WS yang retry agresif saat stub menutup upgrade bisa membanjiri log / menahan reconnect. | Noise log; TUI bridge lambat connect. | Stub menutup upgrade dengan bersih (destroy socket, tanpa body); reconnect backoff sudah ada di klien; uji: koneksi WS pra-ready → ditutup bersih, pasca-ready → terhubung. |
| R-8 | **Lock-after-bind race** (dua proses: A bind + belum lock, B bind gagal — benar; tetapi A crash di antara bind dan lock → lock basi + port bebas → proses berikutnya harus tetap bisa start). | Start berikutnya gagal di lock basi. | Lock basi sudah ditangani mekanisme lock yang ada (F2/proyeksi + `isPidDefinitelyDead`); tidak ada state baru. Uji: kill -9 di antara bind dan lock (diuji lewat gate yang menahan lock) → start berikutnya berhasil. |
| R-9 | **Proxy 18790 tidak meneruskan 503/`Retry-After`.** WebView melihat error proxy, bukan placeholder. | B' tidak tercapai lewat jalur Polones (tetapi tercapai lewat 18789 langsung). | Verifikasi perangkat (§8.6): buka via 18790 saat starting → placeholder tampil. Bila proxy mengubah status, perbaiki proxy (pekerjaan Polones, bukan fork) — dicatat sebagai dependensi. |
| R-10 | **Regresi OFF.** Cabang ON yang bocor ke OFF (mis. `handlerRef` dipakai di kedua mode). | Upstream behavior berubah (N10). | Semua perubahan di belakang `mobileBoot.enabled` (pola F4(b) `it.each([true,false])`); uji OFF menegaskan urutan lama + `/ready` tetap menunggu early runtime (pola `server-startup-finish.mobile-boot.test.ts`). |
| R-11 | **`/ready` flap 200 → 503 (G6).** Channel gagal sesudah ready dipublikasikan. | Tile berkedip; user bingung. | Bukan dicegah — ditangani jujur (§5.3 + §4.2 butir 3): tile "Terganggu", body `/ready` membawa `failing`. Uji: channel gagal pasca-ready → `/ready` 503 + `failing:[channelId]`. |

### 7.2 Guardrail N1–N14 — mana yang tersentuh

| # | Guardrail | Tersentuh? | Penilaian |
|---|---|---|---|
| N1 | Auth Gateway + Control UI | **YA — tersentuh, tidak berubah** | Stub auth (§3.3a) adalah titik risiko utama. Aturan tidak berubah; implementasi harus membuktikan paritas token (uji §8.3). `/health` tetap tanpa auth seperti hari ini (bukan perubahan). |
| N2 | Bind eksklusif TCP 18789 | **YA — tersentuh prosedural, tidak berubah** | Bind menjadi klaim eksklusivitas pertama (sebelum lock). `listenGatewayHttpServer` + retry EADDRINUSE dipakai ulang. |
| N3 | State dir + integritas SQLite | TIDAK | Tidak ada akses state sebelum lock pasca-bind. |
| N4 | Invarian lock | **YA — tersentuh prosedural, tidak berubah** | Lock pindah ke sesudah bind (§3.4). Penalaran dicatat; **butuh review Lead saat implementasi** (bukan keputusan lane ini untuk mengubah aturan — aturannya tetap). |
| N5 | Validasi config + exit 78 | **YA — tersentuh waktu, tidak berubah hasil** | Validasi pindah pasca-bind; exit 78 dipertahankan (§6). |
| N6 | Migrasi sesi tidak pernah dilewati | **YA — tersentuh, tidak berubah** | G1 dilepas, G2/G3 tetap (§5.2). Kegagalan migrasi tidak boleh diam-diam (N14): log + pendingReason + exit proaktif (diputuskan di implementasi, §5.2). |
| N7 | Semantik `plugins.deny` | TIDAK | Split essential/deferred tidak diubah; deny diterapkan saat resolusi rencana, sebelum split. |
| N8 | Lantai runtime Node | TIDAK | |
| N9 | Sinyal readiness jujur | **YA — TERSENTUH PALING DALAM** | Opsi A mempertahankannya; Opsi B (varian penuh) akan mengubahnya dan **TIDAK diputuskan di sini** — lihat §5.4–5.5. **Bila implementasi menemukan Opsi A tidak cukup, BERHENTI dan laporkan ke Lead (aturan berhenti rencana §5).** |
| N10 | Default OFF = upstream | **YA — dijaga** | Semua perubahan di belakang `mobileBoot.enabled`; OFF = urutan lama utuh. |
| N11 | Tidak ada readiness palsu di UI | **YA — dijaga** | Placeholder "memulai", tanpa input kirim (§3.3a, §5.5). |
| N12 | Kontrak probe dengan Polones | **YA — tersentuh, butuh perubahan pendamping** | Tanpa perubahan Polones (§4.2), Fase 1 memalsukan tile. **Fase 1 tidak selesai tanpa itu.** |
| N13 | Prestart opt-in | TIDAK | Fase 2, bukan Fase 1. |
| N14 | Tidak ada kegagalan diam-diam | **YA — dijaga** | Setiap deferral baru meninggalkan jejak: mark `http.bound` + transisi `ListenPhase` + log handover stub→penuh + warn deferred plugin (sudah ada) + pendingReason migrasi-gagal (§5.2). |

**Tidak ada guardrail yang harus berubah menurut desain ini.** Yang ditandai untuk Lead/pemilik (bukan diputuskan lane): (a) perubahan urutan N4 (§3.4) — review saat implementasi; (b) Opsi B / varian penuh plugin (§5.4) — keputusan pemilik; (c) interval polling + tile "Terganggu" (§4.2) — keputusan lane Polones; (d) berkas registrasi opsional (§4.3) — boleh dihapus Lead tanpa memengaruhi desain lain.

---

## 8. Rencana test + verifikasi di CI (tanpa build dist lokal)

**Konteks lingkungan (terverifikasi 26 Nov 2026):** `node_modules` ADA di fork (2,9 GB) sehingga test bertarget mungkin bisa jalan lokal, tetapi memori VM ketat (~700 MB bebas saat lane ini bekerja). Lane ini **tidak menjalankan test apa pun** (rekognisi saja). Implementasi boleh mencoba SATU berkas test bertarget dengan heap terbatas dan berhenti bila OOM; **verifikasi utama tetap CI** (GitHub Actions, heap ≥4,4 GB untuk build `dist/` — lihat rencana §4 Fase 6).

### 8.1 Test unit baru (cepat, tanpa boot gateway)

| Test | Berkas (usulan) | Yang diassert |
|---|---|---|
| Stub probe per fase | `src/gateway/server/listen-stub.test.ts` (baru) | `listening` → `/health` 200 `live`, `/ready` 503 + `Retry-After: 1`, `/startup` 503 + `pendingReason`, `/` tanpa token → 503 (bukan shell), `/` token salah → 401, `/` token benar → placeholder berisi "memulai" (bukan "ready"), path lain → 503 `service_starting`. Fase `ready` → stub menyerahkan ke handler penuh (assert `handlerRef.current` berganti). |
| Auth stub paritas | sama | Token env yang sama diterima/ditolak identik oleh stub dan oleh `authorizeHttpGatewayConnect` (uji matriks §7.1 R-5). |
| Registrasi (bila diputuskan) | sama / `src/gateway/server/listen-registration.test.ts` | Tulis atomik di `http.bound` (isi: url/port/pid/bootId/status `starting`); update ke `ready`; pid basi terdeteksi (pid tidak hidup → pembaca menolak). |
| Split/plan tidak berubah | `src/gateway/server-startup-plugins.mobile-boot.test.ts` (perluas) | Essential/deferred split tidak berubah; `plugins.deny` tetap mengalahkan segalanya (N7). |

### 8.2 Test boot (gateway sungguhan, pola F4(b))

| Test | Berkas | Yang diassert |
|---|---|---|
| Stub menjawab sebelum bootstrap selesai (ON) | `src/gateway/server-startup-listen-stub.mobile-boot.test.ts` (baru) | Gate satu langkah bootstrap yang lambat (mock seperti `server-startup-finish.mobile-boot.test.ts` — mock `startGatewayEarlyRuntime` atau tahan `prepareGatewayServerBootstrap`); selagi gate tertutup: `/health` 200, `/ready` 503, `/` placeholder (token benar). Buka gate → `/ready` 200 + `/` Control UI penuh. |
| OFF tidak berubah | sama, `it.each([true,false])` | OFF: `/health` tetap belum menjawab selagi bootstrap tertahan (urutan lama); `/ready` tetap 503 selagi early runtime digate (pola F4(b) yang sudah ada). |
| Satu server, satu bind | sama | Sesudah boot penuh: hanya satu listener di port (probe tidak EADDRINUSE; `server.close()` menutup semuanya — tidak ada socket stub yang tertinggal). |
| Config invalid pasca-bind → exit 78 | Uji kontrak CLI (baru) + uji unit | Unit: fungsi validasi pasca-bind melempar `InvalidConfigError` yang sama dengan `run.ts:490-499`. Kontrak (CI): jalankan `openclaw gateway run` dengan config invalid (ON) → proses exit 78 DAN `/health` sempat 200 lalu mati (assert dari log + probe, bukan dari "tidak ada error"). |
| Migrasi gagal → tidak diam-diam | Perluas `server-startup-finish.mobile-boot.test.ts` atau test deferred-migration | Migrasi yang dibuat gagal → `/ready` tetap 503 + log error + `pendingReason` `session-migration-failed` (dan exit proaktif bila diputuskan §5.2). |
| Channel gagal pasca-ready → flap jujur | Perluas `server-startup-post-attach.test.ts` / readiness test | `/ready` 200 → (channel gagal) → `/ready` 503 + `failing:[channelId]`; tidak pernah 200 dengan `chat.send` UNAVAILABLE. |

### 8.3 Test yang diubah (bukan ditambah)

- `src/gateway/server-startup-finish.mobile-boot.test.ts` — tetap hijau; catat bahwa ekspektasi ON-nya ("`/ready` 200 selagi early runtime digate") tetap berlaku (Fase 1 tidak mengubah F4(b)).
- `src/gateway/server-startup-minimal-boot.test.ts` — perhatikan ekspektasi `startupMeasures.indexOf("http.listen")` dan `indexOf("runtime.early") > indexOf("http.listen")`: sesudah Fase 1, `http.listen` (bind stub) terjadi SEBELUM `runtime.early` tetap — tetapi `http.listen` sebagai *measure* kini terbelah (bind vs post-bind services, §3.6). Perbarui ekspektasi ke nama measure yang baru; jangan hapus assert urutannya.
- `src/gateway/server-http.control-ui-lazy.test.ts`, `src/gateway/server-http.control-ui.test.ts` — handler penuh kini dipasang lewat `handlerRef`; pastikan uji-uji ini tetap memakai jalur yang sama (bukan jalur pintas yang melewatkan `handlerRef`).
- Test `server-startup-trace.f9.test.ts` / `MEASUREMENT.md` — tambah measure baru: `http.listen.bind-stub`, `listen.stub-to-ready`, `config.validate-post-bind` (agar `startup-phases.log` memisahkan A' dari `/ready`).

### 8.4 Uji graf impor (gate R-1)

Test baru (unit, tanpa boot): impor modul stub di proses terisolasi (`node --import` / vitest dengan `vi.resetModules`) lalu assert himpunan modul yang termuat tidak mengandung `server-startup-bootstrap`, `server-kernel`, `plugins/runtime`, `server-startup-plugins`, `control-ui.js`, `config/io.js` (baca penuh). Bila assert ini gagal, implementasi WAJIB memakai fallback inline (§7.1 R-1), bukan mengabaikan gate.

### 8.5 Item verifikasi implementasi (checklist, bukan test otomatis)

1. `handleControlUiHttpRequest` bekerja bila `controlUiRootLifecycle.start()` belum berjalan — bila tidak, handover penuh harus menunggu sidecar itu (dan placeholder tetap tampil sampai saat itu). Buktikan dari source `server-control-ui-root.ts:341` (`start`) + uji boot.
2. `authorizeHttpGatewayConnect` vs token env: buktikan impor `auth.ts` ringan atau pakai perbandingan lokal (§2.2).
3. `startupTrace` di fase stub: buktikan impornya ringan atau pakai logger minimal (§2.2).
4. TLS peek (§2.3): buktikan dari config perangkat Polones apakah TLS pernah on; bila tidak pernah, peek boleh dilewat dengan komentar.
5. `onListening`/`markListening` hanya dipanggil sekali (di bind stub).

### 8.6 Verifikasi di CI (tanpa build dist lokal)

```sh
# Di CI (bukan VM ini): typecheck + lint + test bertarget, lalu full suite gateway.
pnpm typecheck                          # atau tsc scoped bila repo menyediakan
pnpm exec vitest run src/gateway/server/listen-stub.test.ts
pnpm exec vitest run src/gateway/server-startup-listen-stub.mobile-boot.test.ts
pnpm exec vitest run src/gateway/server-startup-finish.mobile-boot.test.ts
pnpm exec vitest run src/gateway/server-startup-plugins.mobile-boot.test.ts
pnpm exec vitest run src/gateway/server-startup-minimal-boot.test.ts
pnpm exec vitest run src/gateway/server-startup-post-attach.test.ts
pnpm exec vitest run src/gateway/server/readiness.test.ts   # bila ada; bila tidak, test readiness terkait
```

**Tidak ada build `dist/` lokal di VM ini** (butuh heap ≥4,4 GB; VM ~700 MB bebas). Boot terintegrasi (ON vs OFF, `measure-baseline.sh`) dijalankan di CI ber-heap besar (rencana §4 Fase 6) atau mesin lain — **bukan** di VM ini. Verifikasi perangkat (S1/S2/S3 + `startup-phases.log` + video + probe via 18790) dilakukan sesudah APK terbit, oleh Lead — lane ini tidak mengklaim angka perangkat.

---

## 9. Urutan implementasi langkah demi langkah

Tiap langkah kecil, bisa diverifikasi sendiri (test hijau + boot ON/OFF), dan di-commit terpisah bila Lead menghendaki. Urutan ini disusun agar tidak ada langkah yang meninggalkan repo dalam keadaan setengah-jadi yang tidak bisa boot.

| # | Langkah | Berkas yang disentuh | Verifikasi langkah |
|---|---|---|---|
| 1 | **Pemegang fase + stub dispatcher (tanpa wiring).** Buat `src/gateway/server/listen-stub.ts` (ListenPhase, stub dispatcher, placeholder HTML, checker stub) + unit test §8.1. Belum dipakai siapa pun. | Baru: `listen-stub.ts`, `listen-stub.test.ts` | Unit test hijau; uji graf impor §8.4 hijau. |
| 2 | **`handlerRef` di `server-http.ts`.** `createGatewayHttpServer` menerima `handlerRef?`; bila ada, pasang satu wrapper permanen. Bila tidak ada, perilaku lama. | `src/gateway/server-http.ts` (+ test) | Test HTTP yang ada hijau (OFF tidak berubah). |
| 3 | **Pecah `startListening`.** `bind()` (hanya bind + `onListening`) vs `startPostBindServices()` (portal/sandbox/plugin-listeners); `startListening` tetap sebagai pembungkus. | `src/gateway/server-runtime-state.ts` | Test transport + minimal-boot hijau. |
| 4 | **Bind stub di `server.ts` (ON saja).** Di `startGatewayServer`, bila `mobileBoot.enabled`: buat `handlerRef` + stub + `createGatewayHttpServer` + `listenGatewayHttpServer` + `mark("http.bound")` + tulis registrasi (bila diputuskan) + `acquireGatewayLock`. OFF: jalur lama utuh. | `src/gateway/server.ts` | Boot OFF hijau; boot ON: `/health` 200 dini (uji §8.2 langkah 1, dengan gate). |
| 5 | **Pindahkan kernel+transport ke pasca-bind.** `startGatewayServerCore` menerima `preboundListener + handlerRef`; `createGatewayHttpTransport` memakai server stub (bukan membuat baru); handler penuh dipasang ke `handlerRef.current` saat transport dibuat; `ListenPhase` → `ready` hanya di `mark("ready")`. | `src/gateway/server-start.ts`, `src/gateway/server-runtime-state.ts`, `src/gateway/server-startup-finish.ts` (mark) | Boot ON penuh hijau; `/` pasca-ready = Control UI penuh; tidak ada bind ganda (uji §8.2). |
| 6 | **Pindahkan WS attach pasca-bind.** `attachGatewayWsConnectionHandler` sesudah transport (sebelum post-attach). | `src/gateway/server-startup-finish.ts:150-194` | WS pasca-ready terhubung; WS pra-ready ditutup bersih (uji §8.2). |
| 7 | **Pindahkan validasi config pasca-bind (§6).** `run.ts`: pakai snapshot preflight untuk port/bind/auth-env; baca full + penegakan F3(a) + mode guard pindah ke bootstrap pasca-bind; invalid → log + exit 78. | `src/cli/gateway-cli/run.ts`, `src/gateway/server-startup-bootstrap.ts` (atau titik validasi pasca-bind) | Config valid → boot normal; config invalid (ON) → exit 78 + `/health` sempat 200 (uji §8.2). Config invalid (OFF) → tetap gagal pra-bind. |
| 8 | **Lepas G1; definisikan ulang `sidecarsReady` (§5.2–5.3).** Hapus `await deferredSessionMigration.ready` di `finish.ts:538-541`; keluarkan startup log / control-ui-assets / transcripts / prewarm dari jalur ready; `onSidecarsReady` lebih awal. | `src/gateway/server-startup-finish.ts`, `src/gateway/server-startup-post-attach.ts`, `src/gateway/server-lifecycle.ts` (bila definisi berubah) | `/ready` tetap 200 hanya bila `chat.send` tersedia (uji §8.2: migrasi digate → `/ready` 503; migrasi selesai → 200). |
| 9 | **Header `Retry-After: 1` pada 503 starting** (probe + shell + path lain). | `src/gateway/server-http-probes.ts`, `src/gateway/server/listen-stub.ts` | Uji header di §8.1. |
| 10 | **Trace + log (N14).** Mark baru (`http.listen.bind-stub`, `listen.stub-to-ready`, `config.validate-post-bind`); log transisi fase; log handover stub→penuh. | `src/gateway/server-startup-trace.ts` (bila perlu), stub + finish | `startup-phases.log` memisahkan A' vs `/ready` (cek manual di CI boot). |
| 11 | **Dokumen + test pendamping.** Perbarui `PLAN-OPENCODE-PARITY.md` §4 Fase 1 (status + koreksi §10), `DESIGN.md` §1.2/§8 bila masih menyebut F4 lama, `MEASUREMENT.md` (measure baru), `CHANGELOG.md` (perilaku pengguna berubah: shell dini + tile perantara — tetapi tile adalah Polones, catat dependensinya). | Dokumen fork | `pnpm docs:check-links` (bila relevan) + `git diff --check`. |
| 12 | **Koordinasi Polones (lane terpisah, bukan fork).** `wait_ready` dua tahap + tile Memulai → Hidup → Siap + polling `/ready` 100 ms + tile "Terganggu" + `probe_last_status` untuk `/ready` + verifikasi proxy 18790 meneruskan 503. | Repo Polones (bukan fork) | Ronde perangkat S1/S2/S3 + video (Lead). **Fase 1 fork tidak dianggap selesai sebelum ini terverifikasi di perangkat.** |

**Aturan berhenti selama implementasi:** bila langkah mana pun membuktikan salah satu N1–N14 HARUS berubah (mis. stub auth ternyata tidak bisa setara auth penuh; atau Opsi A ternyata tidak memberi perbaikan yang berarti sehingga godaan mengubah arti `/ready` muncul), **BERHENTI dan laporkan ke Lead** — jangan putuskan sendiri (aturan berhenti rencana §5).

---

## 10. KOREKSI atas rencana (klaim rencana yang ternyata salah / tidak lengkap sesudah membaca source)

| # | Klaim rencana | Koreksi sesudah membaca source | Dampak |
|---|---|---|---|
| K-1 | §12.2 M-1: "`server-startup-finish.ts` (sekitar `:198` `http.listen` / `:199` `http.bound`)" | **TERVERIFIKASI BENAR.** `:198` `await startupTrace.measure("http.listen", () => runtime.startListening())`, `:199` `startupTrace.mark("http.bound")`. Bukan koreksi — konfirmasi. | — |
| K-2 | §4 Fase 1 butir 1: "rute probe (`/health`, `/ready` …)" — seolah keduanya dilayani mekanisme yang sama | **PRESISI:** `/health` dijawab sebelum auth dan sebelum `waitForRequestRuntime` (`server-http-request.ts:223-236`); `/ready`/`/startup` dijawab lewat pemanggilan kedua sesudah ingress attribution (`:282-296`). Keduanya tanpa auth untuk status, auth hanya untuk detail (`server-http-probes.ts:60-127`). Stub harus mempertahankan asimetri ini. | Desain stub §3.3 |
| K-3 | §12.2 M-6: "Pindahkan baca + validasi config ke sesudah `http.bound`" — seolah satu tempat | **KOREKSI:** config dibaca/divalidasi di **tiga** tempat pra-listen (preflight, `run.ts:474` full read, bootstrap snapshot load) dan `run.ts` juga memakai `cfg` untuk port/bind/auth/mode-guard. Desain §6 memindahkan masing-masing secara terpisah; preflight core-only (murah) tetap pra-bind. Juga: "socket sudah terikat dan menjawab 503 sementara itu" — **presisi:** `/health` menjawab **200** (liveness), yang 503 adalah `/ready` + `/` + path lain. | Desain §6 |
| K-4 | §4 Fase 1: "JANGAN gerbangi `/ready` pada aktivasi plugin" — seolah satu `await` yang bisa dilepas | **KOREKSI:** `/ready` digerbangi **rantai 6 gerbang** (§5.1), dan gerbang yang menentukan adalah readiness checker (`isChatSendAvailable`, `readiness.ts:136-139`) — bukan satu await. Melepasnya secara harfiah membutuhkan perubahan arti `/ready`. Desain mengambil Opsi A (konservatif) + menandai varian penuh untuk pemilik. | Desain §5 |
| K-5 | §12.2 M-7: "`server-startup-finish.ts:538–541` (tunggu migrasi)" | **TERVERIFIKASI BENAR** (`:538-541` `await deferredSessionMigration.ready`). **TETAPI tidak lengkap:** ada gerbang migrasi kedua — wrapper `unlockStartupMethods` (`finish.ts:367-376`) — dan gerbang ketiga di readiness checker (`readiness.ts:136-139`). Ketiganya didokumentasikan di §5.1. | Desain §5 |
| K-6 | §4 Fase 1: "tulis registrasi gateway di `http.bound`" — seolah relokasi | **KOREKSI:** tidak ada mekanisme berkas registrasi apa pun di fork (tidak ada penulis `service.json`; hanya `gatewayStateOwner.markListening`, `server-start.ts:74`) dan tidak ada pembaca di Polones. Ini kode **baru sepenuhnya**, dan nilainya bergantung pada pembaca Polones yang belum ada → **opsional** (D-4, §4.3). | Desain §4 |
| K-7 | §1.2/§4: "Titik pisah graf ADA di `http.bound`" — seolah bisa dipakai begitu saja | **KOREKSI:** `http.bound` adalah trace mark, bukan seam kode. `finishGatewayStartup` menerima kernel+transport yang sudah jadi; transport penuh butuh config/auth/registry/readiness sehingga tidak bisa dipakai sebagai graf-listen. Seam harus **dibuat** di `startGatewayServer`/`startGatewayServerCore` + `handlerRef` (§3.1). | Desain §3 |
| K-8 | Tugas lane: "`server-startup-early.ts` mungkin sudah berisi mesin early-boot/minimal" | **KOREKSI:** `server-startup-early.ts` (193 baris) adalah **early runtime pasca-listen** (discovery, skills, cron, maintenance) — bukan early-boot. `server-startup-handler-prewarm.ts` juga **post-ready**, bukan pra-listen. Tidak ada yang bisa dipakai ulang untuk graf-listen dari keduanya kecuali pola lazy-import. | Desain §0.4 |
| K-9 | §12.2 M-2: "Socket menjawab probe sejak bind (stub 503/starting)" — seolah perilaku probe harus dibangun baru | **PRESISI:** `/health` **sudah** menjawab 200 tanpa melihat readiness (`server-http-probes.ts:128-131`); `/ready` **sudah** 503 selagi starting. Yang Fase 1 bangun baru hanyalah **kapan** listen terjadi + stub untuk `/` (placeholder) — bukan semantik probe. | Desain §2–§3 |
| K-10 | §11 rujukan berkas: `run.ts` resolve saklar `:377-378`, F3a `:490-499`; `server.ts:81`; `http-listen.ts:52` | **TERVERIFIKASI BENAR** (dengan toleransi ±2 baris): `run.ts:377` `const mobileBoot = resolveMobileBootOptions(process.env);`; `:490-499` blok penegakan F3(a) (throw di `:497`); `run.ts:888,902` `runGatewayLoop`/`startGatewayServer` (rencana menulis `:893,904` — bergeser beberapa baris, isi sama); `server.ts:81` resolve mobileBoot; `http-listen.ts` 80 baris, bind di `:52` (di dalam promise listen). | — |
| K-11 | §12.2 M-4 mengutip `server-startup-post-attach.ts:464-507` untuk deferred load F5 | **TERVERIFIKASI BENAR** (`:464-507` blok deferred F5, fire-and-forget + warn). | — |
| K-12 | §1.3/§4: angka "43,5 dtk" dan "9.384 baris gateway-prewarm" | **Tidak diverifikasi ulang di lane ini** (di luar cakupan rekognisi Fase 1; angka LAB ada di `MEASUREMENT.md`). Desain ini tidak mengutip keduanya sebagai dasar keputusan. | — |

## 11. Pertanyaan terbuka (untuk Lead / pemilik — tidak diputuskan lane ini)

1. **Opsi B (`/ready` didefinisikan ulang + sinyal chat-ready kedua)?** Lane merekomendasikan TIDAK (Opsi A). Bila pemilik menginginkan M-7 harfiah, butuh keputusan eksplisit + perubahan kontrak probe + tile (analog K-8).
2. **Berkas registrasi ditulis atau tidak?** Lane: tulis (murah), tetapi jangan blokir Fase 1 padanya. Lead boleh menghapusnya.
3. **Exit proaktif bila migrasi gagal pasca-pelepasan G1 (§5.2)?** Exit 1 proaktif vs menunggu timeout Polones 480 dtk — diputuskan saat implementasi, dengan syarat tidak diam-diam (N14).
4. **Interval polling `/ready` Polones (25 ms vs 100 ms)?** Usulan lane 100 ms; keputusan lane Polones (daemon single-threaded).
5. **Auth stub: perbandingan token lokal minimal vs `authorizeHttpGatewayConnect` penuh?** Tergantung hasil audit impor `auth.ts` (R-1) — diputuskan saat implementasi dengan gate uji graf impor.
6. **Transport-facts peek TLS (§2.3):** bila TLS tidak pernah on di perangkat Polones, peek dilewat. Buktikan dari config perangkat.
7. **Apakah `handleControlUiHttpRequest` bekerja sebelum `controlUiRootLifecycle.start()`?** Checklist §8.5 butir 1 — bila tidak, handover penuh menunggu sidecar itu.

## 12. Koreksi koordinator (verifikasi 26 Nov 2026, `main` `e701152a`)

Koordinator memverifikasi klaim bernomor baris di dokumen ini langsung dari source. Substansi desain BENAR; beberapa nomor baris meleset dan wajib dikoreksi sebelum implementasi.

- **G1 — lokasi sebenarnya `finish.ts:515-517`, BUKAN `:538-541`.** Bloknya:
  `if (deferredSessionMigration && !lifecycle.closePreludeStarted) { await deferredSessionMigration.ready; }`
  dengan komentar F1 di `:510-514` ("`/ready` must still imply 'sessions admitted'"). Yang ada di `:538-541` adalah late-join early runtime, bukan await migrasi. Rencana (§12.2 M-7) mengutip `:538-541` — kutipan itu SUDAH salah di rencana, dan desain ini mewarisinya.
- **`getReadiness.prepare()` di `:524`, `publish().ready` di `:525`** (bukan `:544-551` seperti dikutip §1.3/§5).
- **`waitForDeferredSessionMigration` di `:146-148`; dipakai di `:374`** di dalam wrapper `unlockStartupMethods` (G2, `:367-375` — kutipan ini BENAR). Jadi helper `:147` yang disebut di §5.1 bukan gerbang keempat yang terpisah — ia adalah isi dari G2.
- **`databasePreparationReady` (`:129`)** di-resolve saat worker runtime + migrasi selesai (`:140-144`), diteruskan sebagai `preparationReady` di `:253`, dan di-resolve paksa untuk `minimalTestGateway` di `:508`. **Lane implementasi WAJIB menelusuri konsumen `preparationReady` sebelum melepas G1** — bila konsumennya juga menggerbangi `/ready` (atau dispatch), pelepasan G1 saja tidak cukup dan desain §5.2 harus direvisi.
- **`readiness.ts:143`** (`isChatSendAvailable?.() === false`) — kutipan desain `:136-139` meleset beberapa baris; substansi benar.
- **Polones:** `spec_table.rs` komentar `health_url`/`ready_within_ms` di `:417-418` (dalam rentang `:403-430` yang dikutip — BENAR); `health.rs` `status_is_healthy` `:61`, `probe_http` `:97`, `probe_http_status` `:111` (kutipan desain `:106-111`/`:124-135` meleset beberapa baris; substansi benar).
- **Instruksi untuk lane implementasi:** verifikasi ulang SETIAP nomor baris di dokumen ini terhadap berkas aktual sebelum mengedit. Nomor baris di §5/§8/§9 yang berada di rentang 500–560 meleset ~20 baris; jangan edit berdasarkan nomor itu tanpa membaca konteks sekitarnya.

## 13. Catatan implementasi (Lane F1-I, 26 Nov 2026)

Langkah §9 dikerjakan 1–11 berurutan. Semua nomor baris di bawah merujuk `main` fork sesudah implementasi (HEAD implementasi; lihat commit di §13.8).

### 13.1 Hasil telusur `preparationReady` (prasyarat pelepasan G1)

Satu-satunya konsumen adalah `server-agent-database-startup.ts:76` (diteruskan ke admission) dan admission meng-await-nya di `src/state/agent-database-startup.ts:499`. Ia menggerbangi admisi database per-agen, BUKAN `/ready` secara langsung; ia tetap resolve via `onSettled` saat migrasi settle (hasil apa pun). Melepas G1 aman terhadapnya; **tidak perlu revisi §5.2**.

### 13.2 Vonis R-1 (audit impor `auth.ts`)

`auth.ts` mengimpor `ingress-attribution.js`, `net.js`, `origin-check.js`, `known-weak-gateway-secrets.js` — cukup berat untuk graf-listen. **Keputusan:** stub TIDAK mengimpor `auth.ts` atau `server-http-probes.ts`; stub memakai perbandingan timing-safe minimal (`safeEqualSecret`, `src/security/secret-equal.ts`) terhadap token env yang sama (`OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`, sumber yang sama dengan yang dibaca `auth-surface-resolution.ts`). `server-http-request.ts` juga berat (mengimpor `config/io.js`, `infra/tailscale.js`, `plugins/http-legacy-listener.js`, modul Control UI) — maka `server-http.ts` TIDAK boleh diimpor pre-bind; stub dibangun mandiri dengan `node:http` di `listen-stub.ts`. Graf impor stub dipin oleh test (`listen-stub.test.ts`, allowlist impor runtime statis).

### 13.3 Vonis TLS (§2.3)

Grep di `~/workspace/polones` tidak menemukan pemakaian `gateway.tls`; bootstrap fork tidak punya `tls.enabled=true`. **TLS tidak pernah on di Polones → TLS peek dilewati dengan komentar.** Pengaman: `server.ts` melewati stub bila snapshot config mengaktifkan TLS (log warn, jalur lama); transport melempar error jelas bila `gatewayTls.enabled` + prebound.

### 13.4 Mekanisme exit proaktif bila migrasi gagal (keputusan koordinator butir 5)

TIDAK memakai `process.exit(1)` mentah — tidak ada preseden di `src/gateway` dan akan melewati cleanup lock/lease. Sebagai gantinya, lewat jalur exit yang sudah terverifikasi: (a) di titik G1, throw segera bila migrasi SUDAH gagal (fail fast); (b) `deferredSessionMigration.ready` digabungkan ke `startupSettled` yang dikembalikan finish (hanya return final) via `Promise.all` — run loop meng-await `startupSettled` dengan reject (`run-loop.ts` ~1215), dan `startupFailureEndsLoop` (`run-loop.ts:1133`) bernilai true pada start pertama (bukan restart iteration) sehingga loop melempar dan CLI luar exit nonzero via `resolveGatewayStartupFailureExitCode`. Rejection handler dipasang saat migrasi dimulai (log error + `pendingReason = "session-migration-failed"` + trace mark `sessions.migration-failed`). Ini memenuhi maksud keputusan 5.

### 13.5 Penyimpangan dari desain (dengan alasan)

| # | Desain | Implementasi | Alasan |
|---|---|---|---|
| P-1 | §3.3: shell = Control UI penuh dengan input dinonaktifkan | Placeholder tanpa composer/input sama sekali (D-6) | Keputusan koordinator butir 3 (C-UI-1 terpenuhi oleh placeholder); Control UI penuh baru sesudah ready via reload. |
| P-2 | Langkah 7: baca config penuh pindah pasca-bind | Baca config penuh TETAP pre-bind di `run.ts`; yang PINDAH hanya PENEGAKAN F3(a) ke bootstrap pasca-bind | Snapshot preflight tidak di-plumb ke `runGatewayCommandOnce` (`run-command.ts` membuangnya di dalam `ensureCliExecutionBootstrap`); `cfg` dibutuhkan pre-bind untuk port/bind/auth/mode/shell-env/proxy; biaya baca tidak terukur. |
| P-3 | §3.4: lock sesudah bind | Urutan relatif sqlite→lock dipertahankan; keduanya pindah sesudah bind | Tidak ada bukti lock tidak butuh sqlite init; urutan lama yang terbukti dipertahankan. Jalur CLI tetap lock-dulu-bind-kemudian (run loop memegang lock sebelum `startGatewayServer`) — "lock sesudah bind" hanya berlaku untuk pemanggil langsung `server.ts`. |
| P-4 | §3.6: `startListening` dipecah | Dipecah menjadi `bindGatewayListeners()` + `startPostBindServices()`; `startListening` tetap sebagai pembungkus | Kompatibilitas pemanggil lama (OFF + test). |
| P-5 | §2.2: `mark("http.bound")` di finish | ON: `startupTrace.detail("http.bound", [boundAtMs, startedAtMs])` dengan waktu bind sejati; OFF: `mark` seperti biasa | `mark()` memakai `performance.now()` tanpa parameter backdate — mark di finish akan salah waktu di mode ON. Waktu bind sejati juga tercatat sebagai bootstrap step `gateway.listen-stub.bind` (di-replay di `mark("process.bootstrap")`). |
| P-6 | Langkah 8: post-attach — lewati await `startupLog` | Hanya await non-canary (~`:433`) yang dilewati bila ON; await canary (~`:327`) tetap | Canary harus menyelesaikan log sebelum registry dipublikasikan (diagnostik plugin dipertahankan). |
| P-7 | §5.2 butir c: exit 1 proaktif | Via `startupSettled` (lihat §13.4), bukan `process.exit` | Lihat §13.4. |

### 13.6 Keterbatasan yang diketahui (dicatat, bukan diam-diam)

- **"Terganggu" (tile saat `/ready` flap) DIKELUARKAN dari cakupan Fase 1** — monitor Polones tidak mem-probe `/ready` ulang sesudah RUNNING; flap channel tidak memengaruhi chat (keputusan koordinator butir 4).
- **Registrasi basi saat crash:** berkas `gateway-registration.json` hanya dihapus saat close bersih; crash meninggalkan berkas basi. Pembaca WAJIB memvalidasi via `pid` + `bootId`.
- **Jendela 503 singkat untuk config invalid:** dengan ON, socket menjawab 503 starting sejenak sebelum proses exit 78 (penegakan pasca-bind). Ini disengaja (N5: exit 78 dipertahankan) — Polones harus memperlakukan 503-dini + exit-78 sebagai "config invalid", bukan sebagai "gateway hidup".
- **Fallback "sembunyikan Buka selama Hidup" TIDAK dipicu** (placeholder memenuhi C-UI-1; keputusan koordinator butir 3).

### 13.7 Test

- Baru: `src/gateway/server/listen-stub.test.ts` (probe per fase, gate auth shell N1, swap `handlerRef`, siklus berkas registrasi, gate graf impor R-1) + smoke test `/tmp/listen-stub-smoke.mts` ("SMOKE OK", via `tsx`, 17 dtk).
- Baru: `src/gateway/server-startup-listen-stub.mobile-boot.test.ts` (pola F4(b): `it.each([true,false])`, boot via `startGatewayServer`, gate `prepareGatewayServerBootstrap` via `vi.spyOn`; ON: `/health` 200 + `/ready` 503 + `Retry-After: 1` + `/` placeholder selagi gate tertutup, lalu `/ready` 200 + registrasi `ready` sesudah gate dibuka; OFF: port tidak menjawab selagi gate tertutup).
- **Belum terverifikasi:** vitest file baru + file test yang diubah + typecheck — semuanya menunggu CI (vitest startup >280 dtk di VM ini, terlalu lambat, bukan OOM; `tsc` terarah timeout di batas tool 180 dtk). Boot terintegrasi ON vs OFF dan vonis perangkat menunggu APK + Lead.

### 13.8 Commit

Lihat `git log` `main` fork sesudah `e701152a` (Lane F1-I, 26 Nov 2026): satu commit per langkah §9 (Conventional Commits), lokal saja, belum push.

---

*Dokumen desain — Lane F1-R, 26 Nov 2026. Tidak ada kode yang diubah untuk dokumen ini (hanya berkas ini yang ditulis, untracked, jangan commit sebelum Lead meninjau). Implementasi mengikuti §9, sesudah persetujuan rencana + perintah pemilik untuk Fase 1.*
