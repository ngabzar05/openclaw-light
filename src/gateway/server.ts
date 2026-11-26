/**
 * Lazy public entrypoint for the gateway server implementation.
 *
 * Keeping `server-start` behind dynamic import lets light-weight callers import
 * server types and helpers without paying the full startup dependency graph.
 */
import { performance } from "node:perf_hooks";
import { measureGatewayBootstrapStep } from "../cli/startup-trace.js";
import { installDatabaseProcessRole } from "../infra/database-engine/admission-scope.js";
import { formatErrorMessage } from "../infra/errors.js";
import { supportsSpawnBrokerCommandTransport } from "../process/spawn-broker/pipe.js";
import { getProcessCleanupBudget } from "../process/supervisor/cleanup-budget.js";
import { settlesWithin } from "../shared/settle-within.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveMobileBootOptions } from "./mobile-boot.js";
import { formatGatewayPendingCloseSteps, measureGatewayCloseStep } from "./restart-trace.js";
import type { GatewayServer, GatewayServerOptions } from "./server-public.js";
import {
  GatewayShutdownCleanupRetainedError,
  GatewayStartupCleanupError,
  rethrowGatewayStartupError,
} from "./server-shutdown.js";
import {
  createListenPhase,
  createListenStubServer,
  markListenPhaseBound,
  resolveListenStubSecrets,
  type ListenStubBundle,
} from "./server/listen-stub.js";

export { truncateCloseReason } from "./server/close-reason.js";
export type { GatewayServer, GatewayServerOptions } from "./server-public.js";

async function loadServerStart() {
  return await measureGatewayBootstrapStep(
    "gateway.server-start-import",
    () => import("./server-start.js"),
  );
}

/**
 * Fase 1 (fork: Lane F1-I) — bind the early-listen stub (mobile boot ON
 * only). This runs before the sqlite engine install, the lock and the
 * kernel, so `/health` answers while the rest of startup still runs.
 *
 * Order notes (N2/N4): the exclusive TCP bind is the first exclusivity
 * claim for direct callers; in the CLI path the run loop already holds
 * the gateway lock before `startGatewayServer` is called, so the order
 * there stays lock-then-bind exactly as today — the stub bind does not
 * weaken it. No state is touched between bind and lock: the only write
 * in the window is the atomic registration file, which no gateway
 * treats as authority. The sqlite init keeps its proven position
 * before the lock (it only loads the runtime; the state DB is first
 * opened by the bootstrap, after the lock).
 *
 * Returns `undefined` (legacy flow) when the stub is skipped: TLS is
 * enabled in the startup snapshot (a plain stub server cannot be
 * upgraded to HTTPS — fail safe to the legacy flow, never serve TLS
 * config over plain HTTP), or the caller is an update canary.
 */
