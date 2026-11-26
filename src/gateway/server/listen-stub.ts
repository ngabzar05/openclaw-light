// Fase 1 (fork: Lane F1-I, mobile boot ON only) — the early-listen stub.
//
// The stub dispatcher answers on the gateway socket from the moment it is
// bound, while the heavy startup graph (sqlite, kernel, bootstrap, plugin
// runtime, transport) still runs. It serves only three honest answers:
// liveness (`/health`), not-ready (`/ready`, `/startup`) and a starting
// placeholder shell (`/`). Everything else is 503 `service_starting`.
//
// This module is deliberately dependency-free at load time: only
// `node:http`, `node:crypto`, the probe route contracts, a header helper
// and the timing-safe secret comparison. It must NEVER import the gateway
// HTTP stack (`server-http-request.js` pulls `config/io.js`, tailscale,
// the plugin legacy listener and the Control UI modules), the auth module
// (`auth.ts` pulls ingress attribution + origin checks) or any
// `server-startup-*` module — see the import-graph gate in
// `listen-stub.test.ts` (R-1). The stub auth is therefore a minimal
// timing-safe comparison against the SAME env secrets the full auth
// resolution reads (`OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`,
// see `auth-surface-resolution.ts`); there is no second token source.
//
// The stub owns one permanent request dispatcher: `handlerRef.current`.
// `server.ts` binds the stub server pre-kernel; the transport swaps
// `handlerRef.current` to the full handler exactly once, at `mark("ready")`
// in `finishGatewayStartup` — never before, so no request can reach
// `chat.send` while the stub is live (N9/N11).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { safeEqualSecret } from "../../security/secret-equal.js";
import { getBearerToken } from "../http-header-value.js";
import { classifyGatewayProbePath } from "../gateway-http-route-contracts.js";
import type {
  GatewayHttpHandlerRef,
  GatewayHttpRequestHandler,
} from "../server-http.types.js";

export type { GatewayHttpHandlerRef } from "../server-http.types.js";

/**
 * Mutable phase shared by the stub dispatcher and the rest of startup.
 * `pendingReason` is coarse during the stub phase (`"bootstrap"`); the
 * full readiness checker takes over the detailed reason once the handler
 * is swapped at ready.
 */
export type ListenPhase = {
  status: "listening" | "ready";
  /** Coarse stub-phase reason; `"ready"` once handed over. */
  pendingReason: string;
  bootId: string;
  startedAtMs: number;
  /** Wall clock (ms) when the stub socket was bound. */
  boundAtMs: number;
  /** `performance.now()` at bind; the trace baseline for A'. */
  boundAtPerformanceMs: number;
  port: number;
  bindHost: string;
};

/** Everything `startGatewayServer` threads to the kernel/transport. */
export type ListenStubBundle = {
  server: Server;
  handlerRef: GatewayHttpHandlerRef;
  phase: ListenPhase;
};

/** Env secrets the stub accepts. Both are read from the same env vars the full auth uses. */
export type ListenStubSecrets = {
  token?: string;
  password?: string;
};

/** Read the stub secrets from the environment (same source as full auth). */
export function resolveListenStubSecrets(env: NodeJS.ProcessEnv = process.env): ListenStubSecrets {
  const token = env.OPENCLAW_GATEWAY_TOKEN?.trim() || undefined;
  const password = env.OPENCLAW_GATEWAY_PASSWORD?.trim() || undefined;
  return { ...(token ? { token } : {}), ...(password ? { password } : {}) };
}

export function createListenPhase(params: {
  port: number;
  bindHost: string;
  bootId?: string;
  startedAtMs?: number;
}): ListenPhase {
  const startedAtMs = params.startedAtMs ?? Date.now();
  return {
    status: "listening",
    pendingReason: "bootstrap",
    bootId: params.bootId ?? randomUUID(),
    startedAtMs,
    boundAtMs: 0,
    boundAtPerformanceMs: 0,
    port: params.port,
    bindHost: params.bindHost,
  };
}

function isLoopbackSocket(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function readQueryToken(req: IncomingMessage): string | undefined {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    return url.searchParams.get("token") ?? undefined;
  } catch {
    return undefined;
  }
}

