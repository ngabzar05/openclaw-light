// Tool-catalog snapshot cache (fork: W2, mobile fast boot).
//
// `tools.catalog` rebuilds the plugin catalog from scratch on every call:
// `acquireStandalonePluginToolRegistry` runs a full fresh plugin discovery
// (`acquirePluginRegistryForInspection`, `activate: false, cache: false`).
// On the device that re-capture stalls the Control UI catalog for tens of
// seconds (43,5 dtk, video 25 Nov 2026 02:39 WIB). This module persists the
// last successfully built catalog to `<stateDir>/cache/tool-catalog-*.json`
// so the next boot can serve it instantly, and validates it against a key
// that covers every input that changes the answer.
//
// Invalidation discipline (same as A3): the snapshot is stale — and never
// served — when any of these change:
//   - `openclaw.json` (whole-config hash via `resolveRuntimeConfigCacheKey`,
//     which covers `plugins.deny`, `tools.*`, agents, everything),
//   - the plugin registry generation (`getActivePluginRegistryVersion()`),
//   - the user extensions directory listing (name + mtime per entry),
//   - the gateway build version (`VERSION`, so an APK update with new
//     bundled extensions never serves a snapshot from the old build),
//   - the agent, swarm flag, multi-identity flag, or `includePlugins`.
//
// Fail-closed: a snapshot is only ever written from a complete catalog
// build that already applied `plugins.deny` and the allow-list, and it is
// only served when its key matches the live key exactly. A corrupt,
// foreign-version, or key-mismatched file is ignored (never served) and the
// caller falls back to a full rebuild. The snapshot is display-only: tool
// execution never reads it — the agent runtime resolves tools from the
// live registry at turn time.
//
// All behavior in this module is inert unless the gateway handler calls it,
// and the handler only does so when the mobile boot profile is ON (A1).
// Best-effort I/O: every function degrades to "no snapshot" instead of
// throwing, so a broken cache can never break the catalog RPC.
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Value } from "typebox/value";
import {
  ToolsCatalogResultSchema,
  type ToolsCatalogResult,
} from "../../packages/gateway-protocol/src/schema/tools-catalog.js";
import { resolveDefaultPluginExtensionsDir } from "../plugins/install-paths.js";
import { VERSION } from "../version.js";

/** Snapshot file format version. Bump when the stored shape changes. */
export const TOOL_CATALOG_SNAPSHOT_VERSION = 1;

/** Directory (under the state dir) that holds catalog snapshots. */
export const TOOL_CATALOG_SNAPSHOT_DIRNAME = "cache";

/** File prefix; the key hash disambiguates agents/configs. */
export const TOOL_CATALOG_SNAPSHOT_PREFIX = "tool-catalog-";

/** Snapshots older than this are pruned on write (best-effort). */
export const TOOL_CATALOG_SNAPSHOT_PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export type ToolCatalogSnapshotKeyInputs = {
  /** Whole-config hash (`resolveRuntimeConfigCacheKey`). Covers `plugins.deny`. */
  configKey: string;
  /** Live plugin registry generation. Bumps on install/reload. */
  pluginRegistryVersion: number;
  /** Gateway build version. Guards bundled-extension changes across updates. */
  sourceVersion?: string;
  agentId: string;
  swarmEnabled: boolean;
  multipleIdentities: boolean;
  includePlugins: boolean;
  /** Fingerprint of the user extensions dir (names + mtimes). */
  extensionsFingerprint: string;
};

