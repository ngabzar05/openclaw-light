// Handler tests for the mobile-boot lazy tool catalog (fork: W1/W2).
//
// A1 ON: the first `tools.catalog` call answers core groups immediately
// with `pluginCatalogPending: true` and rebuilds the snapshot in the
// background; the next call serves the snapshot without re-acquiring the
// plugin registry. A1 OFF keeps the upstream inline behavior (covered by
// tools-catalog.test.ts); this file pins that OFF writes no snapshot and
// that `plugins.deny` is honored by snapshots and invalidates them.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { ToolsCatalogResultSchema } from "../../../packages/gateway-protocol/src/schema/tools-catalog.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { loadAndActivateRootPluginRegistry } from "../../plugins/loader.js";
import * as loaderFixtures from "../../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { clearActivePluginRegistry, createPluginRegistryOwner } from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import * as pluginTools from "../../plugins/tools.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { testing as toolsCatalogTesting, toolsCatalogHandlers } from "./tools-catalog.js";

const probeKey = "__openclaw_catalog_mobile_boot_probe";

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Reflect.deleteProperty(globalThis, probeKey);
  toolsCatalogTesting.resetToolCatalogSnapshotRebuildsForTest();
  await clearActivePluginRegistry();
  clearPluginMetadataLifecycleCaches();
  loaderFixtures.resetPluginLoaderTestStateForTest();
  loaderFixtures.cleanupPluginLoaderFixturesForTest();
});

