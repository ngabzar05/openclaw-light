// F5 (mobile boot): split of the resolved startup plugin plan into the
// essential set (loaded before /ready) and the deferred set (loaded in the
// background after /ready).
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayStartupPluginPlanFromRegistry } from "../plugins/gateway-startup-plugin-plan.js";
import { createInstalledPluginIndexFixture } from "../plugins/gateway-startup.test-helpers.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveMobileBootStartupPluginSplit } from "./server-startup-plugins.js";

function createManifestRegistry(
  plugins: Array<Pick<PluginManifestRecord, "id"> & Partial<PluginManifestRecord>>,
): PluginManifestRegistry {
  return {
    plugins: plugins.map((plugin) => createPluginManifestRecordFixture(plugin)),
    diagnostics: [],
  };
}

const registry = createManifestRegistry([
  { id: "openai", providers: ["openai"] },
  { id: "memory-core", kind: "memory" },
  {
    id: "teams-meetings",
    enabledByDefault: true,
    activation: { onStartup: true },
  },
  { id: "telegram", channels: ["telegram"] },
]);

const lookupTable = {
  index: createInstalledPluginIndexFixture(registry),
  manifestRegistry: registry,
  discovery: undefined,
};

const config = {
  agents: { defaults: { model: "openai/gpt-4o" } },
  plugins: { slots: { memory: "memory-core" } },
  channels: { telegram: { enabled: true } },
} as OpenClawConfig;

describe("resolveMobileBootStartupPluginSplit (F5)", () => {
  it("loads provider owners, slots, and configured channels before /ready; defers the rest", () => {
    const split = resolveMobileBootStartupPluginSplit({
      startupPluginIds: ["openai", "memory-core", "teams-meetings", "telegram"],
      pluginLookUpTable: lookupTable,
      config,
      env: {},
    });
    expect([...split.essentialPluginIds].sort()).toEqual(["memory-core", "openai", "telegram"]);
    expect(split.deferredPluginIds).toEqual(["teams-meetings"]);
  });

  it("keeps an unclassifiable plugin essential (fail-closed toward loading at boot)", () => {
    const split = resolveMobileBootStartupPluginSplit({
      startupPluginIds: ["teams-meetings", "ghost-plugin"],
      pluginLookUpTable: lookupTable,
      config,
      env: {},
    });
    expect(split.essentialPluginIds).toContain("ghost-plugin");
    expect(split.deferredPluginIds).toEqual(["teams-meetings"]);
  });

  it("keeps the whole plan essential when nothing classifies as essential", () => {
    const split = resolveMobileBootStartupPluginSplit({
      startupPluginIds: ["teams-meetings"],
      pluginLookUpTable: lookupTable,
      config: {} as OpenClawConfig,
      env: {},
    });
    expect(split.essentialPluginIds).toEqual(["teams-meetings"]);
    expect(split.deferredPluginIds).toEqual([]);
  });

  it("never sees a denied plugin: deny is applied when the plan is resolved", () => {
    const plan = resolveGatewayStartupPluginPlanFromRegistry({
      config: { ...config, plugins: { deny: ["teams-meetings"] } } as OpenClawConfig,
      env: {},
      index: lookupTable.index,
      manifestRegistry: registry,
      discovery: undefined,
      normalizePluginId: (id: string) => id,
    });
    expect(plan.pluginIds).not.toContain("teams-meetings");
    const split = resolveMobileBootStartupPluginSplit({
      startupPluginIds: plan.pluginIds,
      pluginLookUpTable: lookupTable,
      config,
      env: {},
    });
    expect([...split.essentialPluginIds, ...split.deferredPluginIds]).not.toContain(
      "teams-meetings",
    );
  });
});
