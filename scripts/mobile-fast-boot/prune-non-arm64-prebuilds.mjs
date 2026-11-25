#!/usr/bin/env node
// Prune non-arm64-linux native prebuilds from a materialized package tree
// (fork: D2).
//
// The Polones APK targets linux-arm64 only, but the dependency tree ships
// native `.node` prebuilds for every platform (darwin, win32, linux-x64)
// — both as whole optional packages (`@resvg/resvg-js-linux-x64-gnu`,
// `@lydell/node-pty-linux-x64`, ...) and as in-package prebuild dirs
// (`@earendil-works/pi-tui/native/*/prebuilds/<platform>-<arch>/*.node`).
// None of those files can ever be loaded on linux-arm64: the loaders
// select by `process.platform`/`process.arch` (pi-tui's loader reads the
// `prebuilds/<platform>-<arch>` dir for the current platform; the
// optional packages are resolved by npm/pnpm platform+arch gating).
// Deleting them only shrinks the package; it cannot change runtime
// behavior on the target.
//
// Usage:
//   node scripts/mobile-fast-boot/prune-non-arm64-prebuilds.mjs --root <dir> [--apply]
//
// - `--root <dir>`: the materialized tree to prune (e.g. the staged
//   `node_modules` the APK pipeline copies). It must be a REAL directory
//   tree, not a pnpm symlinked `node_modules` (symlinks are skipped,
//   never followed, so a pnpm store is safe to point at but pointless).
// - Without `--apply` this is a DRY RUN: it lists what would be removed
//   and the bytes saved, and removes nothing. Pass `--apply` to delete.
// - Exit code 0: done (dry run or applied). Exit code 1: usage error or
//   a safety refusal (see below). Exit code 2: a filesystem error while
//   deleting (partial state possible — rerun to finish).
//
// Safety rules (a path is NEVER removed when any of these hold):
// 1. It matches the linux-arm64 keeper (`linux-arm64` anywhere in the
//    path, or an `arm64` prebuild dir under `linux/`).
// 2. It is not a recognized prebuild shape (see `isPrunableTarget`):
//    only (a) whole optional-package dirs whose name ends in a
//    platform-arch suffix other than linux-arm64, and (b) `.node` files
//    inside a `prebuilds/<platform>-<arch>/` dir other than
//    `linux-arm64`, or whose filename carries a non-arm64 platform-arch
//    tag. Ordinary `build/Release/*.node` files (compiled from source,
//    not prebuilt) are never touched.
// 3. It is a symlink: skipped, never followed, never deleted.
//
// After `--apply`, the script re-scans and fails (exit 1) if any target
// remains, so a half-finished prune is visible instead of silent.
//
// This script is the fork-side deliverable for D2. The Polones side
// (adopting it into the APK pipeline's prune step in `build.sh`) is
// documented in `docs/mobile-fast-boot/D2-PREBUILD-PRUNE.md`, together
// with the measured sizes.
import { lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, join, resolve, sep } from "node:path";

// `linux-arm64` is the ONLY keeper. Every other platform-arch pair is prunable.
const KEEPER_TAG = "linux-arm64";

// Platform-arch suffixes a package directory name may end with, e.g.
// `@resvg/resvg-js-linux-x64-gnu`, `@lydell/node-pty-darwin-arm64`,
// `@trycua/cua-driver-win32-x64-msvc`. The suffix is the part after the
// last platform token; anything else in the name is the package proper.
const PLATFORM_ARCH_SUFFIX =
  /-(darwin|win32|linux|freebsd|openbsd|android)-(x64|arm64|arm|ia32)(-|$)/;

// A `.node` filename carrying a platform-arch tag, e.g.
// `resvgjs.linux-x64-gnu.node`, `rolldown-binding.linux-x64-gnu.node`.
const NODE_FILENAME_TAG =
  /\.(darwin|win32|linux|freebsd|openbsd|android)-(x64|arm64|arm|ia32)(-|$|\.)/;

function isKeeperPath(path) {
  // Any linux-arm64 marker anywhere in the path keeps the whole subtree.
  return path.split(sep).some((part) => part.includes(KEEPER_TAG));
}

function isOptionalPlatformPackageDir(dirPath) {
  const name = basename(dirPath);
  const match = name.match(PLATFORM_ARCH_SUFFIX);
  if (!match) {
    return false;
  }
  // `linux-arm64` is the keeper; every other platform-arch suffix is prunable.
  return `${match[1]}-${match[2]}` !== "linux-arm64";
}