async function bindListenStub(
  port: number,
  opts: GatewayServerOptions,
): Promise<ListenStubBundle | undefined> {
  const snapshotConfig = opts.startupConfigSnapshotRead?.snapshot.config;
  if (snapshotConfig?.gateway?.tls?.enabled === true) {
    const { createSubsystemLogger } = await import("../logging/subsystem.js");
    createSubsystemLogger("gateway").warn(
      "mobile boot early-listen disabled for this boot: gateway TLS is enabled and the stub binds plain HTTP",
    );
    return undefined;
  }
  // The CLI path already resolved this exact host (`healthHost` in
  // run.ts, same inputs as the kernel's `resolveGatewayRuntimeConfig`).
  // Direct callers resolve it the same way the kernel does.
  const bindHost =
    opts.bindHost ??
    opts.host ??
    (await (async () => {
      const { resolveGatewayBindHost } = await import("./net.js");
      return resolveGatewayBindHost(
        opts.bind ?? snapshotConfig?.gateway?.bind,
        snapshotConfig?.gateway?.customBindHost,
      );
    })());
  const phase = createListenPhase({
    port,
    bindHost,
    ...(opts.bootId ? { bootId: opts.bootId } : {}),
    ...(opts.startupStartedAt ? { startedAtMs: opts.startupStartedAt } : {}),
  });
  const { server, handlerRef } = createListenStubServer(phase, resolveListenStubSecrets());
  const { listenGatewayHttpServer } = await import("./server/http-listen.js");
  try {
    await measureGatewayBootstrapStep("gateway.listen-stub.bind", () =>
      listenGatewayHttpServer({
        httpServer: server,
        bindHost,
        port,
        serviceName: "gateway",
      }),
    );
  } catch (error) {
    // Never leak the unbound server into the retry/close path.
    await new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
    throw error;
  }
  markListenPhaseBound(phase);
  // Registration is best-effort and never fails startup (D-4).
  try {
    const { writeGatewayRegistration } = await import("./server/listen-registration.js");
    await writeGatewayRegistration({
      port,
      bindHost,
      bootId: phase.bootId,
      startedAtMs: phase.startedAtMs,
    });
  } catch (error) {
    const { createSubsystemLogger } = await import("../logging/subsystem.js");
    createSubsystemLogger("gateway").warn(
      `gateway registration file could not be written: ${formatErrorMessage(error)}`,
    );
  }
  const { createSubsystemLogger } = await import("../logging/subsystem.js");
  createSubsystemLogger("gateway").info(
    `gateway listening (starting) on http://${bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost}:${port} — /health live, /ready pending`,
  );
  return { server, handlerRef, phase };
}

async function closeWithRuntimeCleanup(
  name: string,
  close: (() => Promise<void>) | undefined,
  run: () => Promise<void>,
  options: Parameters<GatewayServer["close"]>[0],
): Promise<void> {
  let failure: { error: unknown } | undefined;
  try {
    await close?.();
  } catch (error) {
    failure = { error };
  }
  try {
    const pending = measureGatewayCloseStep(`shutdown.${name}`, run);
    const budget = getProcessCleanupBudget();
    const graceMs = budget ? Math.max(0, budget.deadline - performance.now()) : 5_000;
    if (!options?.exitAfterClose) {
      await pending;
    } else if (!(await settlesWithin(pending, graceMs))) {
      const message = `${name} cleanup exceeded process shutdown deadline; resources remain; pending: ${formatGatewayPendingCloseSteps()}`;
      budget?.warn(message);
      throw new GatewayShutdownCleanupRetainedError([new Error(message)], message);
    }
  } catch (error) {
    if (failure) {
      throw new AggregateError(
        [failure.error, error],
        `${formatErrorMessage(failure.error)}; ${formatErrorMessage(error)}`,
        { cause: error },
      );
    }
    throw error;
  }
  if (failure) {
    throw failure.error;
  }
}

