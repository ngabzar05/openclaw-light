import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  type ToolsCatalogResult,
  validateToolsCatalogParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { retainRuntimePluginWork } from "../../agents/runtime-plugin-work.js";
import { resolveSwarmConfig } from "../../agents/subagents/swarm/swarm-config.js";
import {
  listCoreToolSections,
  PROFILE_OPTIONS,
  resolveCoreToolProfiles,
} from "../../agents/tool-catalog.js";
import { summarizeToolDescriptionText } from "../../agents/tool-description-summary.js";
import { resolveRuntimeConfigCacheKey } from "../../config/config.js";
import { resolveStateDir } from "../../config/state-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logDebug, logWarn } from "../../logger.js";
import { capturePluginLifecycleAuthority } from "../../plugins/registry-lifecycle.js";
import { getActivePluginRegistry, getActivePluginRegistryVersion } from "../../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeLoadContext } from "../../plugins/runtime/load-context.js";
import { createPluginToolMetadataLookup, getPluginToolMeta } from "../../plugins/tool-metadata.js";
import { acquireStandalonePluginToolRegistry } from "../../plugins/tools.js";
import { hasMultipleResidentSessionSharingIdentities } from "../../state/user-profile-list.js";
import { MOBILE_BOOT_DISABLED } from "../mobile-boot.js";
import {
  buildToolCatalogSnapshotKey,
  computeExtensionsFingerprint,
  readToolCatalogSnapshot,
  writeToolCatalogSnapshot,
} from "../tool-catalog-snapshot.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

type ToolCatalogGroup = ToolsCatalogResult["groups"][number];

