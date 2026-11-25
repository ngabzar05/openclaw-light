// Fork (F6): the gateway-only entry must import only the gateway-run
// path — compile-cache launcher, dispatch trace, gateway-run main, and
// the gateway server-start prewarm — and must never pull in the
// update-admission path (F8), the help fast paths, or the full entry
// graph. These are static source assertions: importing the entry in a
// test would execute its top-level guard, so the graph is checked as
// text, plus the exported wrapper pairs are checked as values.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENTRY_GATEWAY_WRAPPER_PAIRS } from "./entry-gateway.js";

const entryGatewaySource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "entry-gateway.ts"),
  "utf8",
);

function staticImports(source: string): string[] {
  // Multiline `import { ... } from "..."` included; side-effect imports
  // (`import "..."`) are collected separately below.
  return [...source.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)].map(
    (match) => match[1],
  );
}

function sideEffectImports(source: string): string[] {
  return [...source.matchAll(/^import\s+["']([^"']+)["'];?$/gm)].map((match) => match[1]);
}

function dynamicImports(source: string): string[] {
  return [...source.matchAll(/import\(["']([^"']+)["']\)/g)].map((match) => match[1]);
}

describe("entry-gateway (fork F6)", () => {
  it("keeps the gateway-only static import graph", () => {
    const imports = staticImports(entryGatewaySource);
    // Required: compile-cache launcher, dispatch trace, profile/container
    // early validation, runtime guard surface, node-host launcher client.
    for (const required of [
      "./entry.compile-cache.js",
      "./cli/startup-trace.js",
      "./cli/profile.js",
      "./cli/container-target.js",
      "./cli/gateway-run-argv.js",
    ]) {
      expect(imports).toContain(required);
    }
    // Side-effect import (no `from`): the detached async root must be
    // initialized before managed work can begin, same as `entry.ts`.
    expect(sideEffectImports(entryGatewaySource)).toContain("./shared/detached-async-context.js");
    // Forbidden: everything entry.ts carries for other commands.
    for (const forbidden of [
      "./cli/run-main-update-admission.js",
      "./cli/precomputed-help.js",
      "./cli/respawn-policy.js",
      "./entry.version-fast-path.js",
      "./cli/argv.js",
      "./entry.js",
    ]) {
      expect(imports).not.toContain(forbidden);
    }
    expect(entryGatewaySource).not.toMatch(/tryRunUpdateAdmissionBeforeStartup/);
    expect(entryGatewaySource).not.toMatch(/tryHandleRootVersionFastPath/);
    expect(entryGatewaySource).not.toMatch(/isNativeHookRelayArgv/);
    expect(entryGatewaySource).not.toMatch(/tryOutputPrecomputedCommandHelp/);
  });

  it("reaches run-main and the server-start prewarm only through dynamic imports", () => {
    const imports = dynamicImports(entryGatewaySource);
    expect(imports).toContain("./cli/run-main.js");
    expect(imports).toContain("./gateway/server-start.js");
    // The prewarm is fire-and-forget: kicked off without await, with a
    // failure handler that only warns (a failed prewarm must never fail
    // the boot — the server import then runs cold).
    expect(entryGatewaySource).toMatch(/void import\("\.\/gateway\/server-start\.js"\)\.catch/);
    expect(entryGatewaySource).toMatch(/gateway-prewarm import failed \(continuing cold\)/);
  });

  it("guards non-gateway argv with a loud exit instead of running them", () => {
    expect(entryGatewaySource).toMatch(/isForegroundGatewayRunArgv\(process\.argv\)/);
    expect(entryGatewaySource).toMatch(/entry-gateway serves foreground gateway runs only/);
    expect(entryGatewaySource).toMatch(/process\.exitCode = 2;/);
  });

  it("exports wrapper pairs that resolve to the gateway entry only", () => {
    expect(ENTRY_GATEWAY_WRAPPER_PAIRS).toEqual([
      { wrapperBasename: "openclaw.mjs", entryBasename: "entry-gateway.js" },
      { wrapperBasename: "openclaw.mjs", entryBasename: "entry-gateway.mjs" },
      { wrapperBasename: "openclaw.js", entryBasename: "entry-gateway.js" },
    ]);
    for (const pair of ENTRY_GATEWAY_WRAPPER_PAIRS) {
      expect(pair.entryBasename).toMatch(/^entry-gateway\.(js|mjs)$/);
    }
  });
});
