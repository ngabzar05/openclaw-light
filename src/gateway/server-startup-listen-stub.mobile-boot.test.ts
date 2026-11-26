// Fase 1 (fork: Lane F1-I) — early-listen stub (mobile boot profile).
//
// Invariants pinned here:
// 1. ON (`mobileBoot.enabled`): the socket binds BEFORE the kernel, so
//    while the bootstrap is still gated, `/health` answers 200,
//    `/ready` answers 503 with `Retry-After: 1`, and `/` serves the
//    placeholder shell (no composer) to an authenticated caller —
//    before any kernel work has run. After the gate opens, the gateway
//    reaches ready through the FULL handler on the SAME socket
//    (single bind: a second bind on the port would throw EADDRINUSE
//    and fail the boot), and the registration file flips to `ready`.
//    Red without the fix: OFF behavior — nothing listens while the
//    bootstrap is gated, so `/health` does not answer at all.
// 2. OFF (upstream): no early bind — while the bootstrap is gated,
//    the port does not answer (connection refused); after the gate
//    opens the gateway boots and `/ready` goes 200 through the
//    normal path. Guards the Fase 1 gate: OFF must stay pure upstream.
//
// The bootstrap is held behind a test gate by mocking
// `prepareGatewayServerBootstrap` (same `vi.spyOn` technique as the
// F4(b) early-runtime test). Both cases boot a real gateway through
// `startGatewayServer` (not `startGatewayServerCore` — the stub is
// created in `startGatewayServer`) with the startup fixture.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { getFreePort } from "../test-utils/ports.js";
import type { GatewayServer } from "./server-public.js";
import * as fixture from "./server-startup-state.test-support.js";

async function probe(
  port: number,
  path: string,
  headers?: Record<string, string>,
): Promise<{ status: number; retryAfter: string | null; body: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    return {
      status: res.status,
      retryAfter: res.headers.get("retry-after"),
      body: await res.text(),
    };
  } catch {
    return { status: 0, retryAfter: null, body: "" };
  }
}

async function waitForStatus(
  port: number,
  path: string,
  status: number,
  label: string,
  timeoutMs = 60_000,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if ((await probe(port, path)).status === status) {
      return;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${label} (GET ${path} -> ${status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

it.each([true, false])(
  "mobileBoot.enabled=%s: early-listen stub binds before the kernel",
  async (mobileBootEnabled) => {
    const port = await getFreePort();
    const token = "gateway-f1-listen-stub-token";
    const state = await fixture.createGatewayStartupTestState(
      `gateway-f1-listen-stub-${mobileBootEnabled ? "on" : "off"}`,
      { OPENCLAW_GATEWAY_TOKEN: token, OPENCLAW_TEST_MINIMAL_GATEWAY: "1" },
    );
    // Mirror server-startup-finish.mobile-boot.test.ts: the flag shapes
    // fixture creation, then is removed so the booted gateway runs
    // non-minimal (post-attach + post-ready maintenance execute).
    state.envVars.OPENCLAW_TEST_MINIMAL_GATEWAY = undefined;
    const bootstrapGate = createDeferred();
    const bootstrapModule = await import("./server-startup-bootstrap.js");
    const prepareBootstrap = bootstrapModule.prepareGatewayServerBootstrap;
    vi.spyOn(bootstrapModule, "prepareGatewayServerBootstrap").mockImplementation(async (...args) => {
      await bootstrapGate.promise;
      return prepareBootstrap(...args);
    });
    let server: GatewayServer | undefined;
    try {
      await state.writeConfig({
        gateway: fixture.gatewayStartupTestConfig(port, token),
        plugins: { enabled: false },
        discovery: { mdns: { mode: "off" } },
      });
      state.applyEnv();
      const { startGatewayServer } = await import("./server.js");
      // Do not await: in ON mode the boot blocks at the gated bootstrap
      // while the stub already answers; in OFF mode it blocks before
      // any socket exists.
      const serverPromise = startGatewayServer(port, {
        ...fixture.gatewayStartupTestOptions(token),
        mobileBoot: { enabled: mobileBootEnabled },
      });
      if (mobileBootEnabled) {
        // The stub is live while the kernel is still gated.
        await waitForStatus(port, "/health", 200, "stub health 200 while bootstrap gated");
        const ready = await probe(port, "/ready");
        expect(ready.status).toBe(503);
        expect(ready.retryAfter).toBe("1");
        expect(ready.body).toContain("starting");
        const startup = await probe(port, "/startup");
        expect(startup.status).toBe(503);
        expect(startup.retryAfter).toBe("1");
        // The placeholder shell answers to an authenticated caller and
        // carries no composer/input (C-UI-1 placeholder, D-6).
        const shell = await probe(port, "/", { Authorization: `Bearer ${token}` });
        expect(shell.status).toBe(200);
        expect(shell.body).toContain("starting");
        expect(shell.body).not.toContain("<input");
        expect(shell.body).not.toContain("<form");
        // Unauthenticated callers get 503 starting, not the shell.
        expect((await probe(port, "/")).status).toBe(503);
        // Registration exists and says `starting` while gated.
        const registration = JSON.parse(
          await readFile(path.join(state.stateDir, "gateway-registration.json"), "utf8"),
        ) as { status: string; port: number; pid: number };
        expect(registration.status).toBe("starting");
        expect(registration.port).toBe(port);
        expect(registration.pid).toBe(process.pid);
      } else {
        // OFF = upstream: no socket exists until the kernel binds it.
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        expect((await probe(port, "/health")).status).toBe(0);
        expect((await probe(port, "/ready")).status).toBe(0);
      }
      bootstrapGate.resolve();
      server = await serverPromise;
      await server.startupSettled;
      // The full handler took over the SAME socket (single bind) and
      // /ready means "can chat".
      await waitForStatus(port, "/ready", 200, "ready 200 after gate opens");
      expect((await probe(port, "/health")).status).toBe(200);
      if (mobileBootEnabled) {
        const registration = JSON.parse(
          await readFile(path.join(state.stateDir, "gateway-registration.json"), "utf8"),
        ) as { status: string };
        expect(registration.status).toBe("ready");
      }
    } finally {
      bootstrapGate.resolve();
      try {
        await server?.close();
      } finally {
        await state.cleanup();
        vi.restoreAllMocks();
      }
    }
  },
  120_000,
);