function isPrebuildNodeFile(filePath) {
  if (!filePath.endsWith(".node")) {
    return false;
  }
  const parts = filePath.split(sep);
  const prebuildsIndex = parts.lastIndexOf("prebuilds");
  if (prebuildsIndex >= 0 && prebuildsIndex + 1 < parts.length) {
    // pi-tui layout: `.../prebuilds/<platform>-<arch>/*.node`.
    return parts[prebuildsIndex + 1] !== "linux-arm64";
  }
  // Otherwise only a filename platform-arch tag qualifies (e.g. a napi
  // binding shipped loose inside its optional package). Untagged `.node`
  // files (compiled `build/Release/*.node`, test fixtures) are kept.
  return NODE_FILENAME_TAG.test(basename(filePath)) && !isKeeperPath(filePath);
}

/**
 * Classify one filesystem entry. Returns `{ kind, reason }` for a prunable
 * target, or `null` to keep it. `kind` is `"package-dir"` (remove the whole
 * directory) or `"node-file"` (remove the single file).
 */
export function classifyPruneTarget(path, stat) {
  if (isKeeperPath(path)) {
    return null;
  }
  if (stat.isDirectory() && isOptionalPlatformPackageDir(path)) {
    return { kind: "package-dir", reason: `optional platform package (${basename(path)})` };
  }
  if (stat.isFile() && isPrebuildNodeFile(path)) {
    return { kind: "node-file", reason: "non-arm64 prebuild" };
  }
  return null;
}

function dirSizeBytes(dirPath) {
  let total = 0;
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const child = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += dirSizeBytes(child);
    } else if (entry.isFile()) {
      total += statSync(child).size;
    }
  }
  return total;
}

/**
 * Walk `root` (real directories only; symlinks skipped, never followed)
 * and collect every prunable target. Returns `{ targets, totalBytes }`
 * where each target is `{ path, kind, reason, bytes }`.
 */
export function collectPruneTargets(root) {
  const targets = [];
  const walk = (dirPath) => {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const child = join(dirPath, entry.name);
      const stat = lstatSync(child);
      const target = classifyPruneTarget(child, stat);
      if (target) {
        const bytes = target.kind === "package-dir" ? dirSizeBytes(child) : stat.size;
        targets.push({ path: child, ...target, bytes });
        // Do not descend into a package dir that is removed wholesale.
        continue;
      }
      if (stat.isDirectory()) {
        walk(child);
      }
    }
  };
  walk(resolve(root));
  return { targets, totalBytes: targets.reduce((sum, target) => sum + target.bytes, 0) };
}

/** Remove every collected target. Returns `{ removed, removedBytes }`. */
export function applyPruneTargets(collected) {
  let removed = 0;
  let removedBytes = 0;
  for (const target of collected.targets) {
    rmSync(target.path, { recursive: target.kind === "package-dir", force: true });
    removed += 1;
    removedBytes += target.bytes;
  }
  return { removed, removedBytes };
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function printUsage() {
  console.error(
    "usage: prune-non-arm64-prebuilds.mjs --root <dir> [--apply]\n" +
      "  Dry run by default (lists targets, removes nothing). Pass --apply to delete.",
  );
}

async function main(argv) {
  let root;
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root" && i + 1 < argv.length) {
      root = argv[(i += 1)];
    } else if (argv[i] === "--apply") {
      apply = true;
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      printUsage();
      return 0;
    } else {
      console.error(`unknown argument: ${argv[i]}`);
      printUsage();
      return 1;
    }
  }
  if (!root) {
    console.error("missing --root <dir>");
    printUsage();
    return 1;
  }
  const rootStat = lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    console.error(`--root must be a real directory: ${root}`);
    return 1;
  }
  const collected = collectPruneTargets(root);
  if (collected.targets.length === 0) {
    console.log("no non-arm64-linux prebuilds found — nothing to prune.");
    return 0;
  }
  for (const target of collected.targets) {
    console.log(
      `${apply ? "remove" : "would remove"} [${target.kind}] ${target.path} (${formatBytes(target.bytes)}; ${target.reason})`,
    );
  }
  console.log(
    `${apply ? "removed" : "would remove"} ${collected.targets.length} target(s), ` +
      `${formatBytes(collected.totalBytes)} total.`,
  );
  if (!apply) {
    console.log("dry run — nothing removed. Pass --apply to delete.");
    return 0;
  }
  const applied = applyPruneTargets(collected);
  const remaining = collectPruneTargets(root);
  if (remaining.targets.length > 0) {
    console.error(
      `prune incomplete: ${remaining.targets.length} target(s) remain after --apply ` +
        `(first: ${remaining.targets[0].path}). Rerun to finish.`,
    );
    return 2;
  }
  console.log(
    `pruned ${applied.removed} target(s), ${formatBytes(applied.removedBytes)} reclaimed.`,
  );
  return 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = await main(process.argv.slice(2));
}