function readCookieToken(req: IncomingMessage): string | undefined {
  const cookie = req.headers.cookie;
  if (!cookie) {
    return undefined;
  }
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "token") {
      return rest.join("=").trim() || undefined;
    }
  }
  return undefined;
}

/** Timing-safe check of one presented secret against the configured env secrets. */
export function matchesListenStubSecret(
  presented: string | undefined,
  secrets: ListenStubSecrets,
): boolean {
  if (!presented) {
    return false;
  }
  return safeEqualSecret(presented, secrets.token) || safeEqualSecret(presented, secrets.password);
}

function presentedStubSecret(req: IncomingMessage): string | undefined {
  return getBearerToken(req) ?? readQueryToken(req) ?? readCookieToken(req);
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
  retryAfterSeconds?: number,
): void {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (retryAfterSeconds !== undefined) {
    res.setHeader("Retry-After", String(retryAfterSeconds));
  }
  res.setHeader("Content-Length", String(Buffer.byteLength(payload)));
  res.end(payload);
}

function sendPlaceholderHtml(res: ServerResponse, phase: ListenPhase): void {
  // Minimal starting shell (D-6): honest status, no composer, no send
  // input. Polls /ready every 500 ms and reloads into the full Control UI
  // once ready; the ?token= query survives the reload so full auth sees it.
  const html =
    "<!doctype html>\n" +
    '<html lang="en">\n' +
    "<head>\n" +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    "<title>OpenClaw — Starting…</title>\n" +
    "<style>body{font-family:system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#0f1115;color:#e6e6e6}main{text-align:center;padding:24px}h1{font-size:20px;margin:0 0 8px}p{color:#9aa0a6;margin:4px 0}</style>\n" +
    "</head>\n" +
    "<body>\n" +
    "<main>\n" +
    "<h1>Starting gateway…</h1>\n" +
    `<p id="phase">Phase: ${escapeHtml(phase.pendingReason)}</p>\n` +
    "<p>The gateway is starting. Chat will be available once it is ready.</p>\n" +
    "</main>\n" +
    "<script>\n" +
    "(function () {\n" +
    "  var params = new URLSearchParams(location.search);\n" +
    "  var token = params.get('token') || '';\n" +
    "  function withToken(path) { return token ? path + '?token=' + encodeURIComponent(token) : path; }\n" +
    "  async function poll() {\n" +
    "    try {\n" +
    "      var startup = await fetch(withToken('/startup'));\n" +
    "      if (startup.ok) {\n" +
    "        var ready = await fetch(withToken('/ready'));\n" +
    "        if (ready.ok) { location.reload(); return; }\n" +
    "      } else {\n" +
    "        try {\n" +
    "          var body = await startup.json();\n" +
    "          if (body && body.pendingReason) {\n" +
    "            document.getElementById('phase').textContent = 'Phase: ' + body.pendingReason;\n" +
    "          }\n" +
    "        } catch (e) { /* keep the last phase text */ }\n" +
    "      }\n" +
    "    } catch (e) { /* gateway still starting; retry */ }\n" +
    "    setTimeout(poll, 500);\n" +
    "  }\n" +
    "  poll();\n" +
    "})();\n" +
    "</script>\n" +
    "</body>\n" +
    "</html>\n";
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Length", String(Buffer.byteLength(html)));
  res.end(html);
}

function escapeHtml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

/**
 * The stub dispatcher. Probe semantics mirror `handleGatewayProbeRequest`
 * (one owner for probe semantics — the stub only re-implements the
 * starting-state answers, it does not invent new ones):
 * - `/health` → 200 live, no auth (as today).
 * - `/ready` → 503 `{ready:false}`, details only for loopback or a valid
 *   bearer (as today: status without auth, details only local/auth).
 * - `/startup` → 503 `{ok:false,status:"starting",pendingReason}`.
 * - `/` → placeholder shell only with a valid env secret (N1, fail-closed:
 *   no secret configured → 503 starting, never the shell, never 401).
 * - everything else → 503 `service_starting`.
 * Every 503 carries `Retry-After: 1`.
 */
