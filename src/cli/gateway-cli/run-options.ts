// Source-aware gateway run option resolution shared by pre-action and runtime startup.
import type { Command } from "commander";
import type { MobileBootOptions } from "../../gateway/mobile-boot.js";
import { inheritOptionFromParent } from "../command-options.js";

export type GatewayRunOpts = Partial<
  Record<(typeof GATEWAY_RUN_VALUE_KEYS)[number], unknown> &
    Record<Exclude<(typeof GATEWAY_RUN_BOOLEAN_KEYS)[number], "claudeCliLogs">, boolean>
> & {
  /** @deprecated Use cliBackendLogs. */
  claudeCliLogs?: boolean;
  /**
   * Mobile boot profile (fork: A1/F3), resolved exactly once by the CLI
   * gateway-run path (`tryRunGatewayRunFastPath`, `src/cli/run-main.ts`)
   * and attached by the `beforeRun` hook — never resolved here. Direct
   * callers that do not supply it fall back to a single env read in
   * `runGatewayCommandOnce` (`src/cli/gateway-cli/run.ts`).
   */
  mobileBoot?: MobileBootOptions;
};

const GATEWAY_RUN_VALUE_KEYS = [
  "port",
  "bind",
  "token",
  "auth",
  "password",
  "passwordFile",
  "tailscale",
  "wsLog",
  "rawStreamPath",
] as const;

const GATEWAY_RUN_BOOLEAN_KEYS = [
  "tailscaleResetOnExit",
  "allowUnconfigured",
  "dev",
  "ambientChannels",
  "devAmbientChannels",
  "reset",
  // Internal Windows Task Scheduler bridge; hidden from normal CLI help.
  "taskSupervisor",
  // Internal isolated update rehearsal, hidden from operator help.
  "updateCanary",
  "force",
  "verbose",
  "cliBackendLogs",
  "claudeCliLogs",
  "compact",
  "rawStream",
] as const;

export function resolveGatewayRunOptions(opts: GatewayRunOpts, command?: Command): GatewayRunOpts {
  const resolved: GatewayRunOpts = { ...opts };

  for (const key of GATEWAY_RUN_VALUE_KEYS) {
    const inherited = inheritOptionFromParent(command, key);
    // wsLog has a child default ("auto"), so prefer an explicit parent CLI value.
    resolved[key] = key === "wsLog" ? (inherited ?? resolved[key]) : (resolved[key] ?? inherited);
  }

  for (const key of GATEWAY_RUN_BOOLEAN_KEYS) {
    const inherited = inheritOptionFromParent<boolean>(command, key);
    resolved[key] = Boolean(resolved[key] || inherited);
  }

  return resolved;
}
