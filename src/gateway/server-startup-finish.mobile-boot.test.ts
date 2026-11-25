// F4(b) — early-runtime join deferral (mobile boot profile, A1).
//
// Invariants pinned here:
// 1. ON (`mobileBoot.enabled`): post-attach and /ready must NOT wait for
//    the early runtime. /health 200 and /ready 200 are both observable
//    while the early runtime is still pending; the gateway still reaches
//    ready and runs post-ready maintenance once the early runtime lands.
//    Red without the fix: the old code awaited earlyRuntimeReady before
//    post-attach, so /ready would stay 503 until the gate opens.
// 2. OFF (upstream): the early runtime is still joined before
//    post-attach — /ready stays 503 while the early runtime is pending.
//    Guards the A1 gate: OFF must stay pure upstream.
//
// The early runtime is held behind a test gate by mocking
// `startGatewayEarlyRuntime` (same technique as
// server-startup-post-ready.test.ts). Both cases boot a real gateway
// through `startGatewayServerCore` with the startup fixture. The
// discovery re-refresh mitigation (F4(b)) is not asserted here —
// minimal-test discovery is a no-op and the re-refresh is covered by
// the `runtime.early.discovery-refreshed` trace mark in LAB runs (see
// docs/mobile-fast-boot/MEASUREMENT.md §6).
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { getFreePort } from "../test-utils/ports.js";
import type { GatewayServer } from "./server-public.js";
import * as fixture from "./server-startup-state.test-support.js";

async function probeStatus(port: number, path: string): Promise<number> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return res.status;
  } catch {
    return 0;
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
    if ((await probeStatus(port, path)) === status) {
      return;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${label} (GET ${path} -> ${status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

it.each([true, false])(
  "mobileBoot.enabled=%s: early runtime join timing",
  async (mobileBootEnabled) => {
    const port = await getFreePort();
    const state = await fixture.createGatewayStartupTestState(
      `gateway-f4-early-runtime-${mobileBootEnabled ? "on" : "off"}`,
      { OPENCLAW_TEST_MINIMAL_GATEWAY: "1" },
    );
    // Mirror server-startup-post-ready.test.ts: the flag shapes fixture
    // creation, then is removed so the booted gateway runs non-minimal
    // (post-attach + post-ready maintenance execute).
    state.envVars.OPENCLAW_TEST_MINIMAL_GATEWAY = undefined;
    const earlyGate = createDeferred();
    const startMaintenance = vi.fn(async () => null);
    const earlyModule = await import("./server-startup-early.js");
    const startEarlyRuntime = earlyModule.startGatewayEarlyRuntime;
    vi.spyOn(earlyModule, "startGatewayEarlyRuntime").mockImplementation(async (...args) => {
      await earlyGate.promise;
      return {
        ...(await startEarlyRuntime(...args)),
        startMaintenance,
      };
    });
    let server: GatewayServer | undefined;
    try {
      const token = "gateway-f4-early-runtime-token";
      await state.writeConfig({
        gateway: fixture.gatewayStartupTestConfig(port, token),
        plugins: { enabled: false },
        discovery: { mdns: { mode: "off" } },
      });
      state.applyEnv();
      const { startGatewayServerCore } = await import("./server-start.js");
      // Do not await: in ON mode finishGatewayStartup blocks at the late
      // join while the gate is closed — the HTTP server is already
      // listening, so the probes below still answer.
      const serverPromise = startGatewayServerCore(port, {
        ...fixture.gatewayStartupTestOptions(token),
        mobileBoot: { enabled: mobileBootEnabled },
      });
      // /health answers as soon as the socket is bound (liveness probe —
      // never waits for the early runtime, in either mode).
      await waitForStatus(port, "/health", 200, "health 200");
      if (mobileBootEnabled) {
        // F4(b): post-attach and /ready proceed while the early runtime
        // is still gated — this is the deferral.
        await waitForStatus(port, "/ready", 200, "ready 200 while early runtime gated");
      } else {
        // OFF = upstream: the early runtime is joined before
        // post-attach, so /ready must NOT go green while it is gated.
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        expect(await probeStatus(port, "/ready")).toBe(503);
      }
      earlyGate.resolve();
      server = await serverPromise;
      await server.startupSettled;
      await vi.waitFor(() => expect(startMaintenance).toHaveBeenCalled(), {
        timeout: 30_000,
        interval: 100,
      });
      expect(await probeStatus(port, "/ready")).toBe(200);
    } finally {
      earlyGate.resolve();
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
