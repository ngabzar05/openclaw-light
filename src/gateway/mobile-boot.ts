// Mobile boot profile (fork: A1) — single switch for every mobile-boot behavior.
//
// `OPENCLAW_MOBILE_BOOT=1` enables the fork's fast-boot profile. Default OFF
// means pure upstream behavior (guardrail N10): no fork behavior may run
// unless this switch is on, and no fork behavior may read the env var
// directly — everything consumes the `MobileBootOptions` value resolved
// exactly once per process (see `resolveMobileBootOptions`) and threaded
// through `GatewayServerOptions.mobileBoot`.
//
// Lane A scope (this file + plumbing only): the switch is read once in the
// CLI gateway-run path (`src/cli/gateway-cli/run.ts`) and threaded through
// `startGatewayServer` → `startGatewayServerCore` → `createGatewayKernel` →
// `prepareGatewayServerBootstrap` (whose return value carries it back out
// for downstream consumers). Enabling the switch in Lane A changes NO
// behavior yet — the behaviors themselves are wired by later lanes on top
// of this switch. Threading points for those lanes (do NOT re-read the env):
//
// - Lock fast-path (Lane C, F2): `src/cli/gateway-cli/run-loop-startup.ts`
//   `prepareGatewayRunLoop` — the value arrives as `params.mobileBoot`;
//   pass it into `acquireGatewayLock` once that function accepts
//   `MobileBootOptions`. Direct (non-CLI) servers acquire their lock in
//   `src/gateway/server.ts` `startGatewayServer` — the value is on
//   `opts.mobileBoot` there.
// - Session admission deferral (Lane B, F1): `src/gateway/server-startup-bootstrap.ts`
//   `prepareGatewayServerBootstrapSelected` — the value is on
//   `input.opts.mobileBoot` and on the returned `mobileBoot` field; the
//   `sessions.admission` call site is the `preparations` array in that
//   function, via `prepareGatewayStartupSessions`.
// - Plugin loader (Lane D, F5/A3): `src/gateway/server-startup-plugins.ts`
//   `prepareGatewayPluginBootstrap` / `loadGatewayStartupPluginRuntime` —
//   thread `mobileBoot` from the bootstrap return value (or from
//   `GatewayServerOptions`) into their params; the plan loader lives in
//   `src/plugins/gateway-startup-plugin-loader.ts`.
// - Early-listen restructure (Lane G, F4): consumes the same value from
//   `GatewayServerOptions.mobileBoot` at the `gateway-prewarm` /
//   `server-start.ts` boundary.
//
// Lane F scope (F3/F6/F8; this comment is the threading map — do NOT
// re-read the env anywhere else):
//
// - Resolution point (exactly once per process, CLI gateway-run path):
//   `src/cli/run-main.ts` `tryRunGatewayRunFastPath` resolves
//   `resolveMobileBootOptions(process.env)` once, then threads the value
//   down both branches: the preflight (via `bootstrapGatewayRun` —
//   `src/cli/gateway-cli/run-command.ts` — `mobileBoot` param →
//   `ensureCliExecutionBootstrap` — `src/cli/command-execution-startup.ts`
//   → `ensureConfigReady` — `src/cli/program/config-guard.ts` →
//   `runStartupConfigPreflight` — `src/commands/startup-config-preflight.ts`
//   → `readAdmittedConfigSnapshot` —
//   `src/commands/config-preflight-snapshot.ts`) and the gateway action
//   (attached to the resolved `GatewayRunOpts.mobileBoot` by the
//   `beforeRun` hook in the same function; consumed in
//   `runGatewayCommandOnce` — `src/cli/gateway-cli/run.ts` — as
//   `opts.mobileBoot ?? resolveMobileBootOptions(process.env)`, the
//   fallback covering direct callers/tests that never went through the
//   fast path).
// - F3(a): with the switch ON, the preflight snapshot read is core-only
//   (`includePluginMetadata: false`, `skipPluginValidation: true`); the
//   full plugin-metadata read still happens pre-listen, once, in
//   `readGatewayStartupConfig` (`run.ts`). Plugin-invalid config is
//   enforced there (invalid-config error → recovery offer, then exit 78),
//   because the preflight no longer sees plugin issues.
// - F3(b): the database/session runtime imports in
//   `assertStartupStateReady` (`config-preflight-snapshot.ts`) go through
//   module-level `createLazyRuntimeModule` loaders (shared lazy-runtime
//   pattern); behavior-neutral, same modules, same first-use point.
// - F3(c): with the switch ON, the state-snapshot scope in
//   `readAdmittedConfigSnapshot` is lazy (`lazy: true`, upstream-supported
//   in `src/state/openclaw-state-db-readonly.ts`) — snapshot bytes are
//   prepared only when a reader inside the scope demands them.
// - F6: `src/entry-gateway.ts` is the gateway-only entry (compile-cache
//   launcher + trace + `runCli` + parallel `gateway-prewarm` import).
//   `openclaw.mjs` routes foreground gateway runs to it only when this
//   switch is ON; everything else keeps `src/entry.ts`.
// - F8: with the switch ON, `runCli` (`run-main.ts`) refuses
//   `update admit`/`preflight` invocations (exit 2) instead of running
//   update admission, and the post-attach update check
//   (`src/gateway/server-startup-post-attach.ts`) is skipped. That is the
//   only second resolution of the switch, and it runs only for
//   update-admission invocations (mutually exclusive with a gateway run
//   in one process), so "resolve once per process" still holds per path.
//
// Guardrails: N1–N10 apply to every behavior gated by this switch. If a
// later lane finds that a behavior requires changing one of N1–N10, it must
// STOP and report to the coordinator instead of deciding alone.
import { isTruthyEnvValue } from "../infra/env.js";

/** Environment variable that enables the mobile boot profile. */
export const MOBILE_BOOT_ENV_VAR = "OPENCLAW_MOBILE_BOOT";

/**
 * Resolved mobile boot profile. `enabled: false` is pure upstream behavior.
 * Lanes B–G add behavior behind `enabled: true`; they must never add a
 * second env var for the same decision.
 */
export type MobileBootOptions = {
  readonly enabled: boolean;
};

/** Canonical "profile off" value; used when no caller supplied options. */
export const MOBILE_BOOT_DISABLED: MobileBootOptions = { enabled: false };

/**
 * Resolve the mobile boot profile from the environment. This is the ONLY
 * place that reads `OPENCLAW_MOBILE_BOOT`. Callers that already hold a
 * resolved value must thread it through instead of calling this again.
 */
export function resolveMobileBootOptions(env: NodeJS.ProcessEnv = process.env): MobileBootOptions {
  return { enabled: isTruthyEnvValue(env[MOBILE_BOOT_ENV_VAR]) };
}
