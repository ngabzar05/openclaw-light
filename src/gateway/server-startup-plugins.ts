import { tryResolveConfiguredAgentWorkspaceDir } from "../agents/agent-scope.js";
import { getConfiguredDecisionProviderIds } from "../agents/decision-model-setting.js";
import { collectConfiguredAgentHarnessRuntimes } from "../agents/harness-runtimes.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace-default.js";
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import { validateConfiguredBindings } from "../channels/plugins/configured-binding-registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessageWithCode } from "../infra/errors.js";
import {
  collectConfiguredMemoryEmbeddingStartupProviderOwners,
  collectRegisteredEmbeddingProviderIds,
  collectUnregisteredConfiguredMemoryEmbeddingProviders,
  listAmbientOnlyConfiguredChannelIds,
} from "../plugins/channel-plugin-ids.js";
import { listGatewayActivatedChannelIds } from "../plugins/channel-presence-policy.js";
import { normalizePluginsConfigWithResolverCore } from "../plugins/config-normalization-shared.js";
import { withContextEngineOwner } from "../plugins/config-state.js";
import { getGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { getRegisteredEmbeddingProvider } from "../plugins/embedding-providers.js";
import {
  manifestOwnsConfiguredContract,
  manifestOwnsConfiguredContractGroup,
} from "../plugins/gateway-startup-plugin-activation.js";
import {
  hasConfiguredActivationPath,
  resolveContextEngineSlotStartupPluginId,
  resolveMemorySlotStartupPluginId,
} from "../plugins/gateway-startup-plugin-config.js";
import {
  collectConfiguredAgentModelProviderIds,
  collectConfiguredGenerationProviderIds,
  collectConfiguredMemoryEmbeddingProviderIds,
  collectConfiguredVoiceProviderIds,
  collectConfiguredWebSearchProviderIds,
  manifestOwnsConfiguredModelProvider,
} from "../plugins/gateway-startup-plugin-providers.js";
import { collectConfiguredSpeechProviderIds } from "../plugins/gateway-startup-speech-providers.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "../plugins/installed-plugin-index-install-records.js";
import { loadPluginLookUpTable, type PluginLookUpTable } from "../plugins/plugin-lookup-table.js";
import {
  completePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
import { createPluginRegistryIdNormalizer } from "../plugins/plugin-registry-contributions.js";
import { resolveProviderPolicySurfaceForOwner } from "../plugins/provider-public-artifacts.js";
import {
  markPluginRegistryActive,
  withPluginRegistryPreparationScope,
} from "../plugins/registry-lifecycle.js";
import type { PluginRegistry, PluginRegistryParams } from "../plugins/registry-types.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { disposePluginRegistryInstances, getActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  getPluginRuntimeLoadContext,
  setPluginRuntimeLoadContext,
} from "../plugins/runtime/load-context.js";
import {
  collectConfiguredStorageProviderIds,
  manifestOwnsStorageProvider,
} from "../plugins/storage-provider-manifest.js";
import { collectConfiguredWorkerProviderIds } from "../plugins/worker-provider-config.js";
import { normalizeWorkerProviderIds } from "../plugins/worker-provider-id.js";
import { manifestOwnsWorkerProvider } from "../plugins/worker-provider-manifest.js";
import type { MobileBootOptions } from "./mobile-boot.js";
import { resolveGatewayStartupPluginActivationConfig } from "./plugin-activation-runtime-config.js";
import { listGatewayMethods } from "./server-methods-list.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { measureStartup, type GatewayStartupTrace } from "./server-startup-trace.js";

type GatewayPluginBootstrapLog = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug: (message: string) => void;
};

