import {
  getRuntimeConfig,
  getRuntimeConfigSourceSnapshot,
  promoteConfigSnapshotToLastKnownGood,
  readConfigFileSnapshotForRuntimeTransaction,
  registerConfigWriteListener,
} from "../config/io.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import { isNixMode } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { flushDiagnosticsTimeline } from "../infra/diagnostics-timeline.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import { resolveGatewayAuth } from "./auth.js";
// F4(a): config-diff, config-reload-plan, plugin-node-capability,
// server-agent-database-startup, server-methods/nodes.read,
// server-runtime-config, server-tls-renewal, server/client-human-presence
// and server/ws-origin-policy are loaded lazily at their (post-bind /
// post-ready) points of use below, so they leave the pre-listen import
// graph. Each module was verified side-effect-free at top level (only
// function/const/class/type declarations; see docs/mobile-fast-boot/F4-AUDIT.md),
// so loading it at first use instead of at server-start import time is
// unobservable — OFF mode keeps the same call order and first-use points.
import { isCustomPluginUiEnabled } from "./control-ui-plugin-policy.js";
import { startDeferredSessionMigration } from "./deferred-session-migration.js";
import { GATEWAY_EVENTS } from "./events.js";
import { collectGatewayProcessMemoryUsageMb, finishGatewayRestartTrace } from "./restart-trace.js";
import type { GatewayKernelRuntime } from "./server-kernel-request-runtime.js";
import { clearGatewayMaintenanceHandles } from "./server-maintenance-lifecycle.js";
import type { GatewayHttpTransport } from "./server-transport-bridge.js";
import { collectGatewayWorkerPoolMetrics } from "./server/process-vitals.js";
import { DEFAULT_TERMINAL_DETACH_SECONDS } from "./terminal/session-limits.js";

type GatewayLogger = ReturnType<typeof createSubsystemLogger>;
const [POST_READY_MAINTENANCE_DELAY_MS, RETAINED_PLUGIN_CLEANUP_DELAY_MS] = [250, 30_000];

type GatewayStartedRuntime = GatewayKernelRuntime & GatewayHttpTransport;

