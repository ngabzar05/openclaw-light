import { spawn, type ChildProcess } from "node:child_process";
// F2 single-owner lock fast-path (fork: Lane C) — behavior tests.
//
// The fast-path is active ONLY when the mobile boot profile is on AND the
// single-owner switch is set (`mobileBoot: { enabled: true, singleOwner:
// true }`, resolved from `OPENCLAW_MOBILE_BOOT=1` +
// `OPENCLAW_MOBILE_SINGLE_OWNER=1`). It asserts the Polones external
// guarantee (one daemon, one slot per harness, lock + lease swept before
// spawn) and, in exchange:
//   (a) skips the `gateway.state.lock` file-lock projection + the
//       owner-lease assertion,
//   (b) shortens the gateway contention deadline 300 s -> 30 s, and
//   (c) accepts `isPidDefinitelyDead` as sufficient proof of death even
//       when the owner namespace is `"unknown"` (the D-12 case: under
//       PRoot/Groot the namespace cannot be classified across a restart).
//
// What these tests prove, in order:
//   1. OFF = upstream: a stale owner with an unclassifiable namespace is
//      NEVER reclaimed, even when its PID is dead.
//   2. ON = fast reclaim: the same stale owner is reclaimed immediately,
//      the projection file is never created, and the state stays usable.
//   3. ON never reclaims a LIVE owner, however short the deadline.
//   4. ON bounds a live owner's wait at exactly 30 s (fake clock — the
//      upstream bound is 300 s, covered by `gateway-lock.test.ts`).
//   5. N2 holds with the env on: a second process that passes every
//      file/sqlite layer still exits `GatewayLockError` on the exclusive
//      TCP bind — it can never corrupt state.
//
// The stale fixtures use `processNamespace: null` — the exact shape a
// gateway under PRoot/Groot leaves behind when its namespace cannot be
// read across a restart — with a PID that is genuinely dead (a reaped
// child) or genuinely live (a held child process).
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { setTimeout as nativeSleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { resolveStateDir } from "../config/paths.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { readGatewayLockProcessNamespace } from "./gateway-lock-payload.js";
import {
  acquireGatewayLock,
  GatewayLockError,
  MOBILE_SINGLE_OWNER_LOCK_TIMEOUT_MS,
  resolveGatewayLockPaths,
} from "./gateway-lock.js";
import { resolveGatewayStateOwnerPath } from "./gateway-state-owner.js";

type GatewayLock = NonNullable<Awaited<ReturnType<typeof acquireGatewayLock>>>;
type GatewayLockOptions = NonNullable<Parameters<typeof acquireGatewayLock>[0]>;

const fixtureRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-gateway-lock-f2-" });
const realNow = Date.now.bind(Date);
const lifecycleChildren = new Map<ChildProcess, Promise<unknown[]>>();

/** Mobile boot profile values used by these tests (resolved form). */
const SINGLE_OWNER_ON = { enabled: true, singleOwner: true } as const;
const SINGLE_OWNER_OFF = { enabled: false, singleOwner: false } as const;

function resolveTestLockDir(env: NodeJS.ProcessEnv) {
  return path.join(resolveStateDir(env), "__locks");
}

async function makeEnv() {
  const dir = await fixtureRootTracker.make("case");
  const configPath = path.join(dir, "openclaw.json");
  await fs.writeFile(configPath, "{}", "utf8");
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: dir,
    OPENCLAW_CONFIG_PATH: configPath,
  };
}

async function acquireForTest(
  env: NodeJS.ProcessEnv,
  opts: Omit<GatewayLockOptions, "env" | "allowInTests"> = {},
) {
  return await acquireGatewayLock({
    env,
    allowInTests: true,
    timeoutMs: 100,
    pollIntervalMs: 2,
    now: realNow,
    sleep: nativeSleep,
    lockDir: resolveTestLockDir(env),
    ...opts,
  });
}

function expectGatewayLock(lock: Awaited<ReturnType<typeof acquireGatewayLock>>): GatewayLock {
  if (lock === null) {
    throw new Error("Expected gateway lock");
  }
  return lock;
}

/** A PID that was alive a moment ago and is now reaped — genuinely dead. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["--version"]);
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error("Could not spawn a child to obtain a dead PID");
  }
  await once(child, "close");
  return pid;
}

/** A PID that stays alive until the caller kills it. */
function liveChild(): ChildProcess {
  const child = spawn(process.execPath, ["--eval", "setTimeout(() => {}, 120_000)"]);
  if (child.pid === undefined) {
    throw new Error("Could not spawn a live child");
  }
  lifecycleChildren.set(child, once(child, "close"));
  return child;
}

/**
 * Stale owner payload with an UNCLASSIFIABLE namespace — the D-12 shape:
 * a gateway killed under PRoot/Groot leaves a lock whose `processNamespace`
 * cannot be proven from the next process (`null` here, as written when
 * the namespace read fails). Upstream refuses to reclaim this, however
 * dead the PID is; F2 reclaims it when (and only when) the PID is
 * provably dead.
 */
