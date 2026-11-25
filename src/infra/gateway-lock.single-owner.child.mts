// Two-process N2 guard probe (fork: Lane C, F2) — NOT a test file itself.
//
// Run by `gateway-lock.single-owner.test.ts` via
// `node --import ./scripts/tsx.mjs` with:
//   --state-dir <dir> --lock-dir <dir> --port <port>
//
// It acquires the gateway lock with the single-owner fast-path ON (fresh
// state dir, so every file/sqlite layer passes), then tries to bind the
// given port. Exit codes:
//   2 — `GatewayLockError` (the exclusive TCP bind refused a second
//         Gateway; this is the expected outcome when the port is held)
//   0 — never (the process holds the lock + port until killed)
//   3 — any other failure (usage error, unexpected exception)
//
// Guardrail N2: the exclusive bind on 18789 (or any gateway port) is the
// last guard that makes the F2 fast-path safe at all — the file-lock
// projection and lease assertion are skipped in single-owner mode, so the
// bind MUST still refuse a second Gateway. This probe is the executable
// form of that guard.
import http from "node:http";
import { listenGatewayHttpServer } from "../gateway/server/http-listen.js";
import { acquireGatewayLock, GatewayLockError } from "./gateway-lock.js";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (key !== undefined && value !== undefined) {
    args.set(key, value);
  }
}
const stateDir = args.get("--state-dir");
const lockDir = args.get("--lock-dir");
const port = Number(args.get("--port"));
if (!stateDir || !lockDir || !Number.isInteger(port) || port <= 0 || port > 65_535) {
  console.error(
    "usage: gateway-lock.single-owner.child.mts --state-dir <dir> --lock-dir <dir> --port <port>",
  );
  process.exit(3);
}

const env: NodeJS.ProcessEnv = {
  ...process.env,
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: `${stateDir}/openclaw.json`,
  // The parent is a vitest worker; never let its test env leak into the probe.
  VITEST: "",
  NODE_ENV: "",
};

try {
  const lock = await acquireGatewayLock({
    env,
    allowInTests: true,
    lockDir,
    port,
    mobileBoot: { enabled: true, singleOwner: true },
  });
  if (lock === null) {
    console.error("ERROR: lock acquisition refused (test env?)");
    process.exit(3);
  }
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  // No EADDRINUSE retries: the probe wants the bind verdict immediately.
  await listenGatewayHttpServer({
    httpServer: server,
    bindHost: "127.0.0.1",
    port,
    retryEaddrinuse: false,
  });
  console.log("LISTENING");
  // Hold the lock + port until the parent kills us.
  await new Promise(() => {});
} catch (error) {
  if (error instanceof GatewayLockError) {
    console.error(`GATEWAY_LOCK_ERROR: ${error.message}`);
    process.exit(2);
  }
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(3);
}
