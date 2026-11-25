// Loads metadata snapshots and exposes Gateway startup planning entrypoints.
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MobileBootOptions } from "../gateway/mobile-boot.js";
import type { GatewayStartupPluginPlan } from "./gateway-startup-plugin-contracts.js";
import { createGatewayStartupMetadataPluginIdScope } from "./gateway-startup-plugin-metadata.js";
import { resolveGatewayStartupPluginPlanFromRegistry } from "./gateway-startup-plugin-plan.js";
import {
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import type { PluginRegistrySnapshot } from "./plugin-registry-snapshot.js";
import {
  readStartupPluginPlanCache,
  resolveStartupPluginPlanCacheDir,
  resolveStartupPluginPlanCacheKey,
  writeStartupPluginPlanCache,
} from "./startup-plugin-plan-cache.js";

export function resolveChannelPluginIds(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  return [...loadGatewayStartupPluginPlan(params).channelPluginIds];
}

type GatewayStartupPluginPlanParams = {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  index?: PluginRegistrySnapshot;
  metadataSnapshot?: PluginMetadataSnapshot;
  workerProviderIds?: readonly string[];
  platform?: NodeJS.Platform;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
  /**
   * A3 (mobile boot): Gateway state dir the resolved plan is cached under
   * (`<stateDir>/cache/startup-plugin-plan.json`). Only consulted when
   * `mobileBoot` is enabled; absent = upstream behavior (resolve every boot).
   */
  stateDir?: string;
  /** A3 (mobile boot): resolved mobile boot profile, threaded from the Gateway. */
  mobileBoot?: MobileBootOptions;
};

export function loadGatewayStartupPluginPlanWithMetadata(params: GatewayStartupPluginPlanParams): {
  plan: GatewayStartupPluginPlan;
  metadataSnapshot: PluginMetadataSnapshot;
  startupPlanMs: number;
} {
  const snapshotConfig = params.activationSourceConfig ?? params.config;
  // Activation may change, but a supplied inventory still belongs to its boot.
  const metadataSnapshot =
    params.metadataSnapshot ??
    resolvePluginMetadataSnapshot({
      config: snapshotConfig,
      workspaceDir: params.workspaceDir,
      env: params.env,
      allowWorkspaceScopedCurrent: params.workspaceDir === undefined,
      ...(params.index ? { index: params.index } : {}),
      pluginIdScope: createGatewayStartupMetadataPluginIdScope({
        config: params.config,
        activationSourceConfig: params.activationSourceConfig,
        env: params.env,
        workerProviderIds: params.workerProviderIds ?? [],
        platform: params.platform,
        ambientEnvTriggers: params.ambientEnvTriggers,
      }),
    });
  const startupPlanStartedAt = performance.now();
  // A3 (mobile boot): reuse the resolved plan when every input that can
  // change it is unchanged. The key is computed from the resolved
  // snapshot's installed index, so a changed manifest under
  // `dist/extensions/` (or a changed openclaw.json) invalidates the
  // cache. A hit reports the cache-read cost as `startupPlanMs`; the
  // file records the original resolution cost as provenance only.
  const cacheStateDir = resolveStartupPluginPlanCacheDir({
    mobileBoot: params.mobileBoot,
    stateDir: params.stateDir,
  });
  if (cacheStateDir !== undefined) {
    const cacheKey = resolveStartupPluginPlanCacheKey({
      config: params.config,
      activationSourceConfig: params.activationSourceConfig,
      env: params.env,
      workspaceDir: params.workspaceDir,
      stateDir: cacheStateDir,
      index: metadataSnapshot.index,
      workerProviderIds: params.workerProviderIds ?? [],
      platform: params.platform,
      ambientEnvTriggers: params.ambientEnvTriggers,
    });
    const cachedPlan = readStartupPluginPlanCache({ stateDir: cacheStateDir, key: cacheKey });
    if (cachedPlan) {
      return {
        plan: cachedPlan,
        metadataSnapshot,
        startupPlanMs: performance.now() - startupPlanStartedAt,
      };
    }
    const plan = resolveGatewayStartupPluginPlanFromRegistry({
      config: params.config,
      activationSourceConfig: params.activationSourceConfig,
      env: params.env,
      index: metadataSnapshot.index,
      manifestRegistry: metadataSnapshot.manifestRegistry,
      discovery: metadataSnapshot.discovery,
      normalizePluginId: metadataSnapshot.normalizePluginId,
      workerProviderIds: params.workerProviderIds ?? [],
      platform: params.platform,
      ambientEnvTriggers: params.ambientEnvTriggers,
    });
    const startupPlanMs = performance.now() - startupPlanStartedAt;
    writeStartupPluginPlanCache({
      stateDir: cacheStateDir,
      key: cacheKey,
      plan,
      startupPlanMs,
    });
    return { plan, metadataSnapshot, startupPlanMs };
  }
  const plan = resolveGatewayStartupPluginPlanFromRegistry({
    config: params.config,
    activationSourceConfig: params.activationSourceConfig,
    env: params.env,
    index: metadataSnapshot.index,
    manifestRegistry: metadataSnapshot.manifestRegistry,
    discovery: metadataSnapshot.discovery,
    normalizePluginId: metadataSnapshot.normalizePluginId,
    workerProviderIds: params.workerProviderIds ?? [],
    platform: params.platform,
    ambientEnvTriggers: params.ambientEnvTriggers,
  });
  return { plan, metadataSnapshot, startupPlanMs: performance.now() - startupPlanStartedAt };
}

export function loadGatewayStartupPluginPlan(
  params: GatewayStartupPluginPlanParams,
): GatewayStartupPluginPlan {
  return loadGatewayStartupPluginPlanWithMetadata(params).plan;
}