export function createListenStubHandler(
  phase: ListenPhase,
  secrets: ListenStubSecrets,
): GatewayHttpRequestHandler {
  const hasSecret = Boolean(secrets.token ?? secrets.password);
  const handler = (async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Bad Request");
      return;
    }
    const method = (req.method ?? "GET").toUpperCase();
    const isHead = method === "HEAD";
    const kind = classifyGatewayProbePath(pathname);
    const uptimeMs = Date.now() - phase.startedAtMs;
    // Details belong only to loopback callers or authenticated callers
    // (same rule as the full probe handler).
    const includeDetails =
      isLoopbackSocket(req) || matchesListenStubSecret(getBearerToken(req), secrets);

    if (kind === "live" || kind === "ready" || kind === "startup") {
      if (method !== "GET" && method !== "HEAD") {
        res.statusCode = 405;
        res.setHeader("Allow", "GET, HEAD");
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Method Not Allowed");
        return;
      }
      if (kind === "live") {
        const body = JSON.stringify({ ok: true, status: "live" });
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Length", String(Buffer.byteLength(body)));
        res.end(isHead ? undefined : body);
        return;
      }
      if (kind === "ready") {
        const body = JSON.stringify(
          includeDetails
            ? { ready: false, coreReady: false, failing: ["starting"], uptimeMs }
            : { ready: false },
        );
        res.statusCode = 503;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Retry-After", "1");
        res.setHeader("Content-Length", String(Buffer.byteLength(body)));
        res.end(isHead ? undefined : body);
        return;
      }
      const body = JSON.stringify(
        includeDetails
          ? { ok: false, status: "starting", uptimeMs, pendingReason: phase.pendingReason }
          : { ok: false, status: "starting" },
      );
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Retry-After", "1");
      res.setHeader("Content-Length", String(Buffer.byteLength(body)));
      res.end(isHead ? undefined : body);
      return;
    }

    if (pathname === "/" || pathname === "/starting" || pathname.startsWith("/starting/")) {
      // Shell gate (N1, fail-closed): without a configured env secret the
      // stub cannot tell auth mode `none` from a token that has not been
      // read yet, so it serves 503 starting — never the shell, never 401.
      // With a secret configured, only a matching bearer / ?token= /
      // token cookie sees the placeholder; anything else is 401.
      if (!hasSecret) {
        sendJson(res, 503, { code: "service_starting" }, 1);
        return;
      }
      if (!matchesListenStubSecret(presentedStubSecret(req), secrets)) {
        sendJson(res, 401, { code: "unauthorized" });
        return;
      }
      if (isHead) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end();
        return;
      }
      sendPlaceholderHtml(res, phase);
      return;
    }

    sendJson(res, 503, { code: "service_starting" }, 1);
  }) as GatewayHttpRequestHandler;
  handler.dispose = () => {};
  return handler;
}

/**
 * Create the stub HTTP server. The server is bare `node:http`: one
 * permanent dispatcher reading `handlerRef.current`, so the transport can
 * swap in the full handler with a single assignment. WebSocket upgrades
 * and CONNECT are destroyed while the stub is live (there is no `wss`
 * yet); the transport detaches the upgrade listener before installing
 * the real one.
 */
export function createListenStubServer(
  phase: ListenPhase,
  secrets: ListenStubSecrets,
): ListenStubBundle {
  const handler = createListenStubHandler(phase, secrets);
  const handlerRef: GatewayHttpHandlerRef = { current: handler };
  const server = createServer((req, res) => {
    void handlerRef.current(req, res);
  });
  server.on("checkContinue", (req, res) => {
    void handlerRef.current(req, res, "continue");
  });
  server.on("checkExpectation", (req, res) => {
    void handlerRef.current(req, res, "reject");
  });
  server.on("upgrade", (_req, socket) => {
    socket.destroy();
  });
  server.on("connect", (_req, socket) => {
    socket.destroy();
  });
  server.once("close", () => {
    handlerRef.current.dispose();
  });
  return { server, handlerRef, phase };
}

/** Remove the stub's upgrade listener so the transport can install the real one. */
export function detachListenStubUpgradeHandler(server: Server): void {
  server.removeAllListeners("upgrade");
}

/** Mark the phase bound (called right after `listenGatewayHttpServer` resolves). */
export function markListenPhaseBound(phase: ListenPhase): void {
  phase.boundAtMs = Date.now();
  phase.boundAtPerformanceMs = performance.now();
}