/** Best-effort repair runs under the Gateway's existing post-ready maintenance lifetime. */
export async function runGatewayPostReadyStartupMaintenance(params: {
  getConfig: () => OpenClawConfig;
  getPluginRegistry: () => PluginRegistry;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "registrySource">;
  databases: readonly import("./server-startup-session-migration.js").PreparedStartupSessionDatabase[];
  signal: AbortSignal;
  log: Pick<GatewayPluginBootstrapLog, "info" | "warn">;
  startupTrace?: GatewayStartupTrace;
}): Promise<void> {
  const tasks = [
    [
      "plugin-registry",
      async () => {
        if (params.pluginMetadataSnapshot?.registrySource !== "derived") {
          return;
        }
        const [{ withPluginLifecycleLeaseAsync }, { refreshPluginRegistryAfterConfigMutation }] =
          await Promise.all([
            import("../plugins/plugin-lifecycle-lease.js"),
            import("../plugins/registry-refresh.js"),
          ]);
        await withPluginLifecycleLeaseAsync(
          {
            signal: params.signal,
            assertCurrent: () => params.signal.throwIfAborted(),
            processBound: true,
          },
          (lease) =>
            refreshPluginRegistryAfterConfigMutation({
              reason: "source-changed",
              lease,
              invalidateRuntimeCache: false,
              logger: params.log,
            }),
        );
      },
    ],
    [
      "channels",
      async () => {
        const { runChannelPluginStartupMaintenance } =
          await import("../channels/plugins/lifecycle-startup.js");
        params.signal.throwIfAborted();
        await withPluginRuntimeRegistryScope(params.getPluginRegistry(), () =>
          runChannelPluginStartupMaintenance({
            cfg: params.getConfig(),
            env: process.env,
            log: params.log,
          }),
        );
      },
    ],
    [
      "sessions",
      async () => {
        const { runGatewaySessionStartupMaintenance } =
          await import("./server-startup-session-migration.js");
        params.signal.throwIfAborted();
        await runGatewaySessionStartupMaintenance(params);
      },
    ],
    [
      "pairing",
      async () => {
        const { listLegacyPairingStoreFiles } = await import("../infra/pairing-files.js");
        params.signal.throwIfAborted();
        const files = await listLegacyPairingStoreFiles();
        if (files.length > 0) {
          params.log.warn(
            `Legacy pairing stores require repair: ${files.join(", ")}. Stop the Gateway and run openclaw doctor --fix.`,
          );
        }
      },
    ],
  ] as const;
  await Promise.all(
    tasks.map(async ([name, run]) => {
      try {
        params.signal.throwIfAborted();
        await measureStartup(params.startupTrace, `startup.maintenance.${name}`, run);
      } catch (error) {
        if (!params.signal.aborted) {
          params.log.warn(
            `Gateway post-ready ${name} maintenance failed: ${formatErrorMessageWithCode(error)}`,
          );
        }
      }
    }),
  );
}

