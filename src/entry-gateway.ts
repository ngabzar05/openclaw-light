#!/usr/bin/env node
// Gateway-only entry point (fork: F6).
//
// `src/entry.ts` serves every command (update admission, root/precomputed
// help, native-hook relay, doctor, TUI, ...). This entry serves exactly one
// invocation shape — a foreground Gateway run (`openclaw` or
// `openclaw gateway run ...`) — and imports only what that shape needs:
// the compile-cache launcher, the dispatch startup trace, the gateway-run
// path (`runCli`), and the gateway server-start module as a parallel
// prewarm. Everything else keeps using `entry.js`.
//
// Routing (`openclaw.mjs`, fork): a foreground gateway run is routed here
// only when `OPENCLAW_MOBILE_BOOT=1` (A1); OFF keeps `entry.js`, so OFF
// behavior is identical to upstream. The gateway run itself never reads
// the switch for routing — the launcher decides before importing.
//
// Known divergences from `entry.ts` (all deliberate, all confined to the
// gateway-run shape; see `docs/mobile-fast-boot/LANE-F.md`):
//
// - Update admission is structurally absent: this entry never imports
//   `run-main-update-admission.js`, and `runCli` refuses
//   `update admit`/`preflight` under mobile boot (F8).
// - No root-help / precomputed-command-help fast paths and no native-hook
//   relay: the argv guard below rejects non-gateway invocations before
//   any of those could apply (`secrets audit` via this entry is not
//   supported — use `entry.js`).
// - No `OPENCLAW_AUTH_STORE_READONLY` forcing (`secrets audit` only).
// - Errors escaping `runCli` get a plain stderr line + exit 1 here,
//   instead of `entry.ts`'s formatted diagnostic block / JSON failure
//   envelope. The exit code is the same (1); only the presentation
//   differs. Gateway startup failures that upstream handles inside
//   `runCli` (config errors, lock contention) are unaffected.
// - The compile-cache respawn write-error path writes plain stderr
//   instead of a formatted diagnostic block.
import process from "node:process";
import { fileURLToPath } from "node:url";
import { watchCliRespawnParent } from "../node-runtime-recovery.mjs";
import { parseCliContainerArgs, resolveCliContainerTarget } from "./cli/container-target.js";
import { resolveCliDatabaseProcessRole } from "./cli/database-process-role.js";
import { isForegroundGatewayRunArgv } from "./cli/gateway-run-argv.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./cli/profile.js";
import {
  configureGatewayStartupTraceConsoleFormatting,
  createGatewayDispatchStartupTrace,
} from "./cli/startup-trace.js";
import { normalizeWindowsArgv } from "./cli/windows-argv.js";
import {
  enableOpenClawCompileCache,
  resolveEntryInstallRoot,
  respawnWithoutOpenClawCompileCacheIfNeeded,
} from "./entry.compile-cache.js";
import { buildCliRespawnPlan, runCliRespawnPlan } from "./entry.respawn.js";
import { installDatabaseProcessRole } from "./infra/database-engine/admission-scope.js";
import { normalizeEnv } from "./infra/env.js";
import { fsSafeEnvInput } from "./infra/fs-safe-env.js";
import { isMainModule } from "./infra/is-main.js";
import { ensureOpenClawExecMarkerOnProcess } from "./infra/openclaw-exec-env.js";
import "./shared/detached-async-context.js";
import { installProcessWarningFilter } from "./infra/warning-filter.js";
import {
  getManagedNodeHostStatePath,
  isNodeHostLauncherChild,
  requestNodeHostLauncherBootstrap,
} from "./node-host/launcher-client.js";
import { ExitError } from "./runtime.js";

// Recovery must not select executables from workspace/global dotenv values.
const inheritedRuntimeEnv = { ...process.env };

export const ENTRY_GATEWAY_WRAPPER_PAIRS = [
  { wrapperBasename: "openclaw.mjs", entryBasename: "entry-gateway.js" },
  { wrapperBasename: "openclaw.mjs", entryBasename: "entry-gateway.mjs" },
  { wrapperBasename: "openclaw.js", entryBasename: "entry-gateway.js" },
] as const;