/** Starts the gateway server after lazily loading the full server implementation. */
export async function startGatewayServer(
  port = 18789,
  opts: GatewayServerOptions = {},
): ReturnType<typeof import("./server-start.js").startGatewayServerCore> {
  // A1: the mobile boot profile is resolved exactly once per process by the
  // CLI gateway-run path and threaded in via `opts.mobileBoot`. Direct/embed
  // callers that do not supply it fall back to a single env read here, so
  // no downstream code ever reads `OPENCLAW_MOBILE_BOOT` itself.
  const mobileBoot = opts.mobileBoot ?? resolveMobileBootOptions(process.env);
  const serverOpts: GatewayServerOptions = { ...opts, mobileBoot };
  installDatabaseProcessRole("gateway");
  // Fase 1 (fork: Lane F1-I): bind the stub first (ON only, never for
  // update canaries). Everything below — sqlite init, lock, broker,
  // kernel — runs after `http.bound`. OFF keeps the legacy order byte
  // for byte (N10).
  const listenStub =
    mobileBoot.enabled && !opts.updateCanary
      ? await bindListenStub(port, serverOpts)
      : undefined;
  if (listenStub) {
    serverOpts.listenStub = listenStub;
  }
  const { installGatewayDatabaseEngine } = await import("./server-database-engine.js");
  await measureGatewayBootstrapStep("gateway.database-engine-install", () =>
    installGatewayDatabaseEngine(
      serverOpts.startupConfigSnapshotRead?.snapshot,
      serverOpts.startupConfigSnapshotRead?.databaseEngineSelection,
    ),
  );
  const { initializeSqliteRuntime } = await import("../infra/sqlite-runtime-initialize.js");
  await measureGatewayBootstrapStep("gateway.sqlite-runtime-initialize", () =>
    initializeSqliteRuntime(),
  );
  const { acquireGatewayLock } = await import("../infra/gateway-lock.js");
  const ownedLock = serverOpts.gatewayStateOwner
    ? null
    : await measureGatewayBootstrapStep("gateway.lock-acquire", () =>
        // F2 (fork: Lane C): `mobileBoot` (resolved once in
        // `startGatewayServer` above) reaches the lock acquisition here
        // for direct/embed callers; the CLI path passes it via
        // `prepareGatewayRunLoop` instead.
        acquireGatewayLock({ port, listenerMode: "foreground", mobileBoot }),
      );
  const gatewayStateOwner = serverOpts.gatewayStateOwner ?? ownedLock ?? undefined;
  let close: GatewayServer["close"] | undefined;
  let detachOwner: (() => void) | undefined;
  try {
    const { captureGatewayStateOwner } = await import("../infra/gateway-state-owner.js");
    const { createSubsystemLogger } = await import("../logging/subsystem.js");
    const log = createSubsystemLogger("gateway");
    const databasePath = resolveOpenClawStateSqlitePath();
    gatewayStateOwner?.assertDatabaseAccess(databasePath);
    const signal = captureGatewayStateOwner(databasePath)?.signal;
    const onOwnerLost = () => {
      const reason = String(signal?.reason);
      const restart = close ? serverOpts.hotReloadRecovery?.(reason) : undefined;
      if (close && (!restart || restart.status === "failed")) {
        void close({ reason }).catch((error: unknown) => {
          log.error(`Gateway lost ownership cleanup failed: ${String(error)}`);
        });
      }
    };
    signal?.addEventListener("abort", onOwnerLost, { once: true });
    detachOwner = () => signal?.removeEventListener("abort", onOwnerLost);
    signal?.throwIfAborted();
    // Fase 1: the stub already bound, so this is the listening moment —
    // the transport must not mark it again (see server-start.ts).
    if (listenStub) {
      gatewayStateOwner?.markListening();
    }
    const server = await startGatewayServerWithRuntime(port, { ...serverOpts, gatewayStateOwner });
    let closing: Promise<void> | undefined;
    const closeServer: GatewayServer["close"] = (closeOptions) => {
      detachOwner?.();
      return (closing ??= (async () => {
        await server.close(closeOptions);
        // A failed join retains ownership: another starter must not enter over live work.
        await ownedLock?.release();
        // Fase 1: remove the early registration on clean close (a crash
        // leaves a stale file; readers must check pid + bootId).
        if (listenStub) {
          const { removeGatewayRegistration } = await import("./server/listen-registration.js");
          await removeGatewayRegistration().catch(() => {});
        }
      })());
    };
    close = closeServer;
    if (signal?.aborted) {
      const reason = signal.reason;
      return await rethrowGatewayStartupError(reason, () =>
        closeServer({
          reason: String(reason),
          exitAfterClose: serverOpts.exitAfterStartupFailure?.(reason),
        }),
      );
    }
    return {
      ...server,
      close: closeServer,
    };
  } catch (error) {
    detachOwner?.();
    if (!close && !(error instanceof GatewayStartupCleanupError)) {
      await ownedLock?.release();
    }
    throw error;
  }
}