/** Builds plugin startup state and gateway method lists before the server binds. */
export async function prepareGatewayPluginBootstrap(params: {
  cfgAtStart: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  workerProviderIds?: readonly string[];
  minimalTestGateway: boolean;
  log: GatewayPluginBootstrapLog;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
  /** F9 startup trace; when absent the plan steps run unmeasured. */
  startupTrace?: GatewayStartupTrace;
  /**
   * A3 (mobile boot): resolved mobile boot profile + Gateway state dir.
   * The resolved startup plugin plan is cached under
   * `<stateDir>/cache/startup-plugin-plan.json` only when the profile is
   * enabled; absent = upstream behavior (resolve the plan every boot).
   */
  mobileBoot?: MobileBootOptions;
  stateDir?: string;
}) {
  const activationSourceConfig = params.activationSourceConfig ?? params.cfgAtStart;

  // Activation uses the pre-runtime source so auto-enable policy cannot be skewed by
  // defaults injected while loading runtime config; runtime-only plugin config still merges in.
  // F9: this is the `plugin-config` step of the LAB baseline (activation
  // resolution, before the lookup table is built).
  const gatewayPluginConfig = params.minimalTestGateway
    ? params.cfgAtStart
    : await measureStartup(params.startupTrace, "plugins.bootstrap.activation-config", () =>
        resolveGatewayStartupPluginActivationConfig({
          runtimeConfig: params.cfgAtStart,
          activationSourceConfig,
          env: process.env,
          ...(params.pluginMetadataSnapshot?.manifestRegistry
            ? { manifestRegistry: params.pluginMetadataSnapshot.manifestRegistry }
            : {}),
          discovery: params.pluginMetadataSnapshot?.discovery,
          ambientEnvTriggers: params.ambientEnvTriggers,
        }),
      );
  const pluginsGloballyDisabled = gatewayPluginConfig.plugins?.enabled === false;
  const pluginWorkspaceDir = tryResolveConfiguredAgentWorkspaceDir(gatewayPluginConfig);
  const defaultWorkspaceDir = pluginWorkspaceDir ?? resolveDefaultAgentWorkspaceDir();
  // F9: the lookup table (manifest registry + startup plan, incl.
  // `loadGatewayStartupPluginPlanWithMetadata`) is the bulk of the
  // `plugin-config` step; measure it apart from activation resolution.
  const pluginLookUpTable =
    params.minimalTestGateway || pluginsGloballyDisabled
      ? undefined
      : await measureStartup(params.startupTrace, "plugins.bootstrap.lookup-table", () =>
          loadPluginLookUpTable({
            config: gatewayPluginConfig,
            workspaceDir: pluginWorkspaceDir,
            env: process.env,
            activationSourceConfig,
            metadataSnapshot: params.pluginMetadataSnapshot,
            workerProviderIds: params.workerProviderIds ?? [],
            ambientEnvTriggers: params.ambientEnvTriggers,
            // A3 (mobile boot): cache the resolved startup plugin plan.
            ...(params.mobileBoot !== undefined ? { mobileBoot: params.mobileBoot } : {}),
            ...(params.stateDir !== undefined ? { stateDir: params.stateDir } : {}),
          }),
        );
  // Startup logging and lifecycle publication consume the process-stable metadata snapshot.
  // Minimal gateways skip runtime lookup-table construction, not metadata ownership.
  const pluginManifestRecords =
    pluginLookUpTable?.manifestRegistry.plugins ??
    params.pluginMetadataSnapshot?.manifestRegistry.plugins ??
    [];
  const startupPluginIds = [...(pluginLookUpTable?.startup.pluginIds ?? [])];
  const ambientAutostartSuppressedChannelIds =
    params.ambientEnvTriggers === "suppress"
      ? new Set(
          listAmbientOnlyConfiguredChannelIds({
            config: params.cfgAtStart,
            activationSourceConfig,
            env: process.env,
            includePersistedAuthState: false,
            manifestRecords: pluginManifestRecords,
          }),
        )
      : new Set<string>();

  const baseMethods = listGatewayMethods();
  // Core requests need a live local registry without displacing another Gateway's plugins.
  const emptyPluginRegistry = createEmptyPluginRegistry();
  markPluginRegistryActive(emptyPluginRegistry);
  const pluginRegistry =
    params.minimalTestGateway && !pluginsGloballyDisabled
      ? (getActivePluginRegistry() ?? emptyPluginRegistry)
      : emptyPluginRegistry;
  const metadataSnapshot =
    getGatewayPluginMetadataSnapshot() ??
    completePluginMetadataSnapshot({
      snapshot: pluginLookUpTable ?? params.pluginMetadataSnapshot,
      config: activationSourceConfig,
      env: process.env,
      workspaceDir: defaultWorkspaceDir,
    });
  // Requests can reach this registry before runtime attachment (or without it).
  // Carry the complete boot generation so cold capabilities never rediscover source plugins.
  setPluginRuntimeLoadContext(pluginRegistry, {
    rawConfig: params.cfgAtStart,
    config: gatewayPluginConfig,
    activationSourceConfig,
    autoEnabledReasons: {},
    workspaceDir: pluginWorkspaceDir,
    env: process.env,
    logger: params.log,
    metadataSnapshot,
    manifestRegistry: metadataSnapshot?.manifestRegistry,
    installRecords: metadataSnapshot
      ? extractPluginInstallRecordsFromInstalledPluginIndex(metadataSnapshot.index)
      : undefined,
    preferBuiltPluginArtifacts: true,
  });

  return {
    gatewayPluginConfigAtStart: gatewayPluginConfig,
    defaultWorkspaceDir,
    pluginWorkspaceDir,
    startupPluginIds,
    pluginManifestRecords,
    pluginMetadataSnapshot: metadataSnapshot,
    pluginLookUpTable,
    baseMethods,
    pluginRegistry,
    baseGatewayMethods: baseMethods,
    ambientAutostartSuppressedChannelIds,
  };
}

/**
 * Warn when `memory.search.provider` selects a memory embedding provider
 * that no loaded plugin registered. Without the owning plugin, `active-memory`
 * cannot embed and silently falls back to keyword/FTS-only recall.
 */
