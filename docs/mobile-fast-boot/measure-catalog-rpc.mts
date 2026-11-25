#!/usr/bin/env node
/**
 * Ukur latensi RPC `tools.catalog` terhadap Gateway yang sedang jalan (LAB).
 *
 * Cara pakai (dari root worktree, sesudah `pnpm install`, gateway sudah jalan):
 *   node --import ./scripts/tsx.mjs docs/mobile-fast-boot/measure-catalog-rpc.mts [port] [label]
 *
 * Melakukan 3 pengukuran terhadap satu gateway:
 *   1. `tools.catalog` pertama (cold): durasi + apakah `pluginCatalogPending`
 *      + jumlah grup. A1 ON + cache dingin -> pending + core-only (ms) dan
 *      rebuild berjalan di latar. A1 OFF -> respons lengkap inline (puluhan
 *      detik pada katalog plugin penuh).
 *   2. Polling tiap 2 dtk sampai respons berisi grup plugin
 *      (time-to-complete-catalog). A1 ON: waktu rebuild latar. A1 OFF: 0
 *      (sudah lengkap di panggilan 1).
 *   3. `tools.catalog` kedua (warm): A1 ON + snapshot tertulis -> hit, ms.
 *      A1 OFF -> inline lagi (sama lambatnya dengan panggilan 1).
 *
 * Auth: gateway LAB mode lokal tanpa `gateway.auth` yang dikonfigurasi —
 * klien memakai alur device-auth yang sama seperti Control UI (tanpa token
 * awal). Bila gateway menuntut token, setel `OPENCLAW_GATEWAY_TOKEN`.
 * `requestTimeoutMs` 300 dtk: panggilan OFF yang dingin bisa melebihi
 * default 30 dtk — timeout di sini berarti gagal ukur, bukan hasil.
 *
 * Keluar: TSV `label  cold_ms  cold_pending  cold_groups  complete_ms
 * warm_ms  warm_groups` ke stdout + baris yang sama ke
 * `/tmp/lane-e-lab/<label>-catalog.tsv` (bila bisa ditulis).
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { GatewayClient } from "../../packages/gateway-client/src/client.ts";

const port = Number(process.argv[2] ?? "18789");
const label = process.argv[3] ?? "catalog";
const token = process.env.OPENCLAW_GATEWAY_TOKEN;
const url = `ws://127.0.0.1:${port}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function countGroups(result: unknown): number {
  if (!result || typeof result !== "object") {
    return -1;
  }
  const groups = (result as { groups?: unknown }).groups;
  return Array.isArray(groups) ? groups.length : -1;
}

function hasPluginGroups(result: unknown): boolean {
  if (!result || typeof result !== "object") {
    return false;
  }
  const groups = (result as { groups?: Array<{ source?: string }> }).groups;
  return Array.isArray(groups) && groups.some((group) => group.source === "plugin");
}

async function main(): Promise<void> {
  let helloResolve: () => void = () => {};
  let helloReject: (error: Error) => void = () => {};
  const hello = new Promise<void>((resolve, reject) => {
    helloResolve = resolve;
    helloReject = reject;
  });
  const helloTimer = setTimeout(
    () => helloReject(new Error("timeout menunggu hello-ok (30 dtk)")),
    30_000,
  );
  const client = new GatewayClient({
    url,
    ...(token ? { token } : {}),
    instanceId: randomUUID(),
    clientName: "cli",
    clientVersion: "lane-e-measure",
    role: "operator",
    mode: "cli",
    requestTimeoutMs: 300_000,
    onHelloOk: () => {
      clearTimeout(helloTimer);
      helloResolve();
    },
    onConnectError: (error) => {
      clearTimeout(helloTimer);
      helloReject(error);
    },
  });

  client.start();
  await hello;
  const connectMs = 0; // hello-ok tercapai; durasi connect tidak dipisah di sini.
  void connectMs;

  const coldStartedAt = Date.now();
  const first = await client.request("tools.catalog", { agentId: "main", includePlugins: true });
  const coldMs = Date.now() - coldStartedAt;
  const coldPending = (first as { pluginCatalogPending?: boolean }).pluginCatalogPending === true;
  const coldGroups = countGroups(first);
  console.log(`cold_ms=${coldMs} pending=${coldPending} groups=${coldGroups}`);

  let completeMs = 0;
  if (coldPending) {
    const pollStartedAt = Date.now();
    let done = false;
    for (let attempt = 0; attempt < 30 && !done; attempt++) {
      await sleep(2000);
      const res = await client.request("tools.catalog", { agentId: "main", includePlugins: true });
      if (hasPluginGroups(res)) {
        done = true;
        completeMs = Date.now() - pollStartedAt;
        console.log(
          `complete_ms=${completeMs} (poll attempt ${attempt + 1}, groups=${countGroups(res)})`,
        );
      }
    }
    if (!done) {
      console.log("complete_ms=TIMEOUT (grup plugin tidak muncul dalam 60 dtk polling)");
      completeMs = -1;
    }
  } else {
    console.log("complete_ms=0 (lengkap di panggilan pertama)");
  }

  const warmStartedAt = Date.now();
  const warm = await client.request("tools.catalog", { agentId: "main", includePlugins: true });
  const warmMs = Date.now() - warmStartedAt;
  const warmGroups = countGroups(warm);
  console.log(`warm_ms=${warmMs} groups=${warmGroups}`);

  const line = `${label}\t${coldMs}\t${coldPending}\t${coldGroups}\t${completeMs}\t${warmMs}\t${warmGroups}\n`;
  try {
    mkdirSync("/tmp/lane-e-lab", { recursive: true });
    appendFileSync(`/tmp/lane-e-lab/${label}-catalog.tsv`, line);
  } catch {
    // Best-effort saja; angka sudah di stdout.
  }
  console.log(`tsv: ${line.trim()}`);
  client.stop();
  process.exit(0);
}

main().catch((error) => {
  console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