async function startGatewayServerWithRuntime(
  port: number,
  opts: GatewayServerOptions,
): ReturnType<typeof import("./server-start.js").startGatewayServerCore> {
  const startupStartedAt = opts.startupStartedAt ?? Date.now();
  let stopDatabaseAdmission: (() => Promise<void>) | undefined;
  const start = async () => {
    const { createSqliteReadOnlyWorkerScope } = await import("../infra/sqlite-readonly-worker.js");
    const readOnlyWorkers = createSqliteReadOnlyWorkerScope();
    const { withAgentDatabaseStartupAdmission } =
      await import("../state/agent-database-startup.js");
    try {
      const { bindAuthProfileFileObservationReaders } =
        await import("../agents/auth-profiles/file-state.js");
      const server = await readOnlyWorkers.run(() => {
        bindAuthProfileFileObservationReaders();
        return withAgentDatabaseStartupAdmission(
          async (admission) => {
            stopDatabaseAdmission = () => admission.stop();
            const mod = await loadServerStart();
            opts.gatewayStateOwner?.assertDatabaseAccess(resolveOpenClawStateSqlitePath());
            return mod.startGatewayServerCore(port, { ...opts, startupStartedAt });
          },
          { deferInspections: !opts.updateCanary },
        );
      });
      return {
        ...server,
        close: (closeOptions: Parameters<typeof server.close>[0]) =>
          readOnlyWorkers.run(() =>
            closeWithRuntimeCleanup(
              "read-only-workers",
              () => server.close(closeOptions),
              () => readOnlyWorkers.close(),
              closeOptions,
            ),
          ),
      };
    } catch (error) {
      return await rethrowGatewayStartupError(error, () =>
        closeWithRuntimeCleanup("read-only-workers", undefined, () => readOnlyWorkers.close(), {
          exitAfterClose: opts.exitAfterStartupFailure?.(error),
        }),
      );
    }
  };
  // Gateway brokerage targets Linux's page-table copy cost.
  if (process.platform !== "linux" || !supportsSpawnBrokerCommandTransport()) {
    return await start();
  }
  const { startGatewaySpawnBroker, runWithSpawnBroker } =
    await import("../process/spawn-broker/context.js");
  let logger: { info: (message: string) => void } | undefined;
  const broker = await startGatewaySpawnBroker({
    onReady(pid, restarted) {
      if (restarted) {
        logger?.info(`spawn broker restarted pid=${pid}`);
      }
    },
    async onStartupFailure(message) {
      const { createSubsystemLogger } = await import("../logging/subsystem.js");
      createSubsystemLogger("gateway").error(message);
    },
  });
  if (!broker) {
    return await start();
  }
  const closeBroker = async () => {
    // A failed required core join can stop before the admission sidecar runs.
    await measureGatewayCloseStep("shutdown.database-admission", () => stopDatabaseAdmission?.());
    try {
      const { closeSqliteReadOnlyWorkersForBroker } =
        await import("../infra/sqlite-readonly-worker.js");
      await measureGatewayCloseStep("shutdown.broker-read-only-workers", () =>
        closeSqliteReadOnlyWorkersForBroker(broker),
      );
    } finally {
      // Readers that did not close remain attached children for broker termination.
      await measureGatewayCloseStep("shutdown.spawn-broker", () => broker.close());
    }
  };
  try {
    const { createSubsystemLogger } = await import("../logging/subsystem.js");
    logger = createSubsystemLogger("gateway");
    logger.info(`spawn broker ready pid=${broker.pid}`);
    const server = await runWithSpawnBroker(broker, start);
    return {
      ...server,
      close: (closeOptions) =>
        runWithSpawnBroker(broker, () =>
          // The tail keeps joining in order even when its process owner must proceed to exit.
          closeWithRuntimeCleanup(
            "spawn-broker-runtime",
            () => server.close(closeOptions),
            closeBroker,
            closeOptions,
          ),
        ),
    };
  } catch (error) {
    return await rethrowGatewayStartupError(error, () =>
      closeWithRuntimeCleanup("spawn-broker-runtime", undefined, closeBroker, {
        exitAfterClose: opts.exitAfterStartupFailure?.(error),
      }),
    );
  }
}