export function warnUnregisteredConfiguredMemoryEmbeddingProviders(params: {
  config: OpenClawConfig;
  pluginRegistry: Partial<Pick<PluginRegistry, "embeddingProviders">>;
  log: Pick<GatewayPluginBootstrapLog, "warn">;
}): void {
  const unregistered = collectUnregisteredConfiguredMemoryEmbeddingProviders({
    config: params.config,
    registeredProviderIds: collectRegisteredEmbeddingProviderIds(params.pluginRegistry),
  });
  for (const provider of unregistered) {
    const path = `memory.search.${provider.source}`;
    params.log.warn(
      `${path}="${provider.configuredId}" is configured, but no loaded plugin registered a memory embedding provider that can serve "${provider.configuredId}". Semantic memory recall will fall back to keyword/FTS-only search. Check that the plugin that provides "${provider.configuredId}" is installed and enabled.`,
    );
  }
}

async function warnConfiguredMemoryEmbeddingProviderSetup(params: {
  config: OpenClawConfig;
  pluginRegistry: PluginRegistry;
  pluginLookUpTable?: ReturnType<typeof loadPluginLookUpTable>;
  log: Pick<GatewayPluginBootstrapLog, "warn">;
}): Promise<void> {
  const manifestRegistry = getPluginRuntimeLoadContext(params.pluginRegistry)?.manifestRegistry ??
    params.pluginLookUpTable?.manifestRegistry ?? { plugins: [] };
  await Promise.all(
    collectConfiguredMemoryEmbeddingStartupProviderOwners(params.config).flatMap((provider) => {
      const registered = [...provider.ownerIds]
        .map((ownerId) => getRegisteredEmbeddingProvider(ownerId))
        .find((entry) => entry !== undefined);
      const owner = manifestRegistry.plugins.find(
        (plugin) => plugin.id === registered?.ownerPluginId,
      );
      if (provider.agentIds.size === 0 || !owner) {
        return [];
      }
      let policy: ReturnType<typeof resolveProviderPolicySurfaceForOwner>;
      try {
        policy = resolveProviderPolicySurfaceForOwner(owner);
      } catch (error) {
        params.log.warn(
          `Memory embedding provider "${provider.configuredId}" setup could not be checked (${String(error)}). Run "openclaw doctor" to retry.`,
        );
        return [];
      }
      const inspectSetup = policy?.inspectEmbeddingProviderSetup;
      if (!inspectSetup) {
        return [];
      }
      return [...provider.agentIds].map(async (agentId) => {
        try {
          const setup = await inspectSetup({
            config: params.config,
            env: process.env,
            agentId,
            provider: provider.configuredId,
          });
          if (setup) {
            params.log.warn(
              `Agent "${agentId}": semantic memory recall is degraded (${provider.source}="${provider.configuredId}"). ${setup.reason}${setup.fixHint ? ` ${setup.fixHint}` : ""}`,
            );
          }
        } catch (error) {
          params.log.warn(
            `Agent "${agentId}": memory embedding setup could not be checked (${String(error)}). Run "openclaw doctor" to retry.`,
          );
        }
      });
    }),
  );
}

export type MobileBootStartupPluginSplit = {
  /**
   * Plugins that must be loaded before /ready: owners of a configured
   * provider (model, generation, voice, speech, web-search, decision,
   * embedding, worker, storage), plugins with a configured activation
   * path, the memory-slot and context-engine-slot plugins, owners of a
   * configured agent harness runtime, and owners of a configured channel.
   */
  essentialPluginIds: string[];
  /** Remaining startup-plan plugins: loaded in the background after /ready. */
  deferredPluginIds: string[];
};

/**
 * F5 (mobile boot): split the resolved startup plugin plan into the
 * essential set (loaded before /ready) and the deferred set (loaded in the
 * background after /ready).
 *
 * The split only partitions the already-resolved plan. `plugins.deny` and
 * the allow-list were applied when the plan was resolved
 * (`resolveGatewayStartupPluginPlanFromRegistry`), so a denied plugin can
 * never appear in either set (N7). A plugin the split cannot classify
 * (missing manifest/index entry) stays essential — fail-closed toward
 * loading at boot, never toward silently dropping it.
 *
 * When the essential set would be empty, the whole plan stays essential:
 * a boot with no plugins at all must not depend on the background load.
 */
