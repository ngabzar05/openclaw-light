// Unit tests for the tool-catalog snapshot cache (fork: W2).
//
// The snapshot is display-only and fail-closed: it is written only from a
// complete catalog build and served only when its key matches the live
// inputs exactly. These tests pin the key discipline, the round-trip, and
// the corrupt/stale rejection paths.
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolsCatalogResult } from "../../packages/gateway-protocol/src/index.js";
import {
  buildToolCatalogSnapshotKey,
  computeExtensionsFingerprint,
  readToolCatalogSnapshot,
  resolveToolCatalogSnapshotPath,
  TOOL_CATALOG_SNAPSHOT_PREFIX,
  writeToolCatalogSnapshot,
  type ToolCatalogSnapshotKeyInputs,
} from "./tool-catalog-snapshot.js";

const catalogFixture: ToolsCatalogResult = {
  agentId: "main",
  profiles: [{ id: "full", label: "Full" }],
  groups: [
    {
      id: "files",
      label: "Files",
      source: "core",
      tools: [
        {
          id: "read",
          label: "Read",
          description: "Read file contents",
          source: "core",
          defaultProfiles: ["full"],
        },
      ],
    },
    {
      id: "plugin:catalog-alpha",
      label: "catalog-alpha",
      source: "plugin",
      pluginId: "catalog-alpha",
      tools: [
        {
          id: "catalog-alpha",
          label: "Alpha",
          description: "Alpha tool",
          source: "plugin",
          pluginId: "catalog-alpha",
          defaultProfiles: [],
        },
      ],
    },
  ],
};

function keyInputs(
  overrides: Partial<ToolCatalogSnapshotKeyInputs> = {},
): ToolCatalogSnapshotKeyInputs {
  return {
    configKey: "config:abc",
    pluginRegistryVersion: 3,
    sourceVersion: "2026.11.6",
    agentId: "main",
    swarmEnabled: false,
    multipleIdentities: false,
    includePlugins: true,
    extensionsFingerprint: "ext:deadbeef",
    ...overrides,
  };
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-tool-catalog-snapshot-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("buildToolCatalogSnapshotKey", () => {
  it("is deterministic for the same inputs", () => {
    expect(buildToolCatalogSnapshotKey(keyInputs())).toBe(buildToolCatalogSnapshotKey(keyInputs()));
  });

  it.each([
    ["configKey", { configKey: "config:CHANGED" }],
    ["pluginRegistryVersion", { pluginRegistryVersion: 4 }],
    ["sourceVersion", { sourceVersion: "2026.11.7" }],
    ["agentId", { agentId: "other" }],
    ["swarmEnabled", { swarmEnabled: true }],
    ["multipleIdentities", { multipleIdentities: true }],
    ["includePlugins", { includePlugins: false }],
    ["extensionsFingerprint", { extensionsFingerprint: "ext:CHANGED" }],
  ] as const)("changes when %s changes", (_name, overrides) => {
    expect(buildToolCatalogSnapshotKey(keyInputs(overrides))).not.toBe(
      buildToolCatalogSnapshotKey(keyInputs()),
    );
  });
});

describe("computeExtensionsFingerprint", () => {
  it("reports missing when the extensions dir does not exist", async () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(tmpRoot, "state") };
    await expect(computeExtensionsFingerprint(env)).resolves.toBe("missing");
  });

  it("is stable for an unchanged dir and changes when an entry mtime changes", async () => {
    const stateDir = path.join(tmpRoot, "state");
    const extensionsDir = path.join(stateDir, "extensions", "plugin-a");
    await mkdir(extensionsDir, { recursive: true });
    await writeFile(path.join(extensionsDir, "openclaw.plugin.json"), "{}\n", "utf8");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const first = await computeExtensionsFingerprint(env);
    expect(first).not.toBe("missing");
    expect(first).not.toBe("unavailable");
    await expect(computeExtensionsFingerprint(env)).resolves.toBe(first);
    const file = path.join(extensionsDir, "openclaw.plugin.json");
    await utimes(file, new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));
    await expect(computeExtensionsFingerprint(env)).resolves.not.toBe(first);
  });
});