const gatewayEntryStartupTrace = createGatewayDispatchStartupTrace(process.argv, "entry");

// The bundler may import entry-gateway.js as a shared dependency when
// dist/index.js is the actual entry point; without this guard the
// top-level code below would call runCli a second time, starting a
// duplicate gateway that fails on the lock / port and crashes the process.
const isEntryGatewayMain = isMainModule({
  currentFile: fileURLToPath(import.meta.url),
  wrapperEntryPairs: [...ENTRY_GATEWAY_WRAPPER_PAIRS],
});
if (isEntryGatewayMain) {
  try {
    await runEntryGatewayMain();
  } catch (error) {
    if (!(error instanceof ExitError)) {
      throw error;
    }
    process.exitCode = error.code;
  }
}

/**
 * Plain failure handler for errors escaping `runCli`. Deliberately simpler
 * than `entry.ts`'s `prepareCliFailureHandler` (no dotenv/trace formatting,
 * no JSON failure envelope): the gateway-run shape is non-interactive and
 * Polones keys on the exit code, which stays 1 here just like upstream.
 */
async function handleGatewayEntryError(error: unknown): Promise<void> {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[openclaw] Gateway failed to start: ${detail}`);
  process.exitCode = 1;
}

async function runEntryGatewayMain(): Promise<void> {
  // Guard: this entry serves foreground gateway runs only. Anything else
  // is a launcher/routing mistake — fail loudly (exit 2) instead of
  // silently behaving like a different command.
  if (!isForegroundGatewayRunArgv(process.argv)) {
    console.error(
      "[openclaw] entry-gateway serves foreground gateway runs only " +
        "(`openclaw` or `openclaw gateway run ...`). " +
        "Use the default entry for other commands.",
    );
    process.exitCode = 2;
    return;
  }
  installDatabaseProcessRole(resolveCliDatabaseProcessRole(normalizeWindowsArgv(process.argv)));
  watchCliRespawnParent();
  const entryFile = fileURLToPath(import.meta.url);
  const installRoot = resolveEntryInstallRoot(entryFile);
  ensureOpenClawExecMarkerOnProcess();
  installProcessWarningFilter();
  normalizeEnv();
  process.argv = normalizeWindowsArgv(process.argv);
  const earlyProfile = parseCliProfileArgs(process.argv);
  if (earlyProfile.ok && earlyProfile.profile) {
    applyCliProfileEnv({ profile: earlyProfile.profile });
  }
  const startupEnv = { ...fsSafeEnvInput(process.env) };
  const { assertSupportedRuntime, isCurrentRuntimeSupported } =
    await import("./infra/runtime-guard.js");
  if (!(await isCurrentRuntimeSupported())) {
    const { loadCliDotEnv } = await import("./cli/dotenv.js");
    loadCliDotEnv();
    await configureGatewayStartupTraceConsoleFormatting(gatewayEntryStartupTrace);
  }
  await assertSupportedRuntime(undefined, undefined, process.argv, false, inheritedRuntimeEnv);
  const { runNodeHostLauncher } = await import(
    new URL("../node-host-launcher.mjs", import.meta.url).href
  );
  if (await runNodeHostLauncher({ entryPath: entryFile, packageRoot: installRoot })) {
    process.exitCode ??= 0;
    return;
  }
  gatewayEntryStartupTrace.mark("bootstrap");

  const waitingForCompileCacheRespawn =
    !isNodeHostLauncherChild() &&
    (await respawnWithoutOpenClawCompileCacheIfNeeded({
      currentFile: entryFile,
      env: startupEnv,
      prepareWriteError: async () => (message: string) => {
        process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
      },
    }));
  if (!waitingForCompileCacheRespawn) {
    enableOpenClawCompileCache({
      currentFile: entryFile,
      installRoot,
    });

    if (process.argv.includes("--no-color")) {
      process.env.NO_COLOR = "1";
      process.env.FORCE_COLOR = "0";
    }

    async function ensureCliRespawnReady(): Promise<boolean> {
      const plan = buildCliRespawnPlan({ env: startupEnv });
      if (!plan) {
        return false;
      }
      if (isNodeHostLauncherChild()) {
        await requestNodeHostLauncherBootstrap({
          execArgv: plan.argv.slice(0, plan.argv.length - process.argv.length + 1),
          env: plan.env,
        });
        process.exitCode = 0;
        return true;
      }

      const writeError = (message: string) => {
        process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
      };
      await runCliRespawnPlan(plan, writeError);
      // Parent must not continue running the CLI.
      return true;
    }

    if (!(await ensureCliRespawnReady())) {
      // Only the final child emits the diagnostic warning; parents still enforce admission.
      await assertSupportedRuntime(undefined, undefined, process.argv, true, inheritedRuntimeEnv);
      // Idle respawn parents retain argv so offline maintenance can identify its launchers.
      process.title = "openclaw";
      const parsedContainer = parseCliContainerArgs(process.argv);
      if (!parsedContainer.ok) {
        console.error(`[openclaw] ${parsedContainer.error}`);
        process.exitCode = 2;
        return;
      }

      const parsed = parseCliProfileArgs(parsedContainer.argv);
      if (!parsed.ok) {
        // Keep it simple; Commander will handle rich help/errors after we strip flags.
        console.error(`[openclaw] ${parsed.error}`);
        process.exitCode = 2;
        return;
      }

      const containerTargetName = resolveCliContainerTarget(process.argv);
      if (parsed.profile) {
        applyCliProfileEnv({ profile: parsed.profile });
        // Keep Commander and ad-hoc argv checks consistent.
        process.argv = parsed.argv;
      }
      if (containerTargetName && parsed.profile) {
        console.error("[openclaw] --container cannot be combined with --profile/--dev");
        process.exitCode = 2;
        return;
      }
      gatewayEntryStartupTrace.mark("argv");

      // F6 prewarm: kick off the gateway server-start import in parallel
      // with `runCli` (which spends its first seconds in the config
      // preflight). `server-start.js` is import-only by construction
      // (upstream `gateway-prewarm` contract: "Import only: do not start
      // a Gateway"), and the server later imports the same specifier, so
      // this becomes a module-cache hit instead of a cold import
      // (`gateway.server-start-import`, ~1.9 s [LAB]). A failure here must
      // never fail the boot — the server import will simply run cold.
      // Not awaited; the `.catch` converts failures into a warning, so
      // this can never surface as an unhandled rejection. See
      // `docs/mobile-fast-boot/LANE-F.md` for the measured net effect
      // (parallel import vs CPU/disk contention).
      void import("./gateway/server-start.js").catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[openclaw] gateway-prewarm import failed (continuing cold): ${detail}`);
      });

      const { runCliWithExitFinalization } = await import("./cli/one-shot-exit.js");
      const run = async (finalize?: () => Promise<void>) => {
        const { withCliProcessScope } = await import("./cli/runtime-cleanup-scope.js");
        return withCliProcessScope(async () => {
          await runCliWithExitFinalization({
            finalize,
            run: async () => {
              const { runCli } = await gatewayEntryStartupTrace.measure("run-main-import", () =>
                import("./cli/run-main.js"),
              );
              await runCli(process.argv, {
                additionalStartupTrace: gatewayEntryStartupTrace,
                runtimeRecoveryEnv: inheritedRuntimeEnv,
                // Finalizers and process-exit hooks can still emit diagnostics after runCli settles.
                retainConsoleRoutingUntilProcessExit: true,
              });
            },
            onError: handleGatewayEntryError,
          });
        });
      };
      const managedNodeStatePath = getManagedNodeHostStatePath();
      if (managedNodeStatePath) {
        const { withExistingOpenClawStateSchema } =
          await import("./state/openclaw-state-db-schema-policy.js");
        await withExistingOpenClawStateSchema({ path: managedNodeStatePath }, async () => {
          const { openOpenClawStateDatabase, closeOpenClawStateDatabaseByPathAsync } =
            await import("./state/openclaw-state-db.js");
          openOpenClawStateDatabase({ path: managedNodeStatePath });
          await run(async () => {
            await closeOpenClawStateDatabaseByPathAsync(managedNodeStatePath);
          });
        });
      } else {
        await run();
      }
    }
  }
}