export function resolveMobileBootStartupPluginSplit(params: {
  startupPluginIds: readonly string[];
  pluginLookUpTable?: Pick<PluginLookUpTable, "discovery" | "index" | "manifestRegistry">;
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  workerProviderIds?: readonly string[];
  platform?: NodeJS.Platform;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
  log?: Pick<GatewayPluginBootstrapLog, "info">;
}): MobileBootStartupPluginSplit {
  const activationSourceConfig = params.activationSourceConfig ?? params.config;
  const manifestRegistry = params.pluginLookUpTable?.manifestRegistry;
  const index = params.pluginLookUpTable?.index;
  const manifestById = new Map(
    (manifestRegistry?.plugins ?? []).map((plugin) => [plugin.id, plugin]),
  );
  const indexById = new Map((index?.plugins ?? []).map((plugin) => [plugin.pluginId, plugin]));
  const configuredModelProviderIds = manifestRegistry
    ? collectConfiguredAgentModelProviderIds(activationSourceConfig, manifestRegistry)
    : new Set<string>();
  const configuredGenerationProviderIds =
    collectConfiguredGenerationProviderIds(activationSourceConfig);
  const configuredVoiceProviderIds = collectConfiguredVoiceProviderIds(activationSourceConfig);
  const configuredSpeechProviderIds = collectConfiguredSpeechProviderIds(activationSourceConfig);
  const configuredWebSearchProviderIds =
    collectConfiguredWebSearchProviderIds(activationSourceConfig);
  const configuredMemoryEmbeddingProviderIds =
    collectConfiguredMemoryEmbeddingProviderIds(activationSourceConfig);
  const configuredDecisionProviderIds = new Set(
    getConfiguredDecisionProviderIds(activationSourceConfig),
  );
  const configuredWorkerProviderIds = new Set([
    ...collectConfiguredWorkerProviderIds(activationSourceConfig),
    ...normalizeWorkerProviderIds(params.workerProviderIds ?? []),
  ]);
  const configuredStorageProviderIds = new Set(
    collectConfiguredStorageProviderIds(activationSourceConfig),
  );
  const configuredChannelIds = new Set(
    listGatewayActivatedChannelIds({
      config: params.config,
      activationSourceConfig,
      env: params.env,
      ambientEnvTriggers: params.ambientEnvTriggers,
      manifestRecords: manifestRegistry?.plugins ?? [],
      discovery: params.pluginLookUpTable?.discovery,
    }),
  );
  const requiredAgentHarnessRuntimes = new Set(
    collectConfiguredAgentHarnessRuntimes(activationSourceConfig),
  );
  // The memory-slot and context-engine-slot plugins are resolved exactly
  // like the plan does (same normalizer, same activation-source config).
  let memorySlotPluginId: string | undefined;
  let contextEngineSlotPluginId: string | undefined;
  if (index && manifestRegistry) {
    const normalizePluginId = createPluginRegistryIdNormalizer(index, { manifestRegistry });
    const contextEngineOwners = index.plugins.map((plugin) => ({
      id: plugin.pluginId,
      contextEngineIds: plugin.contextEngineIds,
    }));
    const activationSourcePlugins = withContextEngineOwner(
      normalizePluginsConfigWithResolverCore(activationSourceConfig.plugins, normalizePluginId),
      contextEngineOwners,
      normalizePluginId,
    );
    memorySlotPluginId = resolveMemorySlotStartupPluginId({
      activationSourceConfig,
      activationSourcePlugins,
      normalizePluginId,
    });
    contextEngineSlotPluginId = resolveContextEngineSlotStartupPluginId({
      records: index.plugins.map((plugin) => ({
        id: plugin.pluginId,
        contextEngineIds: plugin.contextEngineIds,
      })),
      activationSourceConfig,
      activationSourcePlugins,
      normalizePluginId,
    });
  }
  const isEssential = (pluginId: string): boolean => {
    const manifest = manifestById.get(pluginId);
    const indexRecord = indexById.get(pluginId);
    // Unclassifiable stays essential (fail-closed toward loading at boot).
    if (!manifest && !indexRecord) {
      return true;
    }
    if (pluginId === memorySlotPluginId || pluginId === contextEngineSlotPluginId) {
      return true;
    }
    if (
      indexRecord?.startup.agentHarnesses.some((runtime) =>
        requiredAgentHarnessRuntimes.has(runtime),
      )
    ) {
      return true;
    }
    if (
      hasConfiguredActivationPath({ manifest, config: activationSourceConfig }) ||
      manifestOwnsConfiguredModelProvider({ manifest, configuredModelProviderIds }) ||
      manifestOwnsConfiguredContractGroup(manifest, configuredGenerationProviderIds) ||
      manifestOwnsConfiguredContractGroup(manifest, configuredVoiceProviderIds) ||
      manifestOwnsConfiguredContract(
        manifest,
        "decisionProviders",
        configuredDecisionProviderIds,
      ) ||
      manifestOwnsConfiguredContract(manifest, "speechProviders", configuredSpeechProviderIds) ||
      manifestOwnsConfiguredContract(
        manifest,
        "webSearchProviders",
        configuredWebSearchProviderIds,
      ) ||
      manifestOwnsConfiguredContract(
        manifest,
        "embeddingProviders",
        configuredMemoryEmbeddingProviderIds,
      ) ||
      manifestOwnsWorkerProvider(manifest, configuredWorkerProviderIds) ||
      manifestOwnsStorageProvider(manifest, configuredStorageProviderIds) ||
      (manifest?.channels.some((channelId) => configuredChannelIds.has(channelId)) ?? false)
    ) {
      return true;
    }
    return false;
  };
  const essentialPluginIds = params.startupPluginIds.filter(isEssential);
  const deferredPluginIds = params.startupPluginIds.filter((id) => !isEssential(id));
  if (essentialPluginIds.length === 0 && params.startupPluginIds.length > 0) {
    // Nothing classifies as essential (e.g. no configured provider, slot,
    // or channel): keep the whole plan essential instead of booting empty.
    params.log?.info(
      "mobile boot: no essential startup plugin classified; loading the full startup plan before /ready",
    );
    return {
      essentialPluginIds: [...params.startupPluginIds],
      deferredPluginIds: [],
    };
  }
  params.log?.info(
    `mobile boot: ${essentialPluginIds.length} essential startup plugin(s) before /ready, ${deferredPluginIds.length} deferred to background (${deferredPluginIds.join(", ") || "none"})`,
  );
  return { essentialPluginIds, deferredPluginIds };
}