function summarizeToolParameters(schema: unknown): ToolCatalogGroup["tools"][number]["parameters"] {
  if (!isRecord(schema) || schema.type !== "object" || !isRecord(schema.properties)) {
    return undefined;
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(schema.properties)
    .filter(([name]) => name.length > 0)
    .map(([name, property]) => {
      const parameter: NonNullable<ToolCatalogGroup["tools"][number]["parameters"]>[number] = {
        name,
        required: required.has(name),
      };
      if (isRecord(property)) {
        parameter.type = normalizeOptionalString(property.type);
        if (typeof property.description === "string") {
          parameter.description = property.description;
        }
      }
      return parameter;
    });
}

type PluginCatalogBuildParams = {
  context: Parameters<typeof acquireStandalonePluginToolRegistry>[0]["context"];
  existingToolNames: Set<string>;
  runtimeRegistry: ReturnType<typeof getActivePluginRegistry>;
  loadContext: ReturnType<typeof getPluginRuntimeLoadContext>;
  preparedRuntime: Parameters<typeof acquireStandalonePluginToolRegistry>[0]["preparedRuntime"];
  assertCurrent: () => void;
};

/**
 * Builds the plugin groups of the tool catalog from a fresh inspection
 * registry. This is the slow path: `acquireStandalonePluginToolRegistry`
 * runs a full plugin discovery + load on every call (no cache), which is
 * what stalls the Control UI catalog on the device. The mobile-boot
 * handler path (W1/W2) avoids calling this on the request path whenever a
 * valid snapshot exists, and otherwise runs it in the background.
 */
async function buildPluginCatalogGroups(
  params: PluginCatalogBuildParams,
): Promise<ToolCatalogGroup[]> {
  const { context: toolContext, existingToolNames, runtimeRegistry } = params;
  const releaseWork = retainRuntimePluginWork(runtimeRegistry ? [runtimeRegistry] : []);
  let acquisition: Awaited<ReturnType<typeof acquireStandalonePluginToolRegistry>> | undefined;
  try {
    params.assertCurrent();
    acquisition = await acquireStandalonePluginToolRegistry({
      context: toolContext,
      existingToolNames,
      toolAllowlist: ["group:plugins"],
      suppressNameConflicts: true,
      allowGatewaySubagentBinding: true,
      preparedRuntime: params.preparedRuntime,
      env: params.loadContext?.env,
      assertInvocationCurrent: params.assertCurrent,
    });
    params.assertCurrent();
    const pluginTools = acquisition.resolveTools();
    const catalogRegistry = acquisition.registry;
    const pluginGroups = new Map<string, ToolCatalogGroup>();
    // Key metadata by plugin ownership and tool name so we only project metadata that
    // was registered BY the tool's owning plugin. Without this scoping, plugin-X
    // could override the catalog label/description/risk/tags for another plugin's
    // tool by registering metadata with the same toolName.
    const metadataFor = createPluginToolMetadataLookup(catalogRegistry?.toolMetadata);
    const seenToolIds = new Set<string>();
    const appendTool = (
      pluginId: string,
      label: string,
      tool: Omit<ToolCatalogGroup["tools"][number], "source" | "pluginId" | "defaultProfiles">,
    ) => {
      const id = `plugin:${pluginId}`;
      const group: ToolCatalogGroup = pluginGroups.get(id) ?? {
        id,
        label,
        source: "plugin",
        pluginId,
        tools: [],
      };
      group.tools.push({ ...tool, source: "plugin", pluginId, defaultProfiles: [] });
      seenToolIds.add(tool.id);
      pluginGroups.set(id, group);
    };
    for (const tool of pluginTools) {
      const meta = getPluginToolMeta(tool);
      const pluginId = meta?.pluginId ?? "plugin";
      const ownedMetadata = meta?.pluginId ? metadataFor(meta.pluginId, tool.name) : undefined;
      const parameters = summarizeToolParameters(tool.parameters);
      const fullDescription =
        ownedMetadata?.description ??
        (typeof tool.description === "string" ? tool.description : undefined);
      appendTool(pluginId, pluginId, {
        id: tool.name,
        label:
          normalizeOptionalString(ownedMetadata?.displayName) ??
          normalizeOptionalString(tool.label) ??
          tool.name,
        description: summarizeToolDescriptionText({
          rawDescription: fullDescription,
          displaySummary: tool.displaySummary,
        }),
        fullDescription,
        ...(parameters?.length ? { parameters } : {}),
        optional: meta?.optional,
        risk: ownedMetadata?.risk,
        tags: ownedMetadata?.tags ? [...ownedMetadata.tags] : undefined,
      });
    }
    for (const entry of catalogRegistry?.tools ?? []) {
      const names = entry.names.length > 0 ? entry.names : (entry.declaredNames ?? []);
      for (const name of names) {
        if (seenToolIds.has(name) || existingToolNames.has(name)) {
          continue;
        }
        // Declared-but-unresolved plugin tools still appear so operators can see
        // optional capabilities that may need config before they bind at runtime.
        const ownedMetadata = metadataFor(entry.pluginId, name);
        appendTool(entry.pluginId, entry.pluginName ?? entry.pluginId, {
          id: name,
          label: normalizeOptionalString(ownedMetadata?.displayName) ?? name,
          description:
            summarizeToolDescriptionText({
              rawDescription: ownedMetadata?.description,
            }) || `Plugin tool from ${entry.pluginName ?? entry.pluginId}`,
          fullDescription: ownedMetadata?.description,
          optional: entry.optional,
          risk: ownedMetadata?.risk,
          tags: ownedMetadata?.tags ? [...ownedMetadata.tags] : undefined,
        });
      }
    }
    const sorted = Array.from(pluginGroups.values(), (group) => {
      group.tools.sort((a, b) => a.id.localeCompare(b.id));
      return group;
      // oxlint-disable-next-line unicorn/no-array-sort -- Array.from creates a fresh, private array.
    }).sort((a, b) => a.label.localeCompare(b.label));
    params.assertCurrent();
    return sorted;
  } finally {
    try {
      await acquisition?.release();
    } finally {
      releaseWork();
    }
  }
}

// In-flight background snapshot rebuilds, keyed by snapshot key. Coalesces
// concurrent `tools.catalog` misses so one slow plugin re-capture serves
// every waiter; a failed rebuild clears the slot so the next request retries.
const toolCatalogSnapshotRebuilds = new Map<string, Promise<void>>();

type SnapshotRebuildParams = {
  key: string;
  stateDir: string;
  agentId: string;
  profiles: ToolsCatalogResult["profiles"];
  coreGroups: ToolCatalogGroup[];
  build: () => Promise<ToolCatalogGroup[]>;
};

function rebuildToolCatalogSnapshot(params: SnapshotRebuildParams): Promise<void> {
  const existing = toolCatalogSnapshotRebuilds.get(params.key);
  if (existing) {
    return existing;
  }
  const startedAt = Date.now();
  const task = (async () => {
    try {
      const pluginGroups = await params.build();
      const result = {
        agentId: params.agentId,
        profiles: params.profiles,
        groups: [...params.coreGroups, ...pluginGroups],
      } satisfies ToolsCatalogResult;
      const stored = await writeToolCatalogSnapshot({
        stateDir: params.stateDir,
        key: params.key,
        result,
      });
      logDebug(
        `tools.catalog: snapshot rebuild agent=${params.agentId} durationMs=${Date.now() - startedAt} stored=${stored}`,
      );
    } catch (error) {
      // A failed background rebuild must never break the catalog RPC: the
      // caller already answered core-only, and the next request retries.
      logWarn(`tools.catalog: background snapshot rebuild failed: ${String(error)}`);
    }
  })();
  toolCatalogSnapshotRebuilds.set(params.key, task);
  void task.finally(() => {
    if (toolCatalogSnapshotRebuilds.get(params.key) === task) {
      toolCatalogSnapshotRebuilds.delete(params.key);
    }
  });
  return task;
}

async function buildToolCatalogSnapshotKeyForRequest(params: {
  cfg: OpenClawConfig;
  agentId: string;
  swarmEnabled: boolean;
  multipleIdentities: boolean;
  env: NodeJS.ProcessEnv;
}): Promise<string> {
  return buildToolCatalogSnapshotKey({
    configKey: resolveRuntimeConfigCacheKey(params.cfg),
    pluginRegistryVersion: getActivePluginRegistryVersion(),
    agentId: params.agentId,
    swarmEnabled: params.swarmEnabled,
    multipleIdentities: params.multipleIdentities,
    includePlugins: true,
    extensionsFingerprint: await computeExtensionsFingerprint(params.env),
  });
}

export const toolsCatalogHandlers: GatewayRequestHandlers = {
  "tools.catalog": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateToolsCatalogParams, "tools.catalog", respond)) {
      return;
    }
    const resolved = resolveAgentIdOrRespondError({
      rawAgentId: params.agentId,
      respond,
      cfg: context.getRuntimeConfig(),
    });
    if (!resolved) {
      return;
    }
    const { cfg, agentId } = resolved;
    // Core catalog rows come from static tool sections so profile chips remain
    // stable even before any runtime agent session exists.
    const swarmEnabled = resolveSwarmConfig(cfg, agentId).enabled;
    const multipleIdentities = hasMultipleResidentSessionSharingIdentities();
    const profiles = PROFILE_OPTIONS.map((profile) => ({ id: profile.id, label: profile.label }));
    const groups = listCoreToolSections({
      swarmEnabled,
      personalInstructionsEnabled: multipleIdentities,
    }).map((section): ToolCatalogGroup => ({
      id: section.id,
      label: section.label,
      source: "core",
      tools: section.tools.map((tool) => ({
        id: tool.id,
        label: tool.label,
        description: tool.description,
        source: "core",
        defaultProfiles: resolveCoreToolProfiles(tool.id),
      })),
    }));
    if (params.includePlugins !== false) {
      const existingToolNames = new Set(
        groups.flatMap((group) => group.tools.map((tool) => tool.id)),
      );
      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      const agentDir = resolveAgentDir(cfg, agentId);
      const toolContext = {
        config: cfg,
        workspaceDir,
        agentDir,
        agentId,
      };
      const runtimeRegistry =
        getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? getActivePluginRegistry();
      const loadContext = getPluginRuntimeLoadContext(runtimeRegistry ?? undefined);
      // Catalog inspection uses the Gateway's admitted inventory, not a new synchronous
      // workspace/manifest scan. Factories still receive the requested agent's context.
      const preparedRuntime = loadContext?.metadataSnapshot
        ? {
            loadContext: { ...loadContext, workspaceDir },
            metadataSnapshot: loadContext.metadataSnapshot,
          }
        : undefined;
      const current = runtimeRegistry && capturePluginLifecycleAuthority(runtimeRegistry);
      const assertCurrent = () => {
        if (runtimeRegistry && !current?.()) {
          throw new Error("Plugin catalog generation is no longer available");
        }
      };
      const mobileBoot = context.mobileBoot ?? MOBILE_BOOT_DISABLED;
      if (mobileBoot.enabled) {
        // W1/W2 (mobile fast boot): never block the catalog response on a
        // plugin re-capture. Serve the disk snapshot when its key matches
        // the live inputs; otherwise answer the core groups immediately and
        // rebuild the snapshot in the background. The UI re-requests until
        // the plugin groups arrive. Execution never reads the snapshot: the
        // agent runtime resolves tools from the live registry at turn time.
        const env = loadContext?.env ?? process.env;
        const stateDir = resolveStateDir(env);
        const startedAt = Date.now();
        const key = await buildToolCatalogSnapshotKeyForRequest({
          cfg,
          agentId,
          swarmEnabled,
          multipleIdentities,
          env,
        });
        const snapshot = await readToolCatalogSnapshot({ stateDir, key });
        if (snapshot) {
          logDebug(
            `tools.catalog: snapshot hit agent=${agentId} durationMs=${Date.now() - startedAt}`,
          );
          respond(true, snapshot, undefined);
          return;
        }
        logDebug(
          `tools.catalog: snapshot miss agent=${agentId} durationMs=${Date.now() - startedAt}; answering core-only, rebuilding in background`,
        );
        respond(
          true,
          {
            agentId,
            profiles,
            groups,
            pluginCatalogPending: true,
          } satisfies ToolsCatalogResult,
          undefined,
        );
        void rebuildToolCatalogSnapshot({
          key,
          stateDir,
          agentId,
          profiles,
          coreGroups: groups,
          build: () =>
            buildPluginCatalogGroups({
              context: toolContext,
              existingToolNames,
              runtimeRegistry,
              loadContext,
              preparedRuntime,
              assertCurrent,
            }),
        });
        return;
      }
      const pluginGroups = await buildPluginCatalogGroups({
        context: toolContext,
        existingToolNames,
        runtimeRegistry,
        loadContext,
        preparedRuntime,
        assertCurrent,
      });
      groups.push(...pluginGroups);
      assertCurrent();
    }
    respond(
      true,
      {
        agentId,
        profiles,
        groups,
      } satisfies ToolsCatalogResult,
      undefined,
    );
  },
};

export const testing = {
  resetToolCatalogSnapshotRebuildsForTest() {
    toolCatalogSnapshotRebuilds.clear();
  },
} as const;
