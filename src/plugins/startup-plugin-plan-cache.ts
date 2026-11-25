// A3 (mobile boot): on-disk cache for the resolved Gateway startup plugin
// plan (pluginIds + channelPluginIds).
//
// The plan resolution itself is small (LAB: ~8 ms), but it runs on every
// boot after the metadata snapshot is resolved. With the mobile boot
// profile on, the resolved plan is persisted under
// `<stateDir>/cache/startup-plugin-plan.json` and reused on the next boot
// when every input that can change the plan is unchanged. A cache hit
// skips `resolveGatewayStartupPluginPlanFromRegistry` (activation
// resolution); discovery itself is owned by the metadata snapshot, which
// this cache never replaces.
//
// Key inputs (all hashed into the key):
// - the full Gateway config and the activation-source config (a model,
//   channel, or plugins-policy change changes the plan),
// - the metadata-snapshot cache key (env fingerprint, plugin policy hash,
//   load paths, workspace/state dirs, and the installed-index fingerprint
//   — so a changed manifest under `dist/extensions/` invalidates),
// - worker provider ids, platform, ambient-env trigger policy,
// - the cache version below (bump when the cached shape or the key
//   inputs change).
//
// Best-effort by design: a missing, corrupt, or unreadable cache file is
// a miss, and a failed write is swallowed — either way the plan is
// resolved normally. The cache never changes which plugins load, only
// whether the (already deny/allow-filtered) plan is recomputed; a stale
// entry cannot smuggle in a denied plugin because the key covers the
// deny list. Cache files are plain JSON under the Gateway state dir,
// never inside the workspace.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MobileBootOptions } from "../gateway/mobile-boot.js";
import type { GatewayStartupPluginPlan } from "./gateway-startup-plugin-contracts.js";
import { hashStableJson } from "./installed-plugin-index-hash.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { resolvePluginMetadataSnapshotCacheKey } from "./plugin-metadata-snapshot.js";

/** Bump when the cached plan shape or the cache-key inputs change. */
export const STARTUP_PLUGIN_PLAN_CACHE_VERSION = 1;

export const STARTUP_PLUGIN_PLAN_CACHE_FILENAME = "startup-plugin-plan.json";

export function resolveStartupPluginPlanCachePath(stateDir: string): string {
  return path.join(stateDir, "cache", STARTUP_PLUGIN_PLAN_CACHE_FILENAME);
}

export type StartupPluginPlanCacheKeyParams = {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  workspaceDir?: string;
  stateDir: string;
  index: InstalledPluginIndex;
  workerProviderIds?: readonly string[];
  platform?: NodeJS.Platform;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
};

/**
 * Key for a resolved startup plugin plan. Reuses the metadata-snapshot
 * cache key (env fingerprint, plugin policy hash, load paths, workspace
 * and state dirs, installed-index fingerprint) and adds the plan's own
 * inputs: the full configs, worker provider ids, platform, and ambient
 * trigger policy.
 */
export function resolveStartupPluginPlanCacheKey(params: StartupPluginPlanCacheKeyParams): string {
  return hashStableJson({
    version: STARTUP_PLUGIN_PLAN_CACHE_VERSION,
    snapshot: resolvePluginMetadataSnapshotCacheKey({
      config: params.activationSourceConfig ?? params.config,
      env: params.env,
      workspaceDir: params.workspaceDir,
      stateDir: params.stateDir,
      index: params.index,
    }),
    config: hashStableJson(params.config),
    activationSourceConfig:
      params.activationSourceConfig === undefined
        ? undefined
        : hashStableJson(params.activationSourceConfig),
    workerProviderIds: [...(params.workerProviderIds ?? [])].sort(),
    platform: params.platform,
    ambientEnvTriggers: params.ambientEnvTriggers,
  });
}

type StartupPluginPlanCacheFile = {
  version: number;
  key: string;
  plan: {
    pluginIds: readonly string[];
    channelPluginIds: readonly string[];
  };
  /** Wall time the original plan resolution took; provenance only. */
  startupPlanMs: number;
};

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}

function parseStartupPluginPlanCacheFile(value: unknown): StartupPluginPlanCacheFile | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== STARTUP_PLUGIN_PLAN_CACHE_VERSION) {
    return undefined;
  }
  if (typeof record.key !== "string" || record.key.length === 0) {
    return undefined;
  }
  if (typeof record.plan !== "object" || record.plan === null) {
    return undefined;
  }
  const plan = record.plan as Record<string, unknown>;
  if (!isStringArray(plan.pluginIds) || !isStringArray(plan.channelPluginIds)) {
    return undefined;
  }
  if (typeof record.startupPlanMs !== "number" || !Number.isFinite(record.startupPlanMs)) {
    return undefined;
  }
  return {
    version: record.version,
    key: record.key,
    plan: { pluginIds: plan.pluginIds, channelPluginIds: plan.channelPluginIds },
    startupPlanMs: record.startupPlanMs,
  };
}

/**
 * Read the cached startup plugin plan for `key` from `stateDir`.
 * Returns the plan on an exact key match, `undefined` otherwise (missing,
 * corrupt, version-mismatched, or key-mismatched file). Never throws.
 */
export function readStartupPluginPlanCache(params: {
  stateDir: string;
  key: string;
}): GatewayStartupPluginPlan | undefined {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(resolveStartupPluginPlanCachePath(params.stateDir), "utf8"),
    );
    const file = parseStartupPluginPlanCacheFile(parsed);
    if (!file || file.key !== params.key) {
      return undefined;
    }
    return { pluginIds: file.plan.pluginIds, channelPluginIds: file.plan.channelPluginIds };
  } catch {
    return undefined;
  }
}

/**
 * Persist a resolved startup plugin plan under `stateDir` (atomic:
 * write-temp-then-rename). Best-effort: any failure is swallowed — the
 * next boot simply resolves the plan again. Never throws.
 */
export function writeStartupPluginPlanCache(params: {
  stateDir: string;
  key: string;
  plan: GatewayStartupPluginPlan;
  startupPlanMs: number;
}): void {
  try {
    const cachePath = resolveStartupPluginPlanCachePath(params.stateDir);
    mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmpPath = `${cachePath}.tmp-${process.pid}`;
    const file: StartupPluginPlanCacheFile = {
      version: STARTUP_PLUGIN_PLAN_CACHE_VERSION,
      key: params.key,
      plan: {
        pluginIds: [...params.plan.pluginIds],
        channelPluginIds: [...params.plan.channelPluginIds],
      },
      startupPlanMs: params.startupPlanMs,
    };
    writeFileSync(tmpPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    renameSync(tmpPath, cachePath);
  } catch {
    // Best-effort cache: a failed write only costs a recompute next boot.
  }
}

/**
 * A3 cache gate: returns the state dir the plan cache lives under when
 * the mobile boot profile is enabled and a state dir was threaded to the
 * plan loader; `undefined` otherwise (upstream behavior: resolve the plan
 * on every boot).
 */
export function resolveStartupPluginPlanCacheDir(params: {
  mobileBoot?: MobileBootOptions;
  stateDir?: string;
}): string | undefined {
  return params.mobileBoot?.enabled === true ? params.stateDir : undefined;
}

/**
 * A3 cache gate predicate (same condition as
 * `resolveStartupPluginPlanCacheDir`, as a boolean).
 */
export function isStartupPluginPlanCacheEnabled(params: {
  mobileBoot?: MobileBootOptions;
  stateDir?: string;
}): boolean {
  return resolveStartupPluginPlanCacheDir(params) !== undefined;
}