function staleOwnerPayload(params: { pid: number; configPath: string; stateDir: string }) {
  return {
    pid: params.pid,
    ownerId: randomUUID(),
    createdAt: new Date().toISOString(),
    configPath: params.configPath,
    stateDir: params.stateDir,
    role: "gateway",
    processNamespace: null,
    startTime: 111,
  };
}

/** Seed the on-disk stale state a killed gateway leaves behind. */
async function seedStaleOwner(env: NodeJS.ProcessEnv, pid: number) {
  const stateDir = env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("seedStaleOwner: OPENCLAW_STATE_DIR is required");
  }
  const paths = resolveGatewayLockPaths(env, resolveTestLockDir(env));
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  const ownerPath = resolveGatewayStateOwnerPath(databasePath);
  await fs.mkdir(path.dirname(ownerPath), { recursive: true, mode: 0o700 });
  await fs.mkdir(resolveTestLockDir(env), { recursive: true });
  const payload = staleOwnerPayload({
    pid,
    configPath: paths.configPath,
    stateDir: paths.stateDir,
  });
  const raw = JSON.stringify(payload);
  await fs.writeFile(ownerPath, raw, "utf8");
  await fs.writeFile(paths.stateLockPath, raw, "utf8");
  return { ...paths, ownerPath, raw };
}

/**
 * A child that physically HOLDS the state-owner file lock (flock) with a
 * live PID — the contender a dirty boot waits on. The payload carries a
 * REAL namespace (same host/boot/pid-ns), so the contender fails as a
 * `GatewayStateOwnerContentionError` with the "waited …ms" message — the
 * same shape as `holdLifecycleCoordinator` in `gateway-lock.test.ts`,
 * which covers the 300 s upstream bound. The null-namespace shape is
 * covered by the reclaim tests above; this test isolates the deadline.
 */