export async function finishGatewayStartup(params: {
  kernelRuntime: GatewayStartedRuntime;
  port: number;
  bootId: string;
  opts: GatewayStartedRuntime["opts"];
  log: GatewayLogger;
  logHealth: GatewayLogger;
  logWsControl: GatewayLogger;
  logHooks: GatewayLogger;
  logChannels: GatewayLogger;
  logCron: GatewayLogger;
  logReload: GatewayLogger;
  waitForPostReadyWork: () => Promise<void>;
}) {
  const {
    kernelRuntime: runtime,
    port,
    opts,
    log,
    logHealth,
    logWsControl,
    logHooks,
    logChannels,
    logCron,
    logReload,
  } = params;
  const {
    minimalTestGateway,
    deps,
    runtimeState,
    kernel,
    startupTrace,
    broadcast,
    broadcastToConnIds,
    clients,
    sharedGatewaySessionGenerationState,
    workerEnvironmentService,
    workerPlacementRuntime,
    terminalLaunchPolicy,
    terminalSessions,
    startChannel,
    stopChannel,
    lifecycle,
    startupState,
    pluginRuntime,
    resolvePluginGatewayContext,
    gatewayTls,
    bindHost,
    getResolvedAuth,
    authRateLimiter,
    browserAuthRateLimiter,
    nodeReapprovalCoordinator,
    gatewayPluginConfigAtStart,
    startupActivationSourceConfig,
    defaultWorkspaceDir,
    pluginManifestRecords,
    pluginMetadataSnapshot,
    ambientEnvTriggers,
    startChannels,
    broadcastPluginEvent,
    controlUiRootLifecycle,
    sidecarStartup,
    cfgAtStart,
    releaseStartupAccountStarts,
    cronReconciliation,
    cronStartState,
    prepareReloadCandidate,
    configSnapshot,
    channelManager,
    activateRuntimeSecrets,
    applyFixedGatewayOverlays,
    resolveSharedGatewaySessionGenerationForConfig,
    stopRegisteredPostReadySidecars,
    registerPostReadySidecars,
    registerGatewayLifetimeSidecars,
    registerConnectionDependentSidecars,
    unregisterConnectionDependentSidecar,
    chatMetadataLifecycle,
    gatewayRequestContext,
    getPluginMetadataSnapshot,
    getPluginNodeCapabilities,
  } = runtime;
  const databaseStartupAdmission = getAgentDatabaseStartupAdmission();
  // F4: mobile boot profile (A1). OFF = upstream behavior; only the
  // early-runtime join deferral (F4(b)) and the human-presence call
  // placement below read this flag. The lazy imports (F4(a)) load at
  // their first-use points in both modes (see the import-block note).
  const mobileBootEnabled = opts.mobileBoot?.enabled ?? false;
  // Fase 1 (fork: Lane F1-I): the early-listen stub bundle, present only
  // when `startGatewayServer` bound the socket pre-kernel (mobile boot
  // ON). Direct `startGatewayServerCore` callers (tests, embedders) have
  // no stub and keep the legacy flow.
  const listenStub = opts.listenStub;
  const databasePreparationReady = createDeferredCore();
  // F1: under the mobile profile, the per-agent admission owner must not
  // migrate before the fleet-wide migration (upstream order: fleet-wide
  // first, pre-listen; per-agent after). The deferred migration runs in
  // parallel with post-attach, so this gate resolves only once BOTH the
  // worker runtime has started AND the deferred migration has settled
  // (either outcome — on failure startup fails below and the close path
  // aborts the waiters). Without a deferred migration the gate behaves
  // exactly as upstream (resolve when the worker runtime starts).
  const deferredSessionMigration = runtime.deferredSessionMigration;
  let workerRuntimeStarted = false;
  let deferredMigrationSettled = deferredSessionMigration === undefined;
  const maybeResolveDatabasePreparation = () => {
    if (workerRuntimeStarted && deferredMigrationSettled) {
      databasePreparationReady.resolve();
    }
  };
  const waitForDeferredSessionMigration = async (): Promise<void> => {
    await deferredSessionMigration?.ready;
  };
  const getReadiness = runtime.createHttpTransportOptions().getReadiness;
  const { attachGatewayWsConnectionHandler } = await startupTrace.measure(
    "gateway.ws-imports",
    () => import("./server/ws-connection.js"),
  );
  if (workerEnvironmentService && !mobileBootEnabled) {
    // F4(a): loaded lazily at first use (same call site as upstream).
    const { startWorkerHumanPresence } = await import("./server/client-human-presence.js");
    await startWorkerHumanPresence({
      clients,
      service: workerEnvironmentService,
      log,
      registerSidecar: registerGatewayLifetimeSidecars,
    });
  }
  await startupTrace.measure("gateway.ws-attach", () =>
    attachGatewayWsConnectionHandler({
      wss: runtime.wss,
      clients,
      connectionWork: runtime.connectionWork,
      bootId: params.bootId,
      preauthConnectionBudget: runtime.preauthConnectionBudget,
      port,
      gatewayHost: bindHost ?? undefined,
      pluginSurfaceScheme: gatewayTls.enabled ? "https" : "http",
      getPluginNodeCapabilities,
      getResolvedAuth,
      getRequiredSharedGatewaySessionGeneration: sharedGatewaySessionGenerationState.reader,
      rateLimiter: authRateLimiter,
      browserRateLimiter: browserAuthRateLimiter,
      nodeReapprovalCoordinator,
      isConnectPending: () => !startupState.dispatchReady,
      startupMethodsReady: kernel.startupMethodsReady,
      isStartupPending: runtime.isGatewayStartupPending,
      isPendingWorkerNodeSetup: workerEnvironmentService?.hasPendingNodeEnrollmentSetup,
      admitsNodeSetupCompletion: workerEnvironmentService?.admitsNodeSetupCompletion,
      gatewayMethods: runtimeState.gatewayMethods,
      events: GATEWAY_EVENTS,
      logGateway: log,
      logHealth,
      logWsControl,
      extraHandlers: runtime.attachedGatewayExtraHandlers,
      getMethodRegistry: () => runtime.getAttachedGatewayMethodRegistry(),
      ...(workerEnvironmentService ? { workerConnectionService: workerEnvironmentService } : {}),
      broadcast,
      refreshHealthSnapshot: gatewayRequestContext.refreshHealthSnapshot,
      buildRequestContext: () => gatewayRequestContext,
    }),
  );
  await startupTrace.measure("http.listen", () => runtime.startListening());
  if (listenStub) {
    // Fase 1: the socket was bound by the stub before the kernel, so a
    // mark here would time `http.bound` minutes late. The true bind span
    // is recorded as the `gateway.listen-stub.bind` bootstrap step
    // (replayed at mark("process.bootstrap")); this detail pins the same
    // instant to the startup timeline with its true timestamps.
    startupTrace.detail("http.bound", [
      ["boundAtMs", listenStub.phase.boundAtMs],
      ["startedAtMs", listenStub.phase.startedAtMs],
    ]);
  } else {
    startupTrace.mark("http.bound");
  }
  // F1: start the deferred fleet-wide session migration now that the
  // socket is bound. It runs in parallel with `runtime.post-attach`
  // below; agent RPCs stay gated (via the delayed `unlockStartupMethods`
  // + the live `/ready` check on it) until `ready` settles, and this
  // function awaits it before marking ready, so a migration failure
  // still fails startup exactly like the upstream pre-listen failure
  // did (N6 — deferred, never skipped).
  // Fase 1 (N14): a settled migration failure must never fail silently.
  // The rejection handler below records the failure (log + pendingReason
  // + trace mark) the moment it settles; the G1 site further down throws
  // when the failure already settled, and `startupSettled` (returned at
  // the end) joins the migration promise so a LATER failure still ends
  // the run loop promptly instead of hanging `/ready` until the Polones
  // 480 s timeout.
  let migrationFailure: { error: unknown } | undefined;
  if (deferredSessionMigration) {
    void deferredSessionMigration.ready.then(undefined, (error: unknown) => {
      migrationFailure = { error };
      startupState.pendingReason = "session-migration-failed";
      if (listenStub) {
        listenStub.phase.pendingReason = "session-migration-failed";
      }
      startupTrace.mark("sessions.migration-failed");
      log.error(`gateway: deferred session migration failed: ${formatErrorMessage(error)}`);
    });
    startDeferredSessionMigration(deferredSessionMigration, {
      cfg: cfgAtStart,
      env: process.env,
      log,
      mobileBoot: runtime.mobileBoot,
      isClosing: () => lifecycle.closePreludeStarted,
      abortSignal: runtime.connectionWork.signal,
      // F9: measure the migration sub-steps, as the bootstrap did.
      measure: (name, run) => startupTrace.measure(name, run),
      // Resolve the per-agent preparation gate once the deferred
      // migration settles (either outcome).
      onSettled: () => {
        deferredMigrationSettled = true;
        maybeResolveDatabasePreparation();
      },
    });
  }
  if (mobileBootEnabled && workerEnvironmentService) {
    // F4(a): presence tracking is best-effort and no client can exist
    // before ws-attach + listen, so installing it here misses no
    // transition (observeClients() picks up already-connected clients);
    // it also keeps this module out of the pre-listen graph.
    const { startWorkerHumanPresence } = await import("./server/client-human-presence.js");
    await startWorkerHumanPresence({
      clients,
      service: workerEnvironmentService,
      log,
      registerSidecar: registerGatewayLifetimeSidecars,
    });
  }
  // Join independent preparation before channels start or failure cleanup retires its owners.
  const requestRuntimeReady = runtime.ensureRequestRuntimeReady().then(async () => {
    // Readiness is also the performance collector's evidence boundary. Flush the
    // terminal events for request-runtime spans before /readyz can become green.
    flushDiagnosticsTimeline();
    kernel.setDispatchReady(true);
    if (databaseStartupAdmission && !opts.updateCanary && !lifecycle.closePreludeStarted) {
      // F4(a): loaded lazily here, after listen — its graph (agent scope,
      // auth-profile sqlite, spawn broker, plugin registry scope) leaves
      // the pre-listen import graph.
      const { activateGatewayAgentDatabaseStartup } = await import(
        "./server-agent-database-startup.js"
      );
      activateGatewayAgentDatabaseStartup({
        admission: databaseStartupAdmission,
        preparationReady: databasePreparationReady.promise,
        waitForPostReadyWork: params.waitForPostReadyWork,
        getConfig: getRuntimeConfig,
        getPluginRegistry: () => pluginRuntime.registry,
        getPluginMetadataSnapshot,
        isCurrent: () => !lifecycle.closePreludeStarted,
        // F1/A4: the per-agent migration runs the same incremental
        // migration as the deferred fleet-wide one (same watermark).
        mobileBoot: runtime.mobileBoot,
        log,
      });
    }
  });
  const earlyRuntimeReady = runtime.startEarlyRuntime();
  if (mobileBootEnabled) {
    // F4(b): start the early runtime concurrently, but do NOT join it
    // before post-attach. /ready still waits for post-attach below, and
    // the early runtime is first needed by post-ready maintenance, where
    // it is joined (see the late join after the ready mark). Skipping
    // the join here also means an early-runtime failure surfaces later
    // (at the late join) instead of before post-attach — the failure
    // still fails startup, only after readiness was published.
    startupTrace.mark("runtime.early.deferred");
    await requestRuntimeReady;
  } else {
    await Promise.allSettled([requestRuntimeReady, earlyRuntimeReady]);
    await requestRuntimeReady;
  }
  const sessionDeliveryRecoveryMaxEnqueuedAt = Date.now();
  let postAttachRuntimeReturned = false;
  let scheduledServicesActivated = false;
  const activateScheduledServicesWhenReady = () => {
    if (
      opts.updateCanary ||
      lifecycle.closePreludeStarted ||
      !postAttachRuntimeReturned ||
      !startupState.sidecarsReady ||
      scheduledServicesActivated
    ) {
      return;
    }
    scheduledServicesActivated = true;
    void import("./server-runtime-services.js").then((gatewayRuntimeServices) => {
      if (lifecycle.closePreludeStarted) {
        return;
      }
      const activated = gatewayRuntimeServices.activateGatewayScheduledServices({
        scheduler: runtime.scheduler,
        minimalTestGateway,
        cfgAtStart,
        deps,
        sessionDeliveryRecoveryMaxEnqueuedAt,
        log,
        resolveGatewayContext: resolvePluginGatewayContext,
      });
      kernel.setScheduledServiceHandles(activated);
    });
  };
  const { startGatewayActiveWork } = await startupTrace.measure(
    "gateway.active-work-import",
    () => import("./server-work-metrics.js"),
  );
  const activeWorkInspectors = startGatewayActiveWork(runtime, log);
  const trackStartupWork = <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    // Register before starting, without lending the connection scope to long-lived services.
    const operation = Promise.resolve().then(() => run(runtime.connectionWork.signal));
    return runtime.connectionWork.track(() => operation);
  };
  // F5 (mobile boot): ids of the startup plugins deferred to the
  // background load after /ready (filled in by loadStartupPlugins when
  // the mobile boot profile is enabled; empty otherwise).
  let deferredStartupPluginIds: string[] = [];
  const postAttachHandles = await trackStartupWork(() =>
    startupTrace.measure("runtime.post-attach", () =>
      import("./server-startup-post-attach.js").then(({ startGatewayPostAttachRuntime }) =>
        startGatewayPostAttachRuntime({
          scheduler: runtime.scheduler,
          minimalTestGateway,
          // F5 (mobile boot): resolved mobile boot profile, threaded from
          // the Gateway server options.
          mobileBoot: runtime.mobileBoot,
          updateCanary: opts.updateCanary,
          cfgAtStart,
          getConfig: getRuntimeConfig,
          port,
          log,
          isNixMode,
          startupStartedAt: opts.startupStartedAt,
          broadcastToConnIds,
          broadcast,
          getClientConnIds: gatewayRequestContext.getClientConnIds!,
          broadcastPluginEvent,
          controlUiRootLifecycle,
          gatewayPluginConfigAtStart,
          activationSourceConfig: startupActivationSourceConfig,
          pluginManifestRecords,
          ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
          getCurrentPluginRegistry: () => pluginRuntime.registry,
          shouldStartPluginServices: () =>
            kernel.pluginRuntimeGeneration.currentServices() === null &&
            kernel.pluginRuntimeGeneration.getReloadStatus() === undefined,
          // F5 (mobile boot): deferred services start unless a plugin
          // reload is in progress (unlike shouldStartPluginServices,
          // which is false once the first services handle exists).
          shouldStartDeferredPluginServices: () =>
            kernel.pluginRuntimeGeneration.getReloadStatus() === undefined,
          ambientEnvTriggers,
          pluginRegistry: pluginRuntime.registry,
          defaultWorkspaceDir,
          deps,
          startChannels,
          resolveGatewayContext: gatewayRequestContext.resolveGatewayContext!,
          logHooks,
          logChannels,
          unlockStartupMethods: async () => {
            // F1: agent RPCs (`chat.send`/`agent`, in
            // `STARTUP_UNAVAILABLE_GATEWAY_METHODS`) stay unavailable until
            // the deferred session migration settles — the same per-RPC
            // gate upstream already enforces before sidecars are ready
            // (retryable `UNAVAILABLE` with `startup-sidecars` details).
            // Without a deferred migration this is a straight pass-through.
            await waitForDeferredSessionMigration();
            await kernel.unlockStartupMethods();
          },
          refreshChatMetadata: chatMetadataLifecycle.refresh,
          loadStartupPlugins: async () => {
            const { loadGatewayStartupPluginRuntime } = await import("./server-startup-plugins.js");
            const loaded = await loadGatewayStartupPluginRuntime({
              cfg: gatewayPluginConfigAtStart,
              signal: runtime.connectionWork.signal,
              activationSourceConfig: startupActivationSourceConfig,
              workspaceDir: runtime.pluginWorkspaceDir,
              log,
              baseMethods: runtime.baseMethods,
              coreGatewayMethodNames: runtime.coreGatewayMethodNames,
              hostServices: runtime.pluginHostServices,
              startupPluginIds: runtime.startupPluginIds,
              pluginLookUpTable: runtime.pluginLookUpTable,
              startupTrace,
              ambientEnvTriggers,
              // F5 (mobile boot): async-only generation capture during
              // boot; the split returns the plugins deferred to the
              // background load after /ready.
              mobileBoot: runtime.mobileBoot,
              resolveGatewayContext: resolvePluginGatewayContext,
            });
            deferredStartupPluginIds = loaded.deferredPluginIds;
            return loaded;
          },
          // F5 (mobile boot): background load of the deferred startup
          // plugins, additive on top of the already-attached essential
          // registry (unchanged records are retained, never reloaded).
          // Runs after /ready; see startGatewayPostAttachRuntime.
          loadDeferredStartupPlugins: async () => {
            if (deferredStartupPluginIds.length === 0) {
              return null;
            }
            const { loadGatewayStartupPluginRuntime } = await import("./server-startup-plugins.js");
            return loadGatewayStartupPluginRuntime({
              cfg: gatewayPluginConfigAtStart,
              signal: runtime.connectionWork.signal,
              activationSourceConfig: startupActivationSourceConfig,
              workspaceDir: runtime.pluginWorkspaceDir,
              log,
              baseMethods: runtime.baseMethods,
              coreGatewayMethodNames: runtime.coreGatewayMethodNames,
              hostServices: runtime.pluginHostServices,
              // Full plan: essentials are retained from the previous
              // registry, only the deferred ids load fresh.
              startupPluginIds: runtime.startupPluginIds,
              pluginLookUpTable: runtime.pluginLookUpTable,
              startupTrace,
              ambientEnvTriggers,
              mobileBoot: runtime.mobileBoot,
              previousRegistry: pluginRuntime.registry,
              resolveGatewayContext: resolvePluginGatewayContext,
            });
          },
          onStartupPluginsLoading: () => {
            startupState.pendingReason = "startup-sidecars";
          },
          onStartupPluginsLoaded: async (loaded) => {
            const activationCleanup: Promise<void>[] = [];
            const prepared = await runtime.prepareAttachedPluginRuntime(loaded, (completion) =>
              activationCleanup.push(completion),
            );
            try {
              if (lifecycle.closePreludeStarted) {
                return false;
              }
              prepared.publish();
              startupState.pendingReason = "startup-sidecars";
              prepared.afterCommit();
              // Nodes can finish their handshake before deferred plugins attach.
              // F4(a): loaded lazily here (post-attach) — its graph
              // (capability tokens, scoped hosts) leaves the pre-listen graph.
              const {
                indexPluginNodeCapabilitySurfaces,
                reconcileClientPluginNodeCapabilities,
              } = await import("./plugin-node-capability.js");
              const nodeCapabilitySurfaces = indexPluginNodeCapabilitySurfaces(
                getPluginNodeCapabilities(),
              );
              for (const client of clients) {
                reconcileClientPluginNodeCapabilities(client, nodeCapabilitySurfaces);
              }
              await runtime.refreshAttachedGatewayDiscovery(loaded.pluginRegistry);
              return true;
            } finally {
              await Promise.allSettled(activationCleanup);
            }
          },
          getCronService: kernel.getCronService,
          onChannelsStarted: releaseStartupAccountStarts,
          onPluginServices: (pluginServices) =>
            kernel.pluginRuntimeGeneration.setServices(pluginServices),
          onPostReadySidecars: registerPostReadySidecars,
          onGatewayLifetimeSidecars: registerGatewayLifetimeSidecars,
          trackStartupWork,
          unregisterConnectionDependentSidecar,
          startWorkerEnvironmentRuntime: async () => {
            if (lifecycle.closePreludeStarted) {
              return null;
            }
            // Plugins are attached; worker recovery awaits admission — and,
            // under the mobile profile, the deferred fleet-wide migration
            // (F1): see `maybeResolveDatabasePreparation` above.
            workerRuntimeStarted = true;
            maybeResolveDatabasePreparation();
            return workerPlacementRuntime
              ? await workerPlacementRuntime.startRuntime({
                  startupTrace,
                  isClosePreludeStarted: () => lifecycle.closePreludeStarted,
                  // Close must see the drain handle before reconciliation can yield.
                  registerSidecar: registerConnectionDependentSidecars,
                  unregisterSidecar: unregisterConnectionDependentSidecar,
                })
              : null;
          },
          onSidecarsReady: () => {
            kernel.markSidecarsReady();
            activateScheduledServicesWhenReady();
          },
          getReadiness,
          isClosing: () => lifecycle.closePreludeStarted,
          startupTrace,
          sidecarStartup,
          waitForPostReadyWork: params.waitForPostReadyWork,
          activeWorkInspectors,
        }),
      ),
    ),
  );
  kernel.setPostAttachHandles(postAttachHandles);
  if (minimalTestGateway) {
    databasePreparationReady.resolve();
  }
  // Fase 1 (Opsi A, D-2): G1 removed. `/ready` no longer awaits the
  // migration here — it is already gated on it by G2/G3
  // (`unlockStartupMethods` awaits the migration before `chat.send`
  // unlocks, and the readiness checker reports `chat-startup` until
  // then), so this await only re-imposed the same wait. The migration
  // still runs (started above, in parallel with post-attach) and its
  // failure still fails startup: a failure that already settled throws
  // here, fail-fast; a later failure rejects `startupSettled` below,
  // which ends the run loop (exit 1 on first start) instead of hanging
  // `/ready` until the Polones timeout (N14). `preparationReady` (the
  // per-agent admission gate, resolved from the same settlement via
  // `onSettled`) is unaffected — it still resolves only once the worker
  // runtime started AND the migration settled.
  if (migrationFailure && deferredSessionMigration && !lifecycle.closePreludeStarted) {
    throw migrationFailure.error;
  }
  startupTrace.detail("memory.ready", [
    ...collectGatewayProcessMemoryUsageMb(),
    ...(minimalTestGateway
      ? []
      : await startupTrace.measure("runtime.worker-pool-metrics", collectGatewayWorkerPoolMetrics)),
  ]);
  const preparedReadiness = await getReadiness.prepare();
  if (!lifecycle.closePreludeStarted && preparedReadiness.publish().ready) {
    startupTrace.mark("ready");
    if (listenStub) {
      // Fase 1 (Opsi A, D-2): hand the stub socket to the full handler
      // now that `/ready` means "can chat". Before this point the stub
      // kept answering 503 starting for non-probe paths; from here the
      // Control UI and chat serve through the full handler. The swap is
      // a single ref assignment (no rebind, no dropped socket).
      runtime.activateFullHttpHandler?.();
      listenStub.phase.status = "ready";
      listenStub.phase.pendingReason = "ready";
      startupTrace.detail("listen.stub-to-ready", [
        ["bindToReadyMs", Date.now() - listenStub.phase.boundAtMs],
      ]);
      void import("./server/listen-registration.js")
        .then(({ updateGatewayRegistrationStatus }) =>
          updateGatewayRegistrationStatus({ status: "ready" }),
        )
        .catch(() => {});
    }
    if (sidecarStartup === "defer") {
      log.info("gateway ready");
    }
  }
  finishGatewayRestartTrace("restart.ready", collectGatewayProcessMemoryUsageMb());
  // F4(b): late join of the deferred early runtime — the first point
  // after post-attach on every path (canary, minimal-test, and normal
  // all pass through here). /ready was already published above, so this
  // never delays readiness. In OFF mode the promise is already settled
  // (joined before post-attach); this await is free.
  const earlyRuntime = await earlyRuntimeReady;
  if (mobileBootEnabled) {
    // Post-attach may have run before the early runtime installed
    // discovery, so its refreshAttachedGatewayDiscovery call inside
    // onStartupPluginsLoaded was a no-op (discovery still null). Re-run
    // it now with the current (post-publish) registry — idempotent: a
    // second update with the same services is a no-op for discovery.
    await runtime.refreshAttachedGatewayDiscovery(pluginRuntime.registry);
    startupTrace.mark("runtime.early.discovery-refreshed");
  }
  if (opts.updateCanary) {
    // Copied queues and jobs must not resume; the canary owns only startup probes.
    return { startupSettled: postAttachHandles.startupSettled };
  }
  postAttachRuntimeReturned = true;
  activateScheduledServicesWhenReady();

  const { startManagedGatewayConfigReloader } = await import("./server-reload-managed.js");
  // F4(a): loaded lazily here, post-ready. The reloader contract keeps
  // this closure synchronous ((config, env?) => void — see
  // server-reload-contracts.ts), so the module is imported once here,
  // before the closure is built — not inside it.
  const { assertGatewayRuntimeSecurityConfig } = await import("./server-runtime-config.js");
  const assertRuntimeSecurityConfig = (cfg: OpenClawConfig, env?: NodeJS.ProcessEnv) => {
    assertGatewayRuntimeSecurityConfig({
      cfg,
      port,
      bindHost,
      controlUiEnabled: opts.controlUiEnabled ?? cfg.gateway?.controlUi?.enabled ?? true,
      tailscaleMode: runtime.tailscaleMode,
      resolvedAuth: resolveGatewayAuth({
        authConfig: cfg.gateway?.auth,
        tailscaleMode: runtime.tailscaleMode,
        env,
      }),
    });
  };
  // F4(a): loaded lazily here, post-ready — its graph (infra/tls/gateway)
  // leaves the pre-listen import graph.
  const { startGatewayTlsRenewal } = await import("./server-tls-renewal.js");
  const tlsRenewal = startGatewayTlsRenewal({
    scheduler: runtime.scheduler,
    runtime: gatewayTls,
    servers: runtime.httpServers,
    enabled: cfgAtStart.gateway?.reload?.mode !== "off",
    onRenewed: async () =>
      runtimeState.discovery?.update({
        gatewayTlsFingerprintSha256: gatewayTls.fingerprintSha256,
      }),
    log: log.child("tls"),
  });
  if (tlsRenewal) {
    registerGatewayLifetimeSidecars(tlsRenewal);
  }
  let appliedCustomPluginUiEnabled = isCustomPluginUiEnabled(gatewayPluginConfigAtStart);
  const configReloaderParams: Parameters<typeof startManagedGatewayConfigReloader>[0] = {
    scheduler: runtime.scheduler,
    onReloadEnabledChange: tlsRenewal?.setEnabled,
    configRevisionProjector: gatewayRequestContext.configRevisionProjector,
    resolveGatewayContext: resolvePluginGatewayContext,
    minimalTestGateway,
    // Preserve the published startup authority, including plugin activation or a no-op publish.
    initialConfig: getRuntimeConfig(),
    initialPluginInstallRecords: pluginMetadataSnapshot?.index.installRecords,
    initialCompareConfig: configSnapshot.sourceConfig,
    initialSnapshotRawHash: configSnapshot.exists ? hashConfigRaw(configSnapshot.raw) : null,
    initialAuthoredConfig: configSnapshot.parsed,
    initialIncludedPaths: configSnapshot.includedPaths ?? [],
    initialSnapshotValid: configSnapshot.valid,
    initialSnapshotIssues: configSnapshot.issues,
    watchPath: configSnapshot.path,
    readSnapshot: readConfigFileSnapshotForRuntimeTransaction,
    promoteSnapshot: promoteConfigSnapshotToLastKnownGood,
    subscribeToWrites: (listener) =>
      registerConfigWriteListener(listener, {
        ownsRuntimeActivationFor: configSnapshot.path,
        preCommitRuntimePreflight: async (sourceConfig, runtimeRefresh) => {
          const candidate = await prepareReloadCandidate({
            runtimeConfig: sourceConfig,
            sourceConfig,
          });
          const prepared = await activateRuntimeSecrets(candidate.runtimeConfig, {
            reason: "reload",
            activate: false,
            env: candidate.runtimeEnv.env,
            includeAuthStoreRefs: runtimeRefresh?.includeAuthStoreRefs,
          });
          const previousConfig = getRuntimeConfig();
          // Runtime defaults and startup overlays are not authored changes; they
          // must not classify a hot write as a restart and bypass this validation.
          // F4(a): loaded lazily here (config-write path, post-ready) —
          // the reload-plan graph (channel plugins, plugin runtime)
          // leaves the pre-listen import graph.
          const { buildGatewayReloadPlan, listConfigReloadRefinementPrefixes } = await import(
            "./config-reload-plan.js"
          );
          const { diffGatewayReloadPaths } = await import("./config-diff.js");
          const plan = buildGatewayReloadPlan(
            diffGatewayReloadPaths(
              getRuntimeConfigSourceSnapshot() ?? configSnapshot.sourceConfig,
              sourceConfig,
              listConfigReloadRefinementPrefixes(),
            ),
            { previousConfig, candidateConfig: prepared.config },
          );
          if (runtimeRefresh?.requireImmediateApplication) {
            if (prepared.config.gateway?.reload?.mode === "off") {
              throw new Error(
                "The saved sign-in is inactive because Gateway reload is disabled. Enable config reload and restart the Gateway before retrying it.",
              );
            }
            if (plan.restartGateway || plan.reloadPlugins) {
              throw new Error(
                plan.reloadPlugins
                  ? "Update or enable the selected provider plugin in Plugins, then retry this saved sign-in. Your current connection is unchanged."
                  : "Apply the required Gateway settings update separately, then retry this saved sign-in. Your current connection is unchanged.",
              );
            }
          }
          if (!plan.restartGateway) {
            assertRuntimeSecurityConfig(prepared.config, candidate.runtimeEnv.env);
          }
          return candidate;
        },
      }),
    deps,
    broadcast,
    getState: kernel.getReloadState,
    setState: (nextState) => {
      kernel.setReloadHookState(nextState);
      const previousCronState = kernel.swapCronState(nextState.cronState);
      if (previousCronState !== nextState.cronState) {
        cronStartState.handled = true;
      }
    },
    getPluginMetadataSnapshot,
    getPluginRegistry: () => runtime.pluginRuntime.registry,
    startChannel,
    stopChannel,
    getChannelAutostartSuppression: channelManager.getAutostartSuppression,
    stopPostReadySidecars: stopRegisteredPostReadySidecars,
    reloadPlugins: kernel.reloadPlugins,
    reloadPluginServices: async (config, serviceIds) => {
      const services = runtimeState.pluginServices;
      if (!services) {
        throw new Error("Plugin services are not attached");
      }
      await services.reload(config, serviceIds);
    },
    logHooks,
    logChannels,
    logCron,
    logReload,
    cronReconciliation,
    onCronRestart: () => {
      cronStartState.handled = true;
    },
    prepareTerminalConfig: (plan, nextConfig) => {
      terminalLaunchPolicy.prepareConfig(nextConfig, { restartPending: plan.restartGateway });
    },
    reconcileRuntimePolicy: async (nextConfig, phase) => {
      terminalSessions.closeDisallowedAgents((agentId) => terminalLaunchPolicy.resolve(agentId).ok);
      if (phase !== "committed") {
        return;
      }
      // F4(a): loaded lazily here (reload-commit path, post-ready) —
      // the node-surface and ws-origin-policy graphs leave the
      // pre-listen import graph.
      const { disconnectDisallowedGatewayPolicyClients } = await import(
        "./server/ws-origin-policy.js"
      );
      const { refreshConnectedNodeSurfaceCaches } = await import(
        "./server-methods/nodes.read.js"
      );
      terminalSessions.updateDetachGraceMs(
        (nextConfig.gateway?.terminal?.detachedSessionTimeoutSeconds ??
          DEFAULT_TERMINAL_DETACH_SECONDS) * 1000,
      );
      disconnectDisallowedGatewayPolicyClients(clients.authorityClients, nextConfig);
      for (const nodeSession of runtime.nodeRegistry.refreshRuntimePolicy(nextConfig)) {
        refreshConnectedNodeSurfaceCaches({ context: gatewayRequestContext, nodeSession });
      }
      const reconciled = await Promise.allSettled([
        runtime.hostDesktopService.reconcileRuntimePolicy(),
        runtime.gatewayComputerService.reconcileRuntimePolicy(),
        workerEnvironmentService?.reconcileDesktopPolicy(),
        runtime.nodeDesktopService.reconcileRuntimePolicy(),
        runtimeState.discovery?.update({ mdnsMode: nextConfig.discovery?.mdns?.mode }),
        (async () => {
          const customPluginUiEnabled = isCustomPluginUiEnabled(nextConfig);
          if (customPluginUiEnabled !== appliedCustomPluginUiEnabled) {
            const { listControlUiPluginCatalog } = await import("./control-ui-plugin-assets.js");
            const catalog = await listControlUiPluginCatalog();
            broadcast("plugins.controlUi.changed", { revision: catalog.revision });
            appliedCustomPluginUiEnabled = customPluginUiEnabled;
          }
        })(),
      ]);
      const failed = reconciled.find((result) => result.status === "rejected");
      if (failed) {
        throw failed.reason;
      }
    },
    commitRuntimePolicy: (nextConfig) => {
      controlUiRootLifecycle.setEnabled(
        opts.controlUiEnabled ?? nextConfig.gateway?.controlUi?.enabled ?? true,
      );
      runtime.configureDiagnostics(nextConfig);
      runtimeState.reconcileAuditPolicy?.(nextConfig);
      const rateLimit = nextConfig.gateway?.auth?.rateLimit;
      authRateLimiter.updateConfig(rateLimit);
      browserAuthRateLimiter.updateConfig({ ...rateLimit, exemptLoopback: false });
      nodeReapprovalCoordinator.updateConfig(rateLimit);
      terminalLaunchPolicy.commitConfig();
      workerEnvironmentService?.schedulePreparedRefill();
    },
    acceptTerminalConfig: terminalLaunchPolicy.acceptConfig,
    channelManager,
    activateRuntimeSecrets,
    assertRuntimeSecurityConfig,
    prepareConfigCandidate: prepareReloadCandidate,
    applyRuntimeConfigOverrides: applyFixedGatewayOverlays,
    resolveSharedGatewaySessionGenerationForConfig,
    sharedGatewaySessionGenerationState,
    clients,
    ...(opts.hotReloadRecovery ? { requestRecoveryRestart: opts.hotReloadRecovery } : {}),
    restartRecoveryAvailable: opts.hotReloadRecovery !== undefined,
  };
  if (lifecycle.closePreludeStarted) {
    return { startupSettled: postAttachHandles.startupSettled };
  }
  const configReloader = startManagedGatewayConfigReloader(configReloaderParams);
  kernel.setConfigReloaderHandle(configReloader);
  await configReloader.ready;
  if (lifecycle.closePreludeStarted) {
    return { startupSettled: postAttachHandles.startupSettled };
  }
  await promoteConfigSnapshotToLastKnownGood(configSnapshot).catch((err: unknown) => {
    log.warn(`gateway: failed to promote config last-known-good backup: ${String(err)}`);
  });
  if (!minimalTestGateway) {
    const gatewayRuntimeServices = await import("./server-runtime-services.js");
    gatewayRuntimeServices.scheduleGatewayPostReadyMaintenance({
      scheduler: runtime.scheduler,
      signal: runtime.connectionWork.signal,
      delayMs: POST_READY_MAINTENANCE_DELAY_MS,
      isClosing: () => lifecycle.closePreludeStarted,
      waitForPostReadyWork: params.waitForPostReadyWork,
      startupMaintenance: runtime,
      startMaintenance: () =>
        earlyRuntime.startMaintenance(activeWorkInspectors, resolvePluginGatewayContext),
      applyMaintenance: async (maintenance) => {
        if (lifecycle.closePreludeStarted) {
          await clearGatewayMaintenanceHandles(maintenance);
          return;
        }
        // Publish the stop owner before cleanup can touch SQLite or state paths;
        // shutdown may begin immediately after this synchronous handoff.
        kernel.setMaintenanceHandles(maintenance);
        maintenance.startMediaCleanup();
      },
      shouldStartCron: () => !lifecycle.closePreludeStarted && !cronStartState.handled,
      markCronStartHandled: () => {
        cronStartState.handled = true;
      },
      cronState: runtimeState.cronState,
      cronReconciliation,
      cronConfig: cfgAtStart,
      logCron,
      log,
      recordPostReadyMemory: () => {
        startupTrace.detail("memory.post-ready", collectGatewayProcessMemoryUsageMb());
      },
    });
    // This Gateway may still import boot-generation code after an install retires
    // it. Capture those paths before the idle delay; cleanup also protects the new ledger.
    const startupInstallPaths = [
      ...Object.values(pluginMetadataSnapshot?.index.installRecords ?? {}).flatMap((record) =>
        record.installPath ? [record.installPath] : [],
      ),
      ...(pluginMetadataSnapshot?.plugins.flatMap((record) =>
        record.setupSource
          ? [record.rootDir, record.source, record.setupSource]
          : [record.rootDir, record.source],
      ) ?? []),
    ];
    registerGatewayLifetimeSidecars(
      gatewayRuntimeServices.scheduleGatewayIdleTask({
        id: "maintenance:retained-plugin-generations",
        scheduler: runtime.scheduler,
        delayMs: RETAINED_PLUGIN_CLEANUP_DELAY_MS,
        retryDelayMs: RETAINED_PLUGIN_CLEANUP_DELAY_MS,
        repeatDelayMs: 60 * 60_000,
        isClosing: () => lifecycle.closePreludeStarted,
        isBusy: () => getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0,
        run: async () => {
          await params.waitForPostReadyWork();
          const { cleanupGatewayRetiredPluginArtifacts } =
            await import("./server-retained-plugin-cleanup.js");
          await cleanupGatewayRetiredPluginArtifacts({
            log,
            startupInstallPaths,
            signal: runtime.connectionWork.signal,
            assertCurrent: () => {
              if (lifecycle.closePreludeStarted) {
                throw runtime.connectionWork.signal.reason ?? new Error("Gateway is closing");
              }
            },
          });
        },
        log,
        errorMessage: "retained npm generation cleanup failed",
      }),
    );
    registerGatewayLifetimeSidecars(
      gatewayRuntimeServices.scheduleGatewayIdleTask({
        id: "maintenance:sqlite-snapshots",
        scheduler: runtime.scheduler,
        delayMs: RETAINED_PLUGIN_CLEANUP_DELAY_MS,
        retryDelayMs: RETAINED_PLUGIN_CLEANUP_DELAY_MS,
        isClosing: () => lifecycle.closePreludeStarted,
        isBusy: () => getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0,
        repeatDelayMs: 15 * 60_000,
        run: async () => {
          const { reclaimAbandonedSqliteSnapshotsAsync } =
            await import("../infra/sqlite-snapshot-reclamation.js");
          await reclaimAbandonedSqliteSnapshotsAsync();
        },
        log,
        errorMessage: "SQLite snapshot staging cleanup failed",
      }),
    );
  } else {
    startupTrace.detail("memory.post-ready", collectGatewayProcessMemoryUsageMb());
  }
  // Fase 1 (N14, Opsi A): join the migration promise into
  // `startupSettled` on the FINAL return only — the canary and close
  // returns above keep their original `startupSettled` (they must not
  // wait on work that never starts in those paths). `Promise.all`
  // rejects as soon as ANY input rejects, so a migration that settles
  // with a failure AFTER the G1 site above rejects `startupSettled`
  // promptly, and the run loop (which awaits it with reject) ends the
  // process (exit 1 on first start) instead of leaving `/ready`
  // hanging until the Polones 480 s timeout. The migration promise
  // already has its rejection handler attached at the G1 site, so no
  // unhandled rejection can leak from either side.
  const startupSettled =
    deferredSessionMigration && !lifecycle.closePreludeStarted
      ? Promise.all([postAttachHandles.startupSettled, deferredSessionMigration.ready]).then(
          () => undefined,
        )
      : postAttachHandles.startupSettled;
  return { startupSettled };
}
