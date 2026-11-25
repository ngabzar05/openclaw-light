// A3 (mobile boot): startup plugin plan cache — key stability, round-trip,
// invalidation, and best-effort failure handling.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createInstalledPluginIndexFixture } from "./gateway-startup.test-helpers.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";
import {
  isStartupPluginPlanCacheEnabled,
  readStartupPluginPlanCache,
  resolveStartupPluginPlanCacheDir,
  resolveStartupPluginPlanCacheKey,
  resolveStartupPluginPlanCachePath,
  writeStartupPluginPlanCache,
} from "./startup-plugin-plan-cache.js";

function createManifestRegistry(ids: string[]): PluginManifestRegistry {
  return {
    plugins: ids.map((id) =>
      createPluginManifestRecordFixture({
        id,
        providers: [id],
        rootDir: `/fixture/${id}`,
        source: `/fixture/${id}/index.ts`,
      }),
    ),
    diagnostics: [],
  };
}

const baseConfig = {
  agents: { defaults: { model: "openai/gpt-4o" } },
  plugins: { slots: { memory: "memory-core" } },
} as OpenClawConfig;

function keyParams(overrides: Record<string, unknown> = {}) {
  const index = createInstalledPluginIndexFixture(createManifestRegistry(["openai"]));
  return {
    config: baseConfig,
    env: {} as NodeJS.ProcessEnv,
    stateDir: "/tmp/openclaw-test-state",
    index,
    ...overrides,
  };
}

describe("startup plugin plan cache (A3)", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("round-trips a plan through the cache file", () => {
    const stateDir = tempDirs.make("openclaw-plan-cache-");
    const key = resolveStartupPluginPlanCacheKey(keyParams());
    const plan = { pluginIds: ["openai", "memory-core"], channelPluginIds: ["telegram"] };
    writeStartupPluginPlanCache({ stateDir, key, plan, startupPlanMs: 7.8 });

    const cachePath = resolveStartupPluginPlanCachePath(stateDir);
    expect(existsSync(cachePath)).toBe(true);
    const file = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, unknown>;
    expect(file.version).toBe(1);
    expect(file.key).toBe(key);
    expect(readStartupPluginPlanCache({ stateDir, key })).toEqual(plan);
  });

  it("returns undefined on a key mismatch (stale entry)", () => {
    const stateDir = tempDirs.make("openclaw-plan-cache-");
    const key = resolveStartupPluginPlanCacheKey(keyParams());
    writeStartupPluginPlanCache({
      stateDir,
      key,
      plan: { pluginIds: ["openai"], channelPluginIds: [] },
      startupPlanMs: 5,
    });
    expect(readStartupPluginPlanCache({ stateDir, key: `${key}-other` })).toBeUndefined();
  });

  it("returns undefined for a corrupt, version-mismatched, or malformed file", () => {
    const stateDir = tempDirs.make("openclaw-plan-cache-");
    const cachePath = resolveStartupPluginPlanCachePath(stateDir);
    const key = resolveStartupPluginPlanCacheKey(keyParams());
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, "{not json", "utf8");
    expect(readStartupPluginPlanCache({ stateDir, key })).toBeUndefined();
    writeFileSync(
      cachePath,
      JSON.stringify({ version: 999, key, plan: { pluginIds: ["x"], channelPluginIds: [] } }),
      "utf8",
    );
    expect(readStartupPluginPlanCache({ stateDir, key })).toBeUndefined();
    writeFileSync(
      cachePath,
      JSON.stringify({ version: 1, key, plan: { pluginIds: "openai", channelPluginIds: [] } }),
      "utf8",
    );
    expect(readStartupPluginPlanCache({ stateDir, key })).toBeUndefined();
  });

  it("returns undefined when the cache file is missing", () => {
    const stateDir = tempDirs.make("openclaw-plan-cache-");
    expect(
      readStartupPluginPlanCache({
        stateDir,
        key: resolveStartupPluginPlanCacheKey(keyParams()),
      }),
    ).toBeUndefined();
  });

  it("produces a stable key for identical inputs", () => {
    expect(resolveStartupPluginPlanCacheKey(keyParams())).toBe(
      resolveStartupPluginPlanCacheKey(keyParams()),
    );
  });

  it("changes the key when the config changes", () => {
    const before = resolveStartupPluginPlanCacheKey(keyParams());
    const changed = resolveStartupPluginPlanCacheKey(
      keyParams({
        config: {
          ...baseConfig,
          agents: { defaults: { model: "anthropic/claude-opus-4-6" } },
        } as OpenClawConfig,
      }),
    );
    expect(changed).not.toBe(before);
  });

  it("changes the key when the installed plugin inventory changes", () => {
    const before = resolveStartupPluginPlanCacheKey(keyParams());
    const index = createInstalledPluginIndexFixture(createManifestRegistry(["openai"]));
    index.plugins[0]!.manifestHash = "test-openai-changed";
    const changed = resolveStartupPluginPlanCacheKey(keyParams({ index }));
    expect(changed).not.toBe(before);
  });

  it("changes the key when the activation-source config changes", () => {
    const before = resolveStartupPluginPlanCacheKey(keyParams());
    const changed = resolveStartupPluginPlanCacheKey(
      keyParams({
        activationSourceConfig: {
          ...baseConfig,
          plugins: { slots: { memory: "other-memory" } },
        } as OpenClawConfig,
      }),
    );
    expect(changed).not.toBe(before);
  });

  it("changes the key when the deny list changes (a denied plugin can never hit)", () => {
    const before = resolveStartupPluginPlanCacheKey(keyParams());
    const changed = resolveStartupPluginPlanCacheKey(
      keyParams({
        config: { ...baseConfig, plugins: { deny: ["openai"] } } as OpenClawConfig,
      }),
    );
    expect(changed).not.toBe(before);
  });

  it("never throws on an unwritable state dir (best-effort cache)", () => {
    const stateDir = tempDirs.make("openclaw-plan-cache-");
    const fileAsDir = path.join(stateDir, "not-a-dir");
    writeFileSync(fileAsDir, "x", "utf8");
    const key = resolveStartupPluginPlanCacheKey(keyParams());
    expect(() =>
      writeStartupPluginPlanCache({
        stateDir: fileAsDir,
        key,
        plan: { pluginIds: ["openai"], channelPluginIds: [] },
        startupPlanMs: 1,
      }),
    ).not.toThrow();
    expect(readStartupPluginPlanCache({ stateDir: fileAsDir, key })).toBeUndefined();
  });

  it("gates the cache behind the mobile boot profile and a state dir", () => {
    expect(isStartupPluginPlanCacheEnabled({})).toBe(false);
    expect(
      isStartupPluginPlanCacheEnabled({ mobileBoot: { enabled: false }, stateDir: "/x" }),
    ).toBe(false);
    expect(isStartupPluginPlanCacheEnabled({ mobileBoot: { enabled: true } })).toBe(false);
    expect(isStartupPluginPlanCacheEnabled({ mobileBoot: { enabled: true }, stateDir: "/x" })).toBe(
      true,
    );
    expect(resolveStartupPluginPlanCacheDir({})).toBeUndefined();
    expect(
      resolveStartupPluginPlanCacheDir({ mobileBoot: { enabled: true }, stateDir: "/x" }),
    ).toBe("/x");
  });
});
