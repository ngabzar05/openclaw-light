// F9 startup instrumentation (fork) — the new phase names must be visible
// as "startup phase" lines even without OPENCLAW_GATEWAY_STARTUP_TRACE, and
// measuring must never change the measured work's result or errors.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayStartupTrace, measureStartup } from "./server-startup-trace.js";

/** Every span name Lane A added (F9). Kept in sync with STARTUP_PROGRESS_PHASES. */
const F9_PHASE_NAMES = [
  "sessions.admission.deletion-snapshot",
  "sessions.admission.store-identity",
  "sessions.admission.acp-keys",
  "sessions.admission.legacy-main-keys",
  "sessions.admission.targets",
  "plugins.bootstrap.subagent-registry",
  "plugins.bootstrap.plan",
  "plugins.bootstrap.activation-config",
  "plugins.bootstrap.lookup-table",
  "gateway.http-transport",
  "http.listen.tailscale-ingress",
  "http.listen.bind",
  "http.listen.portal-ingress",
  "http.listen.sandbox-host",
  "http.listen.plugin-listeners",
];

describe("F9 startup trace phases", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(F9_PHASE_NAMES)(
    "emits %s as a startup phase line without the trace env",
    async (name) => {
      vi.stubEnv("OPENCLAW_GATEWAY_STARTUP_TRACE", "0");
      const info = vi.fn();
      const trace = createGatewayStartupTrace({ info } as never);
      try {
        await trace.measure(name, () => "ok");
        expect(info.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
          `startup phase: ${name}`,
        );
      } finally {
        trace.close();
      }
    },
  );

  it("measureStartup without a trace runs the work unchanged", async () => {
    await expect(measureStartup(undefined, "f9.no-trace", () => 42)).resolves.toBe(42);
    await expect(measureStartup(undefined, "f9.no-trace-async", async () => "done")).resolves.toBe(
      "done",
    );
  });

  it("measureStartup without a trace propagates the work's error", async () => {
    const failure = new Error("boom");
    await expect(
      measureStartup(undefined, "f9.no-trace-error", () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});
