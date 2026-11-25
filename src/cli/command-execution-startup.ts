import type { StartupConfigPreflightOptions } from "../commands/startup-config-preflight.js";
import { MOBILE_BOOT_DISABLED, type MobileBootOptions } from "../gateway/mobile-boot.js";
import { routeLogsToStderr } from "../logging/console.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import type { resolveCliStartupPolicy } from "./command-startup-policy.js";
import { measureCliCommandStartup } from "./command-startup-timing.js";
import { ensureCliPluginRegistryLoaded } from "./plugin-registry-loader.js";

type CliStartupPolicy = ReturnType<typeof resolveCliStartupPolicy>;

const configGuardModuleLoader = createLazyImportLoader(() => import("./program/config-guard.js"));

const hasJsonFlag = (argv: readonly string[]) =>
  argv.some((arg) => arg === "--json" || arg.startsWith("--json="));

const hasVersionFlag = (argv: readonly string[]) =>
  argv.some((arg) => arg === "--version" || arg === "-V");

export async function applyCliExecutionStartupPresentation(params: {
  argv?: string[];
  startupPolicy: CliStartupPolicy;
  showBanner?: boolean;
  version?: string;
}) {
  // Machine-readable commands must route diagnostics away before startup can print.
  if (params.startupPolicy.suppressDoctorStdout) {
    routeLogsToStderr();
  }
  if (params.startupPolicy.hideBanner || params.showBanner === false || !params.version) {
    return;
  }
  if (params.argv && (hasJsonFlag(params.argv) || hasVersionFlag(params.argv))) {
    return;
  }
  const { emitCliBanner } = await import("./banner.js");
  if (params.argv) {
    emitCliBanner(params.version, { argv: params.argv });
    return;
  }
  emitCliBanner(params.version);
}

export async function ensureCliExecutionBootstrap(params: {
  runtime: RuntimeEnv;
  commandPath: string[];
  startupPolicy: CliStartupPolicy;
  allowInvalid?: boolean;
  beforeStatePreparation?: StartupConfigPreflightOptions["beforeStatePreparation"];
  loadPlugins?: boolean;
  /**
   * Mobile boot profile (fork: F3), resolved once by the CLI gateway-run
   * path and threaded through the startup preflight. `undefined` means
   * OFF (upstream). Other callers (preaction, route, mac-worker-entry)
   * do not supply it and stay upstream.
   */
  mobileBoot?: MobileBootOptions;
}) {
  const { runtime, commandPath, startupPolicy, allowInvalid, beforeStatePreparation } = params;
  const mobileBoot = params.mobileBoot ?? MOBILE_BOOT_DISABLED;
  const { suppressDoctorStdout, pluginRegistry, skipConfigGuard, validateConfigOnly } =
    startupPolicy;
  const loadPlugins = params.loadPlugins ?? startupPolicy.loadPlugins;
  if (!skipConfigGuard) {
    await measureCliCommandStartup("config-ready", async () => {
      const { ensureConfigReady } = await measureCliCommandStartup("config-guard-import", () =>
        configGuardModuleLoader.load(),
      );
      await ensureConfigReady({
        runtime,
        commandPath,
        measure: (stage, run) => measureCliCommandStartup(stage, run),
        ...(allowInvalid ? { allowInvalid: true } : {}),
        ...(validateConfigOnly ? { validateConfigOnly: true } : {}),
        ...(beforeStatePreparation ? { beforeStatePreparation } : {}),
        ...(suppressDoctorStdout ? { suppressDoctorStdout: true } : {}),
        mobileBoot,
      });
    });
  }
  if (!loadPlugins) {
    return;
  }
  await measureCliCommandStartup("plugin-registry", () =>
    ensureCliPluginRegistryLoaded({
      scope: pluginRegistry.scope,
      routeLogsToStderr: suppressDoctorStdout,
    }),
  );
}
