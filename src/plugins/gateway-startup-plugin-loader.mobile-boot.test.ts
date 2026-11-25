// A3 (mobile boot): plan loader cache — write on miss, hit on repeat,
// invalidation on config change, and no cache file when the profile is off.
import { existsSync, readFileSync, statSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadGatewayStartupPluginPlanWithMetadata } from "./gateway-startup-plugin-loader.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { getPluginLoaderCacheState } from "./registry-lifecycle.js";

const snapshot = createPluginMetadataSnapshotFixture({
  plugins: [
    { id: "openai", providers: ["openai"] },
    { id: "memory-core", kind: "memory" },
    { id: "teams-meetings", enabledByDefault: true, activation: { onStartup: true } },
  ],
});

const config = {
  agents: { defaults: { model: "openai/gpt-4o" } },
  plugins: { slots: { memory: "memory-core" } },
} as OpenClawConfig;

const cacheFile = (stateDir: string) => `${stateDir}/cache/startup-plugin-plan.json`;

describe("startup plugin plan loader cache (A3)", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    getPluginLoaderCacheState().clear();
    vi.unstubAllEnvs();
  });

  it("writes the cache on miss and reuses it on hit", () => {
    const stateDir = tempDirs.make("openclaw-plan-loader-cache-");
    const params = {
      config,
      env: {} as NodeJS.ProcessEnv,
      metadataSnapshot: snapshot,
      mobileBoot: { enabled: true },
      stateDir,
    };
    const first = loadGatewayStartupPluginPlanWithMetadata(params);
    expect(first.plan.pluginIds).toContain("teams-meetings");
    expect(existsSync(cacheFile(stateDir))).toBe(true);
    const written = readFileSync(cacheFile(stateDir), "utf8");
    const writtenMtime = statSync(cacheFile(stateDir)).mtimeMs;

    const second = loadGatewayStartupPluginPlanWithMetadata(params);
    expect(second.plan).toEqual(first.plan);
    expect(readFileSync(cacheFile(stateDir), "utf8")).toBe(written);
    expect(statSync(cacheFile(stateDir)).mtimeMs).toBe(writtenMtime);
  });

  it("invalidates when the config changes", () => {
    const stateDir = tempDirs.make("openclaw-plan-loader-cache-");
    const first = loadGatewayStartupPluginPlanWithMetadata({
      config,
      env: {} as NodeJS.ProcessEnv,
      metadataSnapshot: snapshot,
      mobileBoot: { enabled: true },
      stateDir,
    });
    const firstKey = (JSON.parse(readFileSync(cacheFile(stateDir), "utf8")) as { key: string }).key;

    const changedConfig = {
      ...config,
      agents: { defaults: { model: "anthropic/claude-opus-4-6" } },
    } as OpenClawConfig;
    const second = loadGatewayStartupPluginPlanWithMetadata({
      config: changedConfig,
      env: {} as NodeJS.ProcessEnv,
      metadataSnapshot: snapshot,
      mobileBoot: { enabled: true },
      stateDir,
    });
    expect(second.plan.pluginIds).not.toContain("openai");
    expect(second.plan).not.toEqual(first.plan);
    const secondKey = (JSON.parse(readFileSync(cacheFile(stateDir), "utf8")) as { key: string })
      .key;
    expect(secondKey).not.toBe(firstKey);
  });

  it("writes no cache file when the mobile boot profile is off", () => {
    const stateDir = tempDirs.make("openclaw-plan-loader-cache-");
    loadGatewayStartupPluginPlanWithMetadata({
      config,
      env: {} as NodeJS.ProcessEnv,
      metadataSnapshot: snapshot,
      mobileBoot: { enabled: false },
      stateDir,
    });
    expect(existsSync(cacheFile(stateDir))).toBe(false);
    loadGatewayStartupPluginPlanWithMetadata({
      config,
      env: {} as NodeJS.ProcessEnv,
      metadataSnapshot: snapshot,
      stateDir,
    });
    expect(existsSync(cacheFile(stateDir))).toBe(false);
  });
});