describe("tool catalog snapshot round-trip", () => {
  it("writes and reads back the same catalog for the same key", async () => {
    const stateDir = path.join(tmpRoot, "state");
    const key = buildToolCatalogSnapshotKey(keyInputs());
    await expect(writeToolCatalogSnapshot({ stateDir, key, result: catalogFixture })).resolves.toBe(
      true,
    );
    await expect(readToolCatalogSnapshot({ stateDir, key })).resolves.toEqual(catalogFixture);
  });

  it("returns null for an unknown key", async () => {
    const stateDir = path.join(tmpRoot, "state");
    const key = buildToolCatalogSnapshotKey(keyInputs());
    await writeToolCatalogSnapshot({ stateDir, key, result: catalogFixture });
    await expect(
      readToolCatalogSnapshot({
        stateDir,
        key: buildToolCatalogSnapshotKey(keyInputs({ agentId: "other" })),
      }),
    ).resolves.toBeNull();
  });

  it("returns null for corrupt, wrong-version, or schema-invalid files", async () => {
    const stateDir = path.join(tmpRoot, "state");
    const key = buildToolCatalogSnapshotKey(keyInputs());
    const filePath = resolveToolCatalogSnapshotPath(stateDir, key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "{not json", "utf8");
    await expect(readToolCatalogSnapshot({ stateDir, key })).resolves.toBeNull();
    await writeFile(
      filePath,
      JSON.stringify({ version: 999, key, savedAtMs: Date.now(), result: catalogFixture }),
      "utf8",
    );
    await expect(readToolCatalogSnapshot({ stateDir, key })).resolves.toBeNull();
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        key,
        savedAtMs: Date.now(),
        result: { agentId: "main", profiles: [], groups: "not-an-array" },
      }),
      "utf8",
    );
    await expect(readToolCatalogSnapshot({ stateDir, key })).resolves.toBeNull();
  });

  it("prunes snapshots older than 7 days on write", async () => {
    const stateDir = path.join(tmpRoot, "state");
    const cacheDir = path.join(stateDir, "cache");
    await mkdir(cacheDir, { recursive: true });
    const staleKey = buildToolCatalogSnapshotKey(keyInputs({ agentId: "stale" }));
    const stalePath = resolveToolCatalogSnapshotPath(stateDir, staleKey);
    await writeFile(
      stalePath,
      JSON.stringify({
        version: 1,
        key: staleKey,
        savedAtMs: Date.now() - 8 * 24 * 60 * 60 * 1000,
        result: catalogFixture,
      }),
      "utf8",
    );
    const freshKey = buildToolCatalogSnapshotKey(keyInputs());
    await writeToolCatalogSnapshot({ stateDir, key: freshKey, result: catalogFixture });
    const names = await readdir(cacheDir);
    expect(names).not.toContain(path.basename(stalePath));
    expect(names).toContain(path.basename(resolveToolCatalogSnapshotPath(stateDir, freshKey)));
    const staleContent = await readFile(stalePath, "utf8").catch(() => null);
    expect(staleContent).toBeNull();
  });

  it("keeps snapshot files scoped per key (one file per agent/config)", async () => {
    const stateDir = path.join(tmpRoot, "state");
    const mainKey = buildToolCatalogSnapshotKey(keyInputs());
    const otherKey = buildToolCatalogSnapshotKey(keyInputs({ agentId: "other" }));
    await writeToolCatalogSnapshot({ stateDir, key: mainKey, result: catalogFixture });
    await writeToolCatalogSnapshot({
      stateDir,
      key: otherKey,
      result: { ...catalogFixture, agentId: "other" },
    });
    await expect(readToolCatalogSnapshot({ stateDir, key: mainKey })).resolves.toEqual(
      catalogFixture,
    );
    await expect(readToolCatalogSnapshot({ stateDir, key: otherKey })).resolves.toMatchObject({
      agentId: "other",
    });
    const names = (await readdir(path.join(stateDir, "cache"))).filter((name) =>
      name.startsWith(TOOL_CATALOG_SNAPSHOT_PREFIX),
    );
    expect(names).toHaveLength(2);
  });
});