async function waitForSnapshotFile(
  stateDir: string,
  // The background rebuild runs a full plugin re-capture; on a loaded VM
  // that takes well over a minute, so the default budget is generous.
  timeoutMs = 180_000,
  /** Files that already existed: wait for a file NOT in this list (a fresh
   * rebuild writes a new file per key, so the old file must not satisfy
   * the wait after the key changes). */
  previousFiles: string[] = [],
): Promise<string> {
  const cacheDir = path.join(stateDir, "cache");
  const startedAt = Date.now();
  for (;;) {
    const names = await readdir(cacheDir).catch(() => [] as string[]);
    const snapshot = names.find(
      (name) =>
        name.startsWith("tool-catalog-") && name.endsWith(".json") && !previousFiles.includes(name),
    );
    if (snapshot) {
      return path.join(cacheDir, snapshot);
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`tool catalog snapshot did not appear in ${cacheDir} within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
}

async function listSnapshotFiles(stateDir: string): Promise<string[]> {
  const names = await readdir(path.join(stateDir, "cache")).catch(() => [] as string[]);
  return names.filter((name) => name.startsWith("tool-catalog-") && name.endsWith(".json"));
}

describe("tools.catalog with mobile boot (W1/W2)", () => {
  it("answers core-only with pending, then serves the snapshot without re-acquiring", async () => {
    await withOpenClawTestState(
      {
        prefix: "openclaw-catalog-mobile-",
        layout: "split",
        prepareProfileCatalog: true,
        env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
      },
      async (state) => {
        vi.stubEnv("OPENCLAW_STATE_DIR", state.stateDir);
        const probe = { registrations: 0, disposals: 0 };
        Object.assign(globalThis, { [probeKey]: probe });
        const files: string[] = [];
        for (const id of ["catalog-alpha", "catalog-beta"]) {
          files.push(
            await state.writeText(
              `plugins/${id}/index.cjs`,
              `module.exports = {
  id: "${id}", register(api) {
    const probe = globalThis["${probeKey}"];
    probe.registrations++;
    api.lifecycle.registerRuntimeLifecycle({ id: "catalog", dispose() { probe.disposals++; } });
    api.registerToolMetadata({ toolName: "${id}", displayName: "${id}", description: "Owned description" });
    api.registerTool(() => null, { name: "aaa_${id}", optional: true });
    api.registerTool((ctx) => Object.freeze({
      name: "${id}", label: "${id}", description: "Fallback description", displaySummary: "Short summary",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() { throw new Error("Catalog must not execute tools"); }
    }), { name: "${id}", optional: true });
  }
};`,
            ),
          );
          await state.writeJson(`plugins/${id}/openclaw.plugin.json`, {
            id,
            contracts: { tools: [id, `aaa_${id}`] },
            configSchema: { type: "object", properties: {}, additionalProperties: false },
          });
        }
        const config: OpenClawConfig = {
          agents: {
            defaults: { workspace: state.workspaceDir },
            entries: { main: {}, other: { workspace: state.path("other-workspace") } },
          },
          plugins: {
            allow: ["catalog-alpha", "catalog-beta"],
            load: { paths: files },
            slots: { memory: "none" },
          },
        };
        const metadataContext = { config, env: process.env, workspaceDir: state.workspaceDir };
        const metadataSnapshot = resolvePluginMetadataSnapshot(metadataContext);
        setGatewayPluginMetadataSnapshot(metadataSnapshot, metadataContext);
        const root = await loadAndActivateRootPluginRegistry({
          ...metadataContext,
          metadataSnapshot,
          onlyPluginIds: [],
        });
        const owner = createPluginRegistryOwner(root, state.workspaceDir);
        const respond = vi.fn();
        const acquire = vi.spyOn(pluginTools, "acquireStandalonePluginToolRegistry");
        const handler = toolsCatalogHandlers["tools.catalog"];
        assert(handler, "catalog handler");
        const invoke = (params: Record<string, unknown> = {}, cfg: OpenClawConfig = config) =>
          withPluginRuntimeRegistryScope(owner.registry, () =>
            handler({
              params,
              respond,
              context: {
                getRuntimeConfig: () => cfg,
                mobileBoot: { enabled: true },
              } as never,
              client: null,
              req: { type: "req", id: "catalog", method: "tools.catalog" },
              isWebchatConnect: () => false,
            }),
          );
        try {
          // First call: core-only + pending; the plugin re-capture must NOT
          // block the response.
          await invoke({ agentId: "main" });
          expect(respond).toHaveBeenCalledOnce();
          const first: unknown = respond.mock.calls[0]?.[1];
          assert(Value.Check(ToolsCatalogResultSchema, first));
          expect(first.pluginCatalogPending).toBe(true);
          expect(first.groups.some((group) => group.source === "plugin")).toBe(false);
          expect(first.groups.some((group) => group.source === "core")).toBe(true);
          // The response itself proves the request path did not wait for a
          // plugin re-capture: it was answered before any acquisition could
          // complete. The background rebuild may already have started its
          // (single) acquisition by the time this assertion runs, so the
          // bound is "at most one" here; the exact-once check follows after
          // the snapshot appears.
          expect(acquire.mock.calls.length).toBeLessThanOrEqual(1);

          // Background rebuild writes the snapshot; the next call is a hit.
          const snapshotPath = await waitForSnapshotFile(state.stateDir);
          expect(snapshotPath).toContain("tool-catalog-");
          expect(acquire).toHaveBeenCalledTimes(1);

          respond.mockClear();
          await invoke({ agentId: "main" });
          expect(respond).toHaveBeenCalledOnce();
          const second: unknown = respond.mock.calls[0]?.[1];
          assert(Value.Check(ToolsCatalogResultSchema, second));
          expect(second.pluginCatalogPending).toBeUndefined();
          const pluginGroups = second.groups.filter((group) => group.source === "plugin");
          expect(pluginGroups.map((group) => group.id).toSorted()).toEqual([
            "plugin:catalog-alpha",
            "plugin:catalog-beta",
          ]);
          // The hit served the snapshot: no second registry acquisition.
          expect(acquire).toHaveBeenCalledTimes(1);
          expect(probe.registrations).toBe(2);
        } finally {
          await owner.close();
        }
      },
    );
  }, 300_000);

  it("honors plugins.deny in snapshots and invalidates when deny changes", async () => {
    await withOpenClawTestState(
      {
        prefix: "openclaw-catalog-mobile-deny-",
        layout: "split",
        prepareProfileCatalog: true,
        env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
      },
      async (state) => {
        vi.stubEnv("OPENCLAW_STATE_DIR", state.stateDir);
        const files: string[] = [];
        for (const id of ["catalog-alpha", "catalog-beta"]) {
          files.push(
            await state.writeText(
              `plugins/${id}/index.cjs`,
              `module.exports = {
  id: "${id}", register(api) {
    api.registerTool(() => null, { name: "${id}", optional: true });
  }
};`,
            ),
          );
          await state.writeJson(`plugins/${id}/openclaw.plugin.json`, {
            id,
            contracts: { tools: [id] },
            configSchema: { type: "object", properties: {}, additionalProperties: false },
          });
        }
        const baseConfig: OpenClawConfig = {
          agents: {
            defaults: { workspace: state.workspaceDir },
            entries: { main: {} },
          },
          plugins: {
            allow: ["catalog-alpha", "catalog-beta"],
            load: { paths: files },
            slots: { memory: "none" },
          },
        };
        const deniedConfig: OpenClawConfig = {
          ...baseConfig,
          plugins: { ...baseConfig.plugins, deny: ["catalog-beta"] },
        };
        const loadRegistry = async (cfg: OpenClawConfig) => {
          const ctx = { config: cfg, env: process.env, workspaceDir: state.workspaceDir };
          const snapshot = resolvePluginMetadataSnapshot(ctx);
          setGatewayPluginMetadataSnapshot(snapshot, ctx);
          const nextRoot = await loadAndActivateRootPluginRegistry({
            ...ctx,
            metadataSnapshot: snapshot,
            onlyPluginIds: [],
          });
          return createPluginRegistryOwner(nextRoot, state.workspaceDir);
        };
        // The live gateway reloads plugins when the config changes (the
        // registry version bumps); a test that only swaps the config object
        // without reloading would leave the denied registry in place, and
        // the rebuilt snapshot would still exclude beta for a reason that
        // has nothing to do with the snapshot key. So the owner is
        // re-created per config below.
        let owner = await loadRegistry(deniedConfig);
        const respond = vi.fn();
        const acquire = vi.spyOn(pluginTools, "acquireStandalonePluginToolRegistry");
        const handler = toolsCatalogHandlers["tools.catalog"];
        assert(handler, "catalog handler");
        const invoke = (cfg: OpenClawConfig, params: Record<string, unknown> = {}) =>
          withPluginRuntimeRegistryScope(owner.registry, () =>
            handler({
              params,
              respond,
              context: {
                getRuntimeConfig: () => cfg,
                mobileBoot: { enabled: true },
              } as never,
              client: null,
              req: { type: "req", id: "catalog", method: "tools.catalog" },
              isWebchatConnect: () => false,
            }),
          );
        try {
          // Deny beta: the snapshot must never contain it.
          await invoke(deniedConfig, { agentId: "main" });
          await waitForSnapshotFile(state.stateDir);
          respond.mockClear();
          await invoke(deniedConfig, { agentId: "main" });
          const denied: unknown = respond.mock.calls[0]?.[1];
          assert(Value.Check(ToolsCatalogResultSchema, denied));
          expect(denied.pluginCatalogPending).toBeUndefined();
          expect(
            denied.groups
              .filter((group) => group.source === "plugin")
              .flatMap((group) => group.tools.map((tool) => tool.id)),
          ).toEqual(["catalog-alpha"]);

          // Removing the deny changes the config hash, so the denied
          // snapshot is stale and must not be served. Reload the plugins
          // first (what the gateway does on config change), so the
          // background rebuild sees the reloaded registry.
          await owner.close();
          loaderFixtures.resetPluginLoaderTestStateForTest();
          owner = await loadRegistry(baseConfig);
          const acquireBefore = acquire.mock.calls.length;
          respond.mockClear();
          await invoke(baseConfig, { agentId: "main" });
          const afterDenyRemoved: unknown = respond.mock.calls[0]?.[1];
          assert(Value.Check(ToolsCatalogResultSchema, afterDenyRemoved));
          expect(afterDenyRemoved.pluginCatalogPending).toBe(true);
          expect(afterDenyRemoved.groups.some((group) => group.source === "plugin")).toBe(false);
          // The rebuild after the deny removal writes a NEW snapshot file
          // (new key); wait for it explicitly — the old denied file still
          // exists and must not satisfy the wait.
          await waitForSnapshotFile(
            state.stateDir,
            180_000,
            await listSnapshotFiles(state.stateDir),
          );
          respond.mockClear();
          await invoke(baseConfig, { agentId: "main" });
          const allowed: unknown = respond.mock.calls[0]?.[1];
          assert(Value.Check(ToolsCatalogResultSchema, allowed));
          expect(
            allowed.groups
              .filter((group) => group.source === "plugin")
              .flatMap((group) => group.tools.map((tool) => tool.id))
              .toSorted(),
          ).toEqual(["catalog-alpha", "catalog-beta"]);
          expect(acquire.mock.calls.length).toBeGreaterThan(acquireBefore);
        } finally {
          await owner.close();
        }
      },
    );
  }, 300_000);

  it("writes no snapshot when the profile is off (upstream behavior)", async () => {
    await withOpenClawTestState(
      {
        prefix: "openclaw-catalog-mobile-off-",
        layout: "split",
        prepareProfileCatalog: true,
        env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
      },
      async (state) => {
        vi.stubEnv("OPENCLAW_STATE_DIR", state.stateDir);
        const files: string[] = [];
        for (const id of ["catalog-alpha"]) {
          files.push(
            await state.writeText(
              `plugins/${id}/index.cjs`,
              `module.exports = {
  id: "${id}", register(api) {
    api.registerTool(() => null, { name: "${id}", optional: true });
  }
};`,
            ),
          );
          await state.writeJson(`plugins/${id}/openclaw.plugin.json`, {
            id,
            contracts: { tools: [id] },
            configSchema: { type: "object", properties: {}, additionalProperties: false },
          });
        }
        const config: OpenClawConfig = {
          agents: {
            defaults: { workspace: state.workspaceDir },
            entries: { main: {} },
          },
          plugins: {
            allow: ["catalog-alpha"],
            load: { paths: files },
            slots: { memory: "none" },
          },
        };
        const metadataContext = { config, env: process.env, workspaceDir: state.workspaceDir };
        const metadataSnapshot = resolvePluginMetadataSnapshot(metadataContext);
        setGatewayPluginMetadataSnapshot(metadataSnapshot, metadataContext);
        const root = await loadAndActivateRootPluginRegistry({
          ...metadataContext,
          metadataSnapshot,
          onlyPluginIds: [],
        });
        const owner = createPluginRegistryOwner(root, state.workspaceDir);
        const respond = vi.fn();
        const handler = toolsCatalogHandlers["tools.catalog"];
        assert(handler, "catalog handler");
        const invoke = () =>
          withPluginRuntimeRegistryScope(owner.registry, () =>
            handler({
              params: { agentId: "main" },
              respond,
              // No mobileBoot on the context: pure upstream behavior.
              context: { getRuntimeConfig: () => config } as never,
              client: null,
              req: { type: "req", id: "catalog", method: "tools.catalog" },
              isWebchatConnect: () => false,
            }),
          );
        try {
          await invoke();
          expect(respond).toHaveBeenCalledOnce();
          const result: unknown = respond.mock.calls[0]?.[1];
          assert(Value.Check(ToolsCatalogResultSchema, result));
          expect(result.pluginCatalogPending).toBeUndefined();
          expect(
            result.groups
              .filter((group) => group.source === "plugin")
              .flatMap((group) => group.tools.map((tool) => tool.id)),
          ).toEqual(["catalog-alpha"]);
          expect(await listSnapshotFiles(state.stateDir)).toEqual([]);
        } finally {
          await owner.close();
        }
      },
    );
  }, 300_000);
});