export type ToolCatalogSnapshotFile = {
  version: number;
  key: string;
  savedAtMs: number;
  result: ToolsCatalogResult;
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Key that identifies exactly one catalog answer. Two calls with the same
 * key must produce the same catalog; any input change produces a new key.
 */
export function buildToolCatalogSnapshotKey(inputs: ToolCatalogSnapshotKeyInputs): string {
  return JSON.stringify({
    v: TOOL_CATALOG_SNAPSHOT_VERSION,
    source: inputs.sourceVersion ?? VERSION ?? "unknown",
    config: inputs.configKey,
    registry: inputs.pluginRegistryVersion,
    agent: inputs.agentId,
    swarm: inputs.swarmEnabled,
    identities: inputs.multipleIdentities,
    plugins: inputs.includePlugins,
    extensions: inputs.extensionsFingerprint,
  });
}

/**
 * Cheap fingerprint of the user extensions directory: sorted entry names
 * with their mtimes, descending one level into each plugin directory so a
 * file rewritten inside a plugin (the common update shape: manifest +
 * entry file replaced in place) changes the fingerprint. Adding, removing,
 * or renaming an entry changes it too.
 *
 * Limits (documented, not hidden): files nested deeper than one level
 * inside a plugin directory are NOT fingerprinted — a rewrite there does
 * not change the fingerprint. That case is caught by the plugin registry
 * version in the snapshot key instead (plugin install/reload bumps it),
 * and by `sourceVersion` for bundled-extension changes on update.
 * The walk is capped at `EXTENSIONS_FINGERPRINT_MAX_ENTRIES` entries so
 * a pathological plugin tree cannot make a catalog call expensive.
 *
 * Returns `"missing"` when the directory does not exist and
 * `"unavailable"` when it cannot be read (fail-open: the snapshot is then
 * keyed without extensions, never served as if it were fresh — the caller
 * still validates the full key).
 */
const EXTENSIONS_FINGERPRINT_MAX_ENTRIES = 512;

export async function computeExtensionsFingerprint(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const dir = resolveDefaultPluginExtensionsDir(env);
  let names: string[];
  try {
    names = (await readdir(dir)).toSorted((a, b) => a.localeCompare(b));
  } catch (error) {
    return isMissingDir(error) ? "missing" : "unavailable";
  }
  const parts: string[] = [];
  let counted = 0;
  for (const name of names) {
    if (counted >= EXTENSIONS_FINGERPRINT_MAX_ENTRIES) {
      break;
    }
    const entryPath = path.join(dir, name);
    let entry;
    try {
      entry = await stat(entryPath);
    } catch {
      parts.push(`${name}:?`);
      counted += 1;
      continue;
    }
    counted += 1;
    parts.push(`${name}:${entry.mtimeMs}`);
    // One level down: a plugin directory's files are the things an update
    // rewrites. A bare `stat` of the directory itself would miss that —
    // rewriting a file's contents does not change its parent's mtime.
    if (entry.isDirectory()) {
      let children: string[];
      try {
        children = (await readdir(entryPath)).toSorted((a, b) => a.localeCompare(b));
      } catch {
        continue;
      }
      for (const child of children) {
        if (counted >= EXTENSIONS_FINGERPRINT_MAX_ENTRIES) {
          break;
        }
        try {
          const childStat = await stat(path.join(entryPath, child));
          parts.push(`${name}/${child}:${childStat.mtimeMs}`);
        } catch {
          parts.push(`${name}/${child}:?`);
        }
        counted += 1;
      }
    }
  }
  return sha256Hex(parts.join("\n")).slice(0, 32);
}

function isMissingDir(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function resolveToolCatalogSnapshotPath(stateDir: string, key: string): string {
  return path.join(
    stateDir,
    TOOL_CATALOG_SNAPSHOT_DIRNAME,
    `${TOOL_CATALOG_SNAPSHOT_PREFIX}${sha256Hex(key).slice(0, 16)}.json`,
  );
}

function isValidSnapshotFile(value: unknown, key: string): value is ToolCatalogSnapshotFile {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const file = value as Partial<ToolCatalogSnapshotFile>;
  if (file.version !== TOOL_CATALOG_SNAPSHOT_VERSION || file.key !== key) {
    return false;
  }
  if (typeof file.savedAtMs !== "number" || !Number.isFinite(file.savedAtMs)) {
    return false;
  }
  // Strict shape check: a snapshot that does not validate as a catalog
  // result is never served, even when its key matches.
  return Value.Check(ToolsCatalogResultSchema, file.result);
}

/**
 * Read a snapshot for `key`. Returns the stored catalog result, or `null`
 * when there is no file, it is corrupt, its key/version mismatches, or it
 * fails schema validation. Never throws.
 */
export async function readToolCatalogSnapshot(params: {
  stateDir: string;
  key: string;
}): Promise<ToolsCatalogResult | null> {
  const filePath = resolveToolCatalogSnapshotPath(params.stateDir, params.key);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  return isValidSnapshotFile(parsed, params.key) ? parsed.result : null;
}

/**
 * Persist a freshly built catalog result under `key`. Writes atomically
 * (temp file + rename) and prunes snapshots older than 7 days, both
 * best-effort. Returns `true` when the snapshot was stored. Never throws.
 */
export async function writeToolCatalogSnapshot(params: {
  stateDir: string;
  key: string;
  result: ToolsCatalogResult;
}): Promise<boolean> {
  const dir = path.join(params.stateDir, TOOL_CATALOG_SNAPSHOT_DIRNAME);
  const filePath = resolveToolCatalogSnapshotPath(params.stateDir, params.key);
  const file: ToolCatalogSnapshotFile = {
    version: TOOL_CATALOG_SNAPSHOT_VERSION,
    key: params.key,
    savedAtMs: Date.now(),
    result: params.result,
  };
  try {
    await mkdir(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, JSON.stringify(file), "utf8");
    await rename(tmpPath, filePath);
  } catch {
    return false;
  }
  await pruneStaleToolCatalogSnapshots(dir).catch(() => undefined);
  return true;
}

async function pruneStaleToolCatalogSnapshots(dir: string): Promise<void> {
  const cutoff = Date.now() - TOOL_CATALOG_SNAPSHOT_PRUNE_AFTER_MS;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(TOOL_CATALOG_SNAPSHOT_PREFIX) || !name.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(dir, name);
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<ToolCatalogSnapshotFile>;
      if (
        typeof parsed.savedAtMs === "number" &&
        Number.isFinite(parsed.savedAtMs) &&
        parsed.savedAtMs >= cutoff
      ) {
        continue;
      }
    } catch {
      // Unparseable snapshot files are stale by definition: remove them.
    }
    await rm(filePath, { force: true }).catch(() => undefined);
  }
}