async function holdStaleOwnerFile(signal: AbortSignal) {
  const stateDir = await fixtureRootTracker.make("deadline-holder");
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  };
  await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}", "utf8");
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  const ownerPath = resolveGatewayStateOwnerPath(databasePath);
  await fs.mkdir(path.dirname(ownerPath), { recursive: true, mode: 0o700 });
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { acquireFileLockSync } from "@openclaw/fs-safe/file-lock";
       const pathname = process.argv[1];
       const lock = acquireFileLockSync(pathname, {
         lockPath: pathname, retry: { retries: 0 },
         payload: () => ({ pid: process.pid, createdAt: new Date().toISOString(), configPath: "synthetic", role: "gateway", processNamespace: ${JSON.stringify(readGatewayLockProcessNamespace())} }),
       });
       process.on("message", () => {
         lock.release(); process.disconnect();
       });
       process.send("held");`,
      ownerPath,
    ],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  const closed = once(child, "close");
  lifecycleChildren.set(child, closed);
  await withinTest(
    awaitGateBeforeSettlement(once(child, "message"), closed, "stale-owner fixture did not start"),
    signal,
  );
  return {
    child,
    options: {
      env,
      allowInTests: true,
      lockDir: path.join(stateDir, "__locks"),
      mobileBoot: SINGLE_OWNER_ON,
    } satisfies Omit<GatewayLockOptions, "now" | "sleep">,
  };
}

beforeAll(() => fixtureRootTracker.setup());

beforeEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(() => fixtureRootTracker.cleanup());

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const child of lifecycleChildren.keys()) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  await Promise.all(lifecycleChildren.values());
  lifecycleChildren.clear();
});

it("OFF (upstream): never reclaims a stale owner whose namespace is unknown, even with a dead PID", async () => {
  const env = await makeEnv();
  const pid = await deadPid();
  const { ownerPath, stateLockPath, raw } = await seedStaleOwner(env, pid);

  await expect(
    acquireForTest(env, { mobileBoot: SINGLE_OWNER_OFF, timeoutMs: 100 }),
  ).rejects.toBeInstanceOf(GatewayLockError);

  // Nothing was reclaimed or rewritten: the stale records are intact.
  expect(await fs.readFile(ownerPath, "utf8")).toBe(raw);
  expect(await fs.readFile(stateLockPath, "utf8")).toBe(raw);
});

it("ON: reclaims a stale unknown-namespace owner with a dead PID immediately, without creating the projection", async () => {
  const env = await makeEnv();
  const pid = await deadPid();
  const { ownerPath, stateLockPath, raw } = await seedStaleOwner(env, pid);

  const startedAt = Date.now();
  // No explicit timeoutMs: upstream would wait up to 95 s on the
  // namespace error alone. The fast-path must finish in seconds.
  const lock = expectGatewayLock(
    await acquireForTest(env, { mobileBoot: SINGLE_OWNER_ON, timeoutMs: undefined }),
  );
  const elapsedMs = Date.now() - startedAt;
  expect(elapsedMs).toBeLessThan(10_000);
  try {
    // The state-owner file was reclaimed by THIS process.
    const owner = JSON.parse(await fs.readFile(ownerPath, "utf8"));
    expect(owner.pid).toBe(process.pid);
    // (a) The `gateway.state.lock` projection was never created or
    // reclaimed: the stale file is byte-identical to what was seeded.
    expect(await fs.readFile(stateLockPath, "utf8")).toBe(raw);
    // The lock is real custody: it asserts current and releases cleanly.
    lock.assertCurrent();
  } finally {
    await lock.release();
  }
  // The state stays usable afterwards: a plain upstream acquire works.
  // (The seeded stale `gateway.state.lock` is removed first — it is test
  // scaffolding, and Polones sweeps that file before spawn; the gateway's
  // own state is the owner file, which release already removed.)
  await fs.unlink(stateLockPath);
  const next = expectGatewayLock(await acquireForTest(env, { timeoutMs: 1_000 }));
  await next.release();
});

it("ON: never reclaims a LIVE owner, however short the deadline", async () => {
  const env = await makeEnv();
  const child = liveChild();
  const { ownerPath, stateLockPath, raw } = await seedStaleOwner(env, child.pid!);

  await expect(
    acquireForTest(env, { mobileBoot: SINGLE_OWNER_ON, timeoutMs: 100 }),
  ).rejects.toBeInstanceOf(GatewayLockError);

  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  expect(await fs.readFile(ownerPath, "utf8")).toBe(raw);
  expect(await fs.readFile(stateLockPath, "utf8")).toBe(raw);
});

it("ON: bounds a live owner's wait at exactly 30 s (deadline, fake clock)", async ({ signal }) => {
  expect(MOBILE_SINGLE_OWNER_LOCK_TIMEOUT_MS).toBe(30_000);
  const { options } = await holdStaleOwnerFile(signal);
  let elapsedMs = 0;
  const sleep = vi.fn(async (ms: number) => {
    elapsedMs += ms;
  });
  // No explicit timeoutMs: the default must be the 30 s F2 deadline, not
  // the 300 s upstream one (covered by `gateway-lock.test.ts`).
  await expect(acquireGatewayLock({ ...options, now: () => elapsedMs, sleep })).rejects.toThrow(
    "failed to acquire gateway state ownership; waited 30000ms for Gateway state ownership",
  );
  expect(elapsedMs).toBe(30_000);
  expect(sleep).toHaveBeenCalled();
});

it("N2: with the env on, a second process exits GatewayLockError on the exclusive TCP bind", async () => {
  const holder = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end("first");
  });
  await new Promise<void>((resolve) => {
    holder.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (holder.address() as { port: number }).port;
  try {
    const childStateDir = await fixtureRootTracker.make("two-gateway-child");
    const childConfig = path.join(childStateDir, "openclaw.json");
    await fs.writeFile(childConfig, "{}", "utf8");
    const childLockDir = path.join(childStateDir, "__locks");
    const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
    const childScript = fileURLToPath(
      new URL("./gateway-lock.single-owner.child.mts", import.meta.url),
    );
    const child = spawn(
      process.execPath,
      [
        "--import",
        "./scripts/tsx.mjs",
        childScript,
        "--state-dir",
        childStateDir,
        "--lock-dir",
        childLockDir,
        "--port",
        String(port),
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, VITEST: "", NODE_ENV: "" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    lifecycleChildren.set(child, once(child, "close"));
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exit = await new Promise<number | null | "timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), 120_000);
      once(child, "close")
        .then(([code]) => {
          clearTimeout(timer);
          resolve(code as number | null);
        })
        .catch(() => {
          clearTimeout(timer);
          resolve(null);
        });
    });
    if (exit === "timeout") {
      child.kill("SIGKILL");
      throw new Error(`second-gateway probe did not exit within 120 s (stdout: ${stdout})`);
    }
    // The bind — not the lock — refused the second process.
    expect(exit).toBe(2);
    expect(stderr).toContain("GATEWAY_LOCK_ERROR");
    expect(stderr).toContain("already listening");
    expect(stdout).not.toContain("LISTENING");

    // The first process is unaffected, and the second process left no
    // corrupt state behind: its (dead) owner record is reclaimable by a
    // plain upstream acquire.
    await expect(
      new Promise<number | string>((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, path: "/" }, (res) => resolve(res.statusCode ?? 0))
          .on("error", reject);
      }),
    ).resolves.toBe(200);
    const childEnv = {
      ...process.env,
      OPENCLAW_STATE_DIR: childStateDir,
      OPENCLAW_CONFIG_PATH: childConfig,
    };
    const reclaimed = expectGatewayLock(await acquireForTest(childEnv, { timeoutMs: 5_000 }));
    await reclaimed.release();
  } finally {
    await new Promise<void>((resolve) => {
      holder.close(() => resolve());
    });
  }
}, 180_000);