/** Loads startup plugin runtimes after the gateway listener binds. */
export async function loadGatewayStartupPluginRuntime(params: {
  cfg: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  log: GatewayPluginBootstrapLog;
  baseMethods: string[];
  coreGatewayMethodNames?: readonly string[];
  hostServices?: PluginRegistryParams["hostServices"];
  startupPluginIds: string[];
  pluginLookUpTable?: ReturnType<typeof loadPluginLookUpTable>;
  startupTrace?: Pick<GatewayStartupTrace, "detail">;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
  resolveGatewayContext?: GatewayContextResolver;
  signal?: AbortSignal;
  /**
   * F5 (mobile boot): resolved mobile boot profile, threaded from the
   * Gateway server options. When enabled, only the essential startup
   * plugins load before /ready; the rest are reported as
   * `deferredPluginIds` for the background load after /ready. Absent =
   * upstream behavior (full plan before /ready).
   */
  mobileBoot?: MobileBootOptions;
  /**
   * F5 (mobile boot): previous registry for the additive deferred load.
   * When set, `startupPluginIds` are loaded additively on top of it
   * (unchanged records are retained, never reloaded) and no split is
   * applied. Only the deferred background load passes this.
   */
  previousRegistry?: PluginRegistry;
}) {
  // F5 (mobile boot): before /ready, load only the essential startup
  // plugins; the rest load in the background after /ready (see
  // startGatewayPostAttachRuntime). The deferred load passes
  // previousRegistry and the full plan, so this split never runs twice.
  const split =
    params.mobileBoot?.enabled === true && !params.previousRegistry
      ? resolveMobileBootStartupPluginSplit({
          startupPluginIds: params.startupPluginIds,
          pluginLookUpTable: params.pluginLookUpTable,
          config: params.cfg,
          activationSourceConfig: params.activationSourceConfig,
          env: process.env,
          ambientEnvTriggers: params.ambientEnvTriggers,
          log: params.log,
        })
      : undefined;
  const loadPluginIds = split?.essentialPluginIds ?? params.startupPluginIds;
  const deferredPluginIds = split?.deferredPluginIds ?? [];
  params.startupTrace?.detail("plugins.mobile-boot-split", [
    ["essentialPluginCount", loadPluginIds.length],
    ["deferredPluginCount", deferredPluginIds.length],
    ["deferredPluginIds", deferredPluginIds.join(",")],
  ]);
  // F5: measure the state-migration readiness check and the lazy import
  // separately, so the unmeasured gap inside plugins.runtime-post-bind
  // (LAB run2-off: ~7 dtk with no log lines before the first plugin load)
  // can be attributed to one of them on the next measurement run.
  const beforeMigrationReadinessImport = performance.now();
  const { confirmPluginStateMigrationReadiness } =
    await import("../plugins/plugin-state-migration-readiness.js");
  params.startupTrace?.detail("plugins.state-migration-import", [
    ["durationMs", performance.now() - beforeMigrationReadinessImport],
  ]);
  const beforeMigrationReadiness = performance.now();
  try {
    await confirmPluginStateMigrationReadiness({
      config: params.activationSourceConfig ?? params.cfg,
      env: process.env,
      signal: params.signal ?? new AbortController().signal,
      warn: (message) => params.log.warn(message),
    });
  } catch (error) {
    params.log.warn(`Plugin data/settings readiness could not be confirmed: ${String(error)}`);
  }
  params.startupTrace?.detail("plugins.state-migration-readiness", [
    ["durationMs", performance.now() - beforeMigrationReadiness],
  ]);
  // Keep server-plugin-bootstrap behind one lazy boundary; startup config tests can exercise
  // planning without importing plugin package runtimes.
  const beforeBootstrapImport = performance.now();
  const { prepareGatewayPluginLoad } = await import("./server-plugin-bootstrap.js");
  params.startupTrace?.detail("plugins.gateway-bootstrap-import", [
    ["durationMs", performance.now() - beforeBootstrapImport],
  ]);
  const loaded = await prepareGatewayPluginLoad({
    loadIntent: "startup",
    cfg: params.cfg,
    activationSourceConfig: params.activationSourceConfig,
    workspaceDir: params.workspaceDir,
    log: params.log,
    coreGatewayMethodNames: params.coreGatewayMethodNames ?? params.baseMethods,
    baseMethods: params.baseMethods,
    ...(params.hostServices !== undefined && {
      hostServices: params.hostServices,
    }),
    pluginIds: loadPluginIds,
    pluginLookUpTable: params.pluginLookUpTable,
    channelPluginLoadIntent: "full",
    startupTrace: params.startupTrace,
    ambientEnvTriggers: params.ambientEnvTriggers,
    // F5 (mobile boot): async-only generation capture during boot; the
    // deferred background load retains the already-loaded essentials.
    ...(params.mobileBoot !== undefined ? { mobileBoot: params.mobileBoot } : {}),
    ...(params.previousRegistry !== undefined ? { previousRegistry: params.previousRegistry } : {}),
    ...(params.resolveGatewayContext
      ? { resolveGatewayContext: params.resolveGatewayContext }
      : {}),
  });
  try {
    withPluginRegistryPreparationScope(loaded.pluginRegistry, () =>
      withPluginRuntimeRegistryScope(loaded.pluginRegistry, () =>
        validateConfiguredBindings(loaded.resolvedConfig),
      ),
    );
    warnUnregisteredConfiguredMemoryEmbeddingProviders({
      config: loaded.resolvedConfig,
      pluginRegistry: loaded.pluginRegistry,
      log: params.log,
    });
    // Setup diagnostics may be asynchronous; a stalled provider must not hold startup.
    void withPluginRuntimeRegistryScope(loaded.pluginRegistry, () =>
      warnConfiguredMemoryEmbeddingProviderSetup({
        config: loaded.resolvedConfig,
        pluginRegistry: loaded.pluginRegistry,
        pluginLookUpTable: params.pluginLookUpTable,
        log: params.log,
      }),
    ).catch((error: unknown) => {
      params.log.warn(`Memory embedding setup checks failed: ${String(error)}`);
    });
    return { ...loaded, deferredPluginIds };
  } catch (error) {
    loaded.retireGatewayRuntimeBindings();
    await disposePluginRegistryInstances(loaded.pluginRegistry).catch((cleanupError: unknown) => {
      throw new AggregateError([error, cleanupError], "Startup plugin candidate cleanup failed", {
        cause: error,
      });
    });
    throw error;
  }
}
