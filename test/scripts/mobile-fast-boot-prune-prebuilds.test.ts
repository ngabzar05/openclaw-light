// Fork (D2): the non-arm64 prebuild prune must remove exactly the
// non-arm64-linux native material — whole optional platform packages and
// in-package `prebuilds/<platform>-<arch>/*.node` files — and never touch
// linux-arm64 keepers, compiled `build/Release/*.node` files, or symlinks.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";
import {
  applyPruneTargets,
  classifyPruneTarget,
  collectPruneTargets,
} from "../../scripts/mobile-fast-boot/prune-non-arm64-prebuilds.mjs";

const { createTempDirAsync } = createScriptTestHarness();
const scriptPath = fileURLToPath(
  new URL("../../scripts/mobile-fast-boot/prune-non-arm64-prebuilds.mjs", import.meta.url),
);

async function write(file: string, content = "x") {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

async function expectExists(file: string) {
  await expect(fs.access(file)).resolves.toBeUndefined();
}

async function expectAbsent(file: string) {
  await expect(fs.access(file)).rejects.toHaveProperty("code", "ENOENT");
}

/** Fake materialized tree mirroring the real shapes (pi-tui + optional packages). */
async function createFixture() {
  const root = await createTempDirAsync("openclaw-prune-prebuilds-");
  const local = (file: string) => path.join(root, file);
  // Optional platform packages: x64/darwin/win32 pruned, arm64 kept.
  await write(local("node_modules/@resvg/resvg-js-linux-x64-gnu/resvgjs.linux-x64-gnu.node"));
  await write(local("node_modules/@resvg/resvg-js-linux-arm64-gnu/resvgjs.linux-arm64-gnu.node"));
  await write(local("node_modules/@lydell/node-pty-linux-x64/prebuilds/linux-x64/pty.node"));
  await write(local("node_modules/@lydell/node-pty-linux-arm64/prebuilds/linux-arm64/pty.node"));
  await write(local("node_modules/@trycua/cua-driver-linux-x64-gnu/cua_driver_node_runtime.node"));
  await write(local("node_modules/@trycua/cua-driver-linux-arm64-gnu/cua_driver_node_runtime.node"));
  // Plain package (no platform suffix) is kept as a directory, but its
  // non-arm64 prebuild .node inside is still a target (pi-tui rule).
  await write(local("node_modules/@lydell/node-pty/prebuilds/linux-x64/pty.node"));
  // pi-tui in-package prebuilds: 5 pruned, 1 kept; sources kept.
  // Filenames mirror the real package (linux ships `-x11` in the name).
  const piTuiFile: Record<string, string> = {
    darwin: "darwin-platform.node",
    linux: "linux-platform-x11.node",
    win32: "win32-platform.node",
  };
  for (const [platform, arch] of [
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["linux", "arm64"],
    ["linux", "x64"],
    ["win32", "arm64"],
    ["win32", "x64"],
  ] as const) {
    await write(
      local(
        `node_modules/@earendil-works/pi-tui/native/${platform}/prebuilds/${platform}-${arch}/${piTuiFile[platform]}`,
      ),
    );
  }
  await write(local("node_modules/@earendil-works/pi-tui/native/linux/src/linux-platform-x11.c"));
  await write(local("node_modules/@earendil-works/pi-tui/native/darwin/src/darwin-platform.m"));
  // Compiled (non-prebuild) .node files are never targets.
  await write(local("node_modules/some-native/build/Release/binding.node"));
  await write(local("node_modules/some-native/prebuilds/linux-arm64/binding.node"));
  return { root, local };
}

describe("prune-non-arm64-prebuilds (fork D2)", () => {
  it("classifies only non-arm64 prebuild shapes as prunable", () => {
    const fakeStat = (isDirectory: boolean) =>
      ({ isDirectory: () => isDirectory, isFile: () => !isDirectory }) as unknown as
        | import("node:fs").Stats
        | import("node:fs").Dirent;
    expect(
      classifyPruneTarget("node_modules/@resvg/resvg-js-linux-x64-gnu", fakeStat(true)),
    ).toMatchObject({ kind: "package-dir" });
    expect(
      classifyPruneTarget("node_modules/@resvg/resvg-js-linux-arm64-gnu", fakeStat(true)),
    ).toBeNull();
    expect(
      classifyPruneTarget(
        "node_modules/@earendil-works/pi-tui/native/linux/prebuilds/linux-x64/x.node",
        fakeStat(false),
      ),
    ).toMatchObject({ kind: "node-file" });
    expect(
      classifyPruneTarget(
        "node_modules/@earendil-works/pi-tui/native/linux/prebuilds/linux-arm64/x.node",
        fakeStat(false),
      ),
    ).toBeNull();
    expect(
      classifyPruneTarget("node_modules/some-native/build/Release/binding.node", fakeStat(false)),
    ).toBeNull();
  });

  it("collects exactly the non-arm64 targets and keeps the arm64 keepers", async () => {
    const { root } = await createFixture();
    const { targets, totalBytes } = collectPruneTargets(root);
    const kinds = targets.map((target) => target.kind).toSorted();
    // 3 whole optional packages + 5 pi-tui prebuild files + 1 prebuild
    // file inside the plain node-pty package.
    expect(kinds).toEqual([
      "node-file",
      "node-file",
      "node-file",
      "node-file",
      "node-file",
      "node-file",
      "package-dir",
      "package-dir",
      "package-dir",
    ]);
    expect(totalBytes).toBeGreaterThan(0);
    // No linux-arm64 path may ever appear among the targets.
    expect(targets.some((target) => target.path.includes("linux-arm64"))).toBe(false);
    // The plain node-pty package dir itself is not a target (no platform
    // suffix), only the linux-x64 .node inside it.
    expect(
      targets.some((target) => target.path.endsWith("node_modules/@lydell/node-pty")),
    ).toBe(false);
    expect(
      targets.some((target) =>
        target.path.endsWith("node_modules/@lydell/node-pty/prebuilds/linux-x64/pty.node"),
      ),
    ).toBe(true);
  });

  it("applies the prune and leaves keepers, sources, and compiled bindings intact", async () => {
    const { root, local } = await createFixture();
    const collected = collectPruneTargets(root);
    applyPruneTargets(collected);
    // Pruned.
    await expectAbsent(local("node_modules/@resvg/resvg-js-linux-x64-gnu"));
    await expectAbsent(local("node_modules/@lydell/node-pty-linux-x64"));
    await expectAbsent(local("node_modules/@lydell/node-pty/prebuilds/linux-x64/pty.node"));
    await expectAbsent(local("node_modules/@trycua/cua-driver-linux-x64-gnu"));
    await expectAbsent(
      local(
        "node_modules/@earendil-works/pi-tui/native/darwin/prebuilds/darwin-arm64/darwin-platform.node",
      ),
    );
    await expectAbsent(
      local(
        "node_modules/@earendil-works/pi-tui/native/linux/prebuilds/linux-x64/linux-platform-x11.node",
      ),
    );
    await expectAbsent(
      local(
        "node_modules/@earendil-works/pi-tui/native/win32/prebuilds/win32-x64/win32-platform.node",
      ),
    );
    // Kept.
    await expectExists(local("node_modules/@resvg/resvg-js-linux-arm64-gnu/resvgjs.linux-arm64-gnu.node"));
    await expectExists(local("node_modules/@lydell/node-pty-linux-arm64/prebuilds/linux-arm64/pty.node"));
    await expectExists(
      local(
        "node_modules/@earendil-works/pi-tui/native/linux/prebuilds/linux-arm64/linux-platform-x11.node",
      ),
    );
    await expectExists(local("node_modules/@earendil-works/pi-tui/native/linux/src/linux-platform-x11.c"));
    await expectExists(local("node_modules/@earendil-works/pi-tui/native/darwin/src/darwin-platform.m"));
    await expectExists(local("node_modules/some-native/build/Release/binding.node"));
    await expectExists(local("node_modules/some-native/prebuilds/linux-arm64/binding.node"));
    // Re-scan finds nothing left to prune.
    expect(collectPruneTargets(root).targets).toEqual([]);
  });

  it("dry-runs by default and deletes only with --apply (CLI)", async () => {
    const { root, local } = await createFixture();
    const dry = spawnSync(process.execPath, [scriptPath, "--root", root], { encoding: "utf8" });
    expect(dry.status).toBe(0);
    expect(dry.stdout).toMatch("would remove");
    await expectExists(local("node_modules/@resvg/resvg-js-linux-x64-gnu/resvgjs.linux-x64-gnu.node"));
    const applied = spawnSync(process.execPath, [scriptPath, "--root", root, "--apply"], {
      encoding: "utf8",
    });
    expect(applied.status).toBe(0);
    expect(applied.stdout).toMatch("reclaimed");
    await expectAbsent(local("node_modules/@resvg/resvg-js-linux-x64-gnu"));
    await expectExists(local("node_modules/@resvg/resvg-js-linux-arm64-gnu/resvgjs.linux-arm64-gnu.node"));
  });

  it("refuses a missing --root and a symlinked root", async () => {
    const missing = spawnSync(process.execPath, [scriptPath], { encoding: "utf8" });
    expect(missing.status).toBe(1);
    const { root } = await createFixture();
    const link = path.join(root, "link-root");
    await fs.symlink(root, link, "dir");
    const linked = spawnSync(process.execPath, [scriptPath, "--root", link], { encoding: "utf8" });
    expect(linked.status).toBe(1);
  });
});
