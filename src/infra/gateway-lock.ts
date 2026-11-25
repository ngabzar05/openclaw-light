// Coordinates gateway lock files, ports, and stale owner detection.
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  resolvePositiveTimerTimeoutMs,
  resolveTimerTimeoutMs,
  resolveTimestampMsToIsoString,
} from "@openclaw/normalization-core/number-coercion";
import { resolveConfigPath, resolveGatewayLockDir, resolveStateDir } from "../config/paths.js";
import type { MobileBootOptions } from "../gateway/mobile-boot.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isPidAlive, isPidDefinitelyDead } from "../shared/pid-alive.js";
import {
  createOpenClawDatabaseMaintenanceScope,
  getOpenClawDatabaseMaintenanceScope,
} from "../state/openclaw-state-db-async-lifecycle.js";
import { ensureOpenClawStatePermissions } from "../state/openclaw-state-db-permissions.js";
import { acquireWithWait } from "./acquire-with-wait.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import { sha256HexPrefixCore } from "./crypto-digest.js";
import { readProcessMachineIdentity } from "./current-machine-identity.js";
import {
  assertDatabasePortRecoveryAllowed,
  assertDatabasePortStartupAllowed,
  DatabasePortRecoveryError,
  type DatabasePortRecoveryIntent,
} from "./database-port-recovery.js";
import { hasErrnoCode } from "./errno.js";
import { acquireFileLockSync } from "./file-lock-manager.js";
import {
  classifyGatewayLockProcessNamespace,
  describeGatewayLockHolder,
  GATEWAY_OWNER_HEARTBEAT_STALE_MS,
  GatewayLockNamespaceError,
  type GatewayLockRole,
  type LockPayload,
  LockPayloadSchema,
  parseGatewayLockPayload,
  readGatewayLockProcessNamespace,
} from "./gateway-lock-payload.js";
import {
  readGatewayLockProcessCmdline,
  readGatewayLockProcessStartTime,
} from "./gateway-lock-process.js";
import {
  acquireGatewayOwnerLease,
  assertGatewayOwnerLeaseStopped,
  type GatewayOwnerLease,
} from "./gateway-owner-lease.js";
import type { GatewayOwnerSupervisor } from "./gateway-owner-lease.types.js";
import { classifyOpenClawArgv } from "./gateway-process-argv.js";
import { captureStalledGatewayStartup } from "./gateway-startup-owner.js";
import {
  acquireGatewayStateOwner,
  createGatewayStateProjection,
  type GatewayStateProjection,
  GatewayStateOwnerContentionError,
  resolveGatewayStateOwnerPath,
  tryBorrowGatewayStateOwner,
} from "./gateway-state-owner.js";

export type GatewayLockHandle = {
  lockPath: string;
  stateLockPath: string;
  stateDir: string;
  assertCurrent(this: void, assertPolicy?: () => void, access?: "read"): void;
  assertDatabaseAccess(this: void, databasePath: string): void;
  release: () => Promise<void>;
  run<T>(operation: () => T): T;
  markListening?: () => void;
};

export type GatewayLockOptions = {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  lifecycleDeadlineMs?: number;
  pollIntervalMs?: number;
  allowInTests?: boolean;
  platform?: NodeJS.Platform;
  port?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  lockDir?: string;
  role?: GatewayLockRole;
  assertCurrent?: () => void;
  onWait?: (message: string) => void;
  /** Internal offline port recovery; validated only after acquiring fresh physical custody. */
  databasePortRecovery?: DatabasePortRecoveryIntent;
  /** Config-only repairs retain file custody without inspecting or admitting database work. */
  databaseAccess?: "none";
  listenerMode?: "foreground" | "supervised";
  supervisor?: GatewayOwnerSupervisor | null;
  /**
   * Mobile boot profile (fork: A1 + F2), resolved once per process and
   * threaded in by the CLI gateway-run path / `startGatewayServer`. When
   * `singleOwner` is true the F2 fast-path applies (see `acquireGatewayLock`):
   * file-lock projection + lease assertion skipped, contention deadline
   * shortened to `MOBILE_SINGLE_OWNER_LOCK_TIMEOUT_MS`, and
   * `isPidDefinitelyDead` suffices to reclaim an `"unknown"`-namespace owner.
   * Omitted (or `singleOwner: false`) is pure upstream behavior. The
   * exclusive TCP bind on the gateway port (N2, `listenGatewayHttpServer`)
   * is NEVER skipped — it is the last guard that makes the fast-path safe.
   */
  mobileBoot?: MobileBootOptions;
};

export const GATEWAY_LIFECYCLE_LOCK_TIMEOUT_MS = 5 * 60_000;
/**
 * F2 single-owner contention deadline (fork: Lane C): 30 s — 10× the
 * clean-lock cost (1,6 dtk [LAB], Lane A baseline), 10× shorter than the
 * upstream 300 s worst case. Bounds only the wait for an owner that cannot
 * be proven dead; a provably-dead owner is reclaimed immediately.
 */
export const MOBILE_SINGLE_OWNER_LOCK_TIMEOUT_MS = 30_000;
const log = createSubsystemLogger("gateway");

export type GatewayLockIdentity = {
  pid: number;
  ownerId?: string;
  cronOwnerProjection?: "dynamic-default-v1";
  createdAt: string;
  port: number;
  startTime?: number;
};

export function isSameGatewayLockIdentity(
  previous: GatewayLockIdentity,
  current: GatewayLockIdentity,
): boolean {
  if (previous.ownerId && current.ownerId) {
    return previous.ownerId === current.ownerId;
  }
  return (
    previous.pid === current.pid &&
    previous.createdAt === current.createdAt &&
    previous.startTime === current.startTime
  );
}

export class GatewayLockError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
    public readonly databasePath?: string,
  ) {
    super(message);
    this.name = "GatewayLockError";
  }
}

export function isGatewayLifecycleContentionError(error: unknown): boolean {
  return (
    error instanceof GatewayLockError && error.cause instanceof GatewayStateOwnerContentionError
  );
}

type LockOwnerStatus = "alive" | "dead" | "unknown";

const CMDLINE_EXEC_TIMEOUT_MS = 1000;

function resolveGatewayOwnerStatusSync(
  pid: number,
  payload: LockPayload | null,
  platform: NodeJS.Platform,
  opts: {
    trustUnknownCmdlineOwner?: boolean;
    deadlineMs?: number;
    signal?: AbortSignal;
    lockPath?: string;
    /**
     * F2 single-owner mode (fork: Lane C). When true, an `"unknown"`
     * owner namespace no longer blocks reclamation of a provably-dead
     * PID — see the branch below. Default false (upstream behavior).
     */
    singleOwner?: boolean;
  } = {},
): LockOwnerStatus {
  const remainingTimeoutMs = () => {
    opts.signal?.throwIfAborted();
    const remaining =
      opts.deadlineMs === undefined ? CMDLINE_EXEC_TIMEOUT_MS : opts.deadlineMs - performance.now();
    if (remaining <= 0) {
      throw new GatewayLockError("Gateway lock inspection deadline expired");
    }
    return Math.max(1, Math.min(CMDLINE_EXEC_TIMEOUT_MS, Math.ceil(remaining)));
  };
  remainingTimeoutMs();
  const namespace = classifyGatewayLockProcessNamespace(payload, opts.lockPath);
  if (namespace !== "same") {
    // F2 (fork: Lane C, single-owner mode only): the namespace cannot be
    // classified across a restart under PRoot/Groot (D-12), so an
    // "unknown" namespace must not by itself block reclamation of a
    // provably-dead owner — Polones guarantees from outside that no live
    // second Gateway exists. `isPidDefinitelyDead` (kill ESRCH + no
    // /proc/<pid>/status) is the only weaker proof accepted, and only
    // here. Anything not provably dead stays "unknown" and still waits
    // out the (shortened) contention deadline instead of being reclaimed.
    if (namespace === "unknown" && opts.singleOwner === true && isPidDefinitelyDead(pid)) {
      return "dead";
    }
    return namespace;
  }
  const role = payload?.role ?? "gateway";
  if (!isPidAlive(pid)) {
    return isPidDefinitelyDead(pid) ? "dead" : "unknown";
  }

  // Process start identity catches PID recycling even when the replacement
  // process has the same argv shape.
  const payloadStartTime = payload?.startTime;
  if (Number.isFinite(payloadStartTime)) {
    const currentStartTime = readGatewayLockProcessStartTime(pid, platform, remainingTimeoutMs());
    remainingTimeoutMs();
    if (currentStartTime != null) {
      return currentStartTime === payloadStartTime ? "alive" : "dead";
    }
  }

  const embedded =
    role === "agent-embedded" || role === "sqlite-maintenance" || role === "skill-workshop-apply";
  const args = readGatewayLockProcessCmdline(pid, platform, remainingTimeoutMs(), opts.deadlineMs);
  remainingTimeoutMs();
  if (!args) {
    // An unavailable command observation cannot prove that the owner stopped.
    return embedded || platform === "linux" || opts.trustUnknownCmdlineOwner === false
      ? "unknown"
      : "alive";
  }
  // Embedded agents cover every state-writing command; maintenance roles require
  // an OpenClaw command. Gateway classification also recognizes retitled processes.
  const command =
    role === "agent-embedded" || role === "sqlite-maintenance"
      ? undefined
      : role === "skill-workshop-apply"
        ? "skills"
        : "gateway";
  const identity = classifyOpenClawArgv(args, command ? { command, pid } : { pid });
  remainingTimeoutMs();
  return identity.kind === "openclaw" ? "alive" : "unknown";
}

export async function resolveGatewayOwnerStatus(
  ...args: Parameters<typeof resolveGatewayOwnerStatusSync>
): Promise<LockOwnerStatus> {
  return resolveGatewayOwnerStatusSync(...args);
}

export async function readLockPayload(
  lockPath: string,
  requireInspection = false,
  signal?: AbortSignal,
): Promise<LockPayload | null> {
  try {
    const payload = parseGatewayLockPayload(
      await fs.readFile(lockPath, { encoding: "utf8", signal }),
    );
    if (requireInspection && !payload) {
      throw new GatewayLockError("Gateway lock payload could not be verified");
    }
    return payload;
  } catch (error) {
    signal?.throwIfAborted();
    if (requireInspection && !hasErrnoCode(error, "ENOENT")) {
      throw new GatewayLockError("Gateway lock inspection is unavailable", error);
    }
    return null;
  }
}

/** Read the same lock contract while a synchronous mutation admission is held. */
export function readLockPayloadSync(
  lockPath: string,
  requireInspection = false,
): LockPayload | null {
  try {
    const payload = parseGatewayLockPayload(fsSync.readFileSync(lockPath, "utf8"));
    if (requireInspection && !payload) {
      throw new GatewayLockError("Gateway lock payload could not be verified");
    }
    return payload;
  } catch (error) {
    if (requireInspection && !hasErrnoCode(error, "ENOENT")) {
      throw new GatewayLockError("Gateway lock inspection is unavailable", error);
    }
    return null;
  }
}

function shouldReclaimGatewayLock(params: {
  lockPath: string;
  payload: LockPayload | null;
  platform: NodeJS.Platform;
  /**
   * F2 single-owner mode (fork: Lane C). When true, a provably-dead PID
   * is reclaimable even when its namespace is `"unknown"` (D-12) — the
   * same weaker proof as in `resolveGatewayOwnerStatusSync`. Anything
   * not provably dead still throws, exactly as upstream.
   */
  singleOwner?: boolean;
}): boolean {
  if (classifyGatewayLockProcessNamespace(params.payload, params.lockPath) === "unknown") {
    // F2: see `resolveGatewayOwnerStatusSync` — same weaker proof, same
    // single-owner-only scope. (In single-owner mode the file-lock
    // projection this guards is skipped outright, so this branch is
    // defense-in-depth for any future caller that reclaims through here.)
    const ownerPid = params.payload?.pid;
    if (
      params.singleOwner === true &&
      ownerPid !== undefined &&
      Number.isSafeInteger(ownerPid) &&
      isPidDefinitelyDead(ownerPid)
    ) {
      return true;
    }
    throw new GatewayLockNamespaceError(params.payload ?? {}, params.lockPath);
  }
  const ownerPid = params.payload?.pid;
  const ownerStatus = ownerPid
    ? resolveGatewayOwnerStatusSync(ownerPid, params.payload, params.platform, {
        lockPath: params.lockPath,
        singleOwner: params.singleOwner,
      })
    : "unknown";
  if (ownerPid) {
    return ownerStatus === "dead";
  }
  return false;
}

export function resolveGatewayLockPaths(env: NodeJS.ProcessEnv, suppliedLockDir?: string) {
  const resolvedStateDir = resolveStateDir(env);
  const stateDir = resolveIdentityPathViaExistingAncestorSync(resolvedStateDir);
  const lockDir = suppliedLockDir ?? resolveGatewayLockDir(stateDir);
  const configPath = resolveConfigPath(env, resolvedStateDir);
  const configHash = sha256HexPrefixCore(configPath, 8);
  return {
    configLockPath: path.join(lockDir, `gateway.${configHash}.lock`),
    configPath,
    stateDir,
    stateLockPath: path.join(lockDir, "gateway.state.lock"),
    ownerLockPath: resolveGatewayStateOwnerPath(path.join(stateDir, "state", "openclaw.sqlite")),
  };
}

type GatewayLockObservationOptions = Pick<
  GatewayLockOptions,
  "env" | "lockDir" | "platform" | "timeoutMs"
> & { requireInspection?: boolean; signal?: AbortSignal };

type GatewayLockOwnerIdentity = Omit<GatewayLockIdentity, "port"> & { port?: number };
type GatewayStateOwnerObservationOptions = GatewayLockObservationOptions & {
  /** Include embedded custody and Gateways that have not opened their listener yet. */
  includeEmbedded?: boolean;
};

export async function readActiveGatewayLockPort(
  opts: GatewayLockObservationOptions = {},
): Promise<number | undefined> {
  return (await readActiveGatewayLockIdentity(opts))?.port;
}

export function readActiveGatewayLockIdentity(
  opts: GatewayLockObservationOptions & { includeEmbedded: true },
): Promise<GatewayLockOwnerIdentity | undefined>;
export function readActiveGatewayLockIdentity(
  opts?: GatewayLockObservationOptions & { includeEmbedded?: false },
): Promise<GatewayLockIdentity | undefined>;
export async function readActiveGatewayLockIdentity(
  opts: GatewayStateOwnerObservationOptions = {},
): Promise<GatewayLockOwnerIdentity | undefined> {
  const env = opts.env ?? process.env;
  const deadlineMs =
    opts.timeoutMs === undefined ? undefined : performance.now() + Math.max(0, opts.timeoutMs);
  const { configLockPath, stateLockPath, ownerLockPath } = resolveGatewayLockPaths(
    env,
    opts.lockDir,
  );
  const ownerIdentity = await readVerifiedGatewayLockIdentity(ownerLockPath, opts, deadlineMs);
  if (ownerIdentity) {
    return ownerIdentity;
  }
  const configIdentity = await readVerifiedGatewayLockIdentity(configLockPath, opts, deadlineMs);
  return configIdentity ?? (await readVerifiedGatewayLockIdentity(stateLockPath, opts, deadlineMs));
}

async function readVerifiedGatewayLockIdentity(
  lockPath: string,
  opts: GatewayStateOwnerObservationOptions,
  deadlineMs: number | undefined,
): Promise<GatewayLockOwnerIdentity | undefined> {
  const assertActive = () => {
    opts.signal?.throwIfAborted();
    if (deadlineMs !== undefined && performance.now() >= deadlineMs) {
      throw new GatewayLockError("Gateway lock inspection deadline expired");
    }
  };
  assertActive();
  const payload = await readLockPayload(lockPath, opts.requireInspection, opts.signal);
  assertActive();
  if (
    !payload ||
    (payload.role &&
      payload.role !== "gateway" &&
      !(opts.includeEmbedded && payload.role === "agent-embedded"))
  ) {
    return undefined;
  }
  if (
    opts.requireInspection &&
    classifyGatewayLockProcessNamespace(payload, lockPath) === "unknown"
  ) {
    const error = new GatewayLockNamespaceError(payload, lockPath);
    throw new GatewayLockError(error.message, error);
  }
  const ownerStatus = await resolveGatewayOwnerStatus(
    payload.pid,
    payload,
    opts.platform ?? process.platform,
    { trustUnknownCmdlineOwner: false, deadlineMs, signal: opts.signal, lockPath },
  );
  assertActive();
  // Discovery may omit an unverifiable owner; mutation preflight must preserve unknown.
  if (
    opts.requireInspection &&
    ownerStatus !== "dead" &&
    (ownerStatus === "unknown" || (!opts.includeEmbedded && !payload.port))
  ) {
    throw new GatewayLockError("Gateway lock owner identity could not be verified");
  }
  if (ownerStatus !== "alive" || (!opts.includeEmbedded && !payload.port)) {
    return undefined;
  }
  return {
    pid: payload.pid,
    ...(payload.ownerId ? { ownerId: payload.ownerId } : {}),
    ...(payload.cronOwnerProjection ? { cronOwnerProjection: payload.cronOwnerProjection } : {}),
    createdAt: payload.createdAt,
    port: payload.port,
    ...(payload.startTime !== undefined ? { startTime: payload.startTime } : {}),
  };
}

/** Older supported Gateways publish state-local sidecars; never start over their live owner. */
async function assertHistoricalGatewayOwnerStopped(
  paths: ReturnType<typeof resolveGatewayLockPaths>,
  opts: GatewayLockOptions,
  /**
   * F2 single-owner mode (fork: Lane C). When true, a historical owner
   * whose namespace is `"unknown"` but whose PID is provably dead is
   * treated as stopped (same weaker proof as `resolveGatewayOwnerStatusSync`).
   * A live or unverifiable owner still refuses startup, exactly as upstream.
   */
  singleOwner = false,
): Promise<void> {
  for (const lockPath of [paths.stateLockPath, paths.configLockPath]) {
    const payload = await readLockPayload(lockPath, true);
    if (!payload) {
      continue;
    }
    if (classifyGatewayLockProcessNamespace(payload, lockPath) === "unknown") {
      // F2: a provably-dead historical owner is not a live owner, even
      // when its namespace cannot be classified (D-12). Polones sweeps
      // these sidecars before spawn, so in the Polones flow this file
      // should not exist at all — this branch only covers a sweep that
      // missed one, or a lab run.
      if (singleOwner && Number.isSafeInteger(payload.pid) && isPidDefinitelyDead(payload.pid)) {
        continue;
      }
      throw new GatewayLockNamespaceError(payload, lockPath);
    }
    const owner = await resolveGatewayOwnerStatus(
      payload.pid,
      payload,
      opts.platform ?? process.platform,
      { trustUnknownCmdlineOwner: false, lockPath, singleOwner },
    );
    if (owner !== "dead") {
      throw new GatewayStateOwnerContentionError(
        path.join(paths.stateDir, "state", "openclaw.sqlite"),
        undefined,
        describeGatewayLockHolder(payload, lockPath, owner === "alive" ? "live" : "unknown"),
        { pid: payload.pid, role: payload.role },
      );
    }
  }
}

export async function acquireGatewayLock(
  opts: GatewayLockOptions = {},
): Promise<GatewayLockHandle | null> {
  const env = opts.env ?? process.env;
  if (opts.allowInTests !== true && (env.VITEST || env.NODE_ENV === "test")) {
    return null;
  }
  // F2 single-owner fast-path (fork: Lane C). Active ONLY when the mobile
  // profile is on AND the single-owner switch is set (both resolved once per
  // process by `resolveMobileBootOptions`, threaded in via `opts.mobileBoot`).
  // The caller asserts the Polones external guarantee (one daemon, one slot
  // per harness, lock + lease swept before spawn). Default (no `mobileBoot`)
  // is pure upstream behavior (N10). The exclusive TCP bind (N2) is untouched.
  const singleOwner = opts.mobileBoot?.enabled === true && opts.mobileBoot.singleOwner === true;
  if (singleOwner) {
    log.warn(
      "mobile single-owner lock fast-path enabled (OPENCLAW_MOBILE_SINGLE_OWNER=1): file-lock " +
        "projection + owner-lease assertion skipped; a provably-dead owner is reclaimed even " +
        "with an unknown namespace. Only safe under the Polones external guarantee; never enable outside Polones.",
    );
  }
  // Ordinary process roles admit database access directly; config repair needs the maintenance guard.
  const role = opts.databaseAccess === "none" ? "sqlite-maintenance" : (opts.role ?? "gateway");
  const paths = resolveGatewayLockPaths(env, opts.lockDir);
  const databasePath = path.join(paths.stateDir, "state", "openclaw.sqlite");
  const now = opts.now ?? performance.now.bind(performance);
  const startedAt = now();
  const heartbeatWaitMs = GATEWAY_OWNER_HEARTBEAT_STALE_MS + 5_000;
  const heartbeatDeadlineMs = startedAt + heartbeatWaitMs;
  const gatewayTimeoutMs = singleOwner
    ? MOBILE_SINGLE_OWNER_LOCK_TIMEOUT_MS
    : GATEWAY_LIFECYCLE_LOCK_TIMEOUT_MS;
  const timeoutMs = resolveTimerTimeoutMs(
    opts.timeoutMs,
    role === "gateway" ? gatewayTimeoutMs : role === "sqlite-maintenance" ? heartbeatWaitMs : 0,
    0,
  );
  const deadlineMs = Math.min(opts.lifecycleDeadlineMs ?? Infinity, startedAt + timeoutMs);
  const startTime = readGatewayLockProcessStartTime(
    process.pid,
    opts.platform ?? process.platform,
    CMDLINE_EXEC_TIMEOUT_MS,
  );
  const payload: LockPayload = {
    pid: process.pid,
    ownerId: randomUUID(),
    createdAt: resolveTimestampMsToIsoString(Date.now()),
    ...(role === "gateway" ? { startupPhase: "starting" as const } : {}),
    configPath: paths.configPath,
    stateDir: paths.stateDir,
    role,
    processNamespace: readGatewayLockProcessNamespace(),
    machineIdentity: process.platform === "darwin" ? readProcessMachineIdentity() : undefined,
    ...(role === "gateway" ? { cronOwnerProjection: "dynamic-default-v1" as const } : {}),
    ...(typeof opts.port === "number" &&
    Number.isInteger(opts.port) &&
    opts.port > 0 &&
    opts.port <= 65_535
      ? { port: opts.port }
      : {}),
    ...(typeof startTime === "number" && Number.isFinite(startTime) ? { startTime } : {}),
  };
  const parentMaintenance = getOpenClawDatabaseMaintenanceScope();
  let borrowedOwner: ReturnType<typeof tryBorrowGatewayStateOwner>;
  if (role === "sqlite-maintenance" && parentMaintenance?.ownsSchemaMaintenance) {
    parentMaintenance.assertAdmission();
    borrowedOwner = tryBorrowGatewayStateOwner(databasePath);
  }
  let databaseFailure: { error: unknown } | undefined;
  let waited = false;
  let projection: GatewayStateProjection | undefined;
  let stateOwner: ReturnType<typeof acquireGatewayStateOwner>;
  try {
    stateOwner =
      borrowedOwner ??
      (await acquireWithWait({
        deadlineMs,
        pollIntervalMs: resolvePositiveTimerTimeoutMs(opts.pollIntervalMs, 250),
        now,
        sleep: opts.sleep,
        acquire: async () => {
          databaseFailure = undefined;
          opts.assertCurrent?.();
          payload.createdAt = resolveTimestampMsToIsoString(Date.now());
          const owner = acquireGatewayStateOwner({
            databasePath,
            payload,
            projectionPath: paths.stateLockPath,
            getProjection: () => projection,
            singleOwner,
          });
          try {
            if (opts.databasePortRecovery) {
              if (role !== "agent-embedded" && role !== "sqlite-maintenance") {
                throw new Error("Database port recovery requires exclusive offline ownership");
              }
              assertDatabasePortRecoveryAllowed(paths.stateDir, opts.databasePortRecovery);
            } else {
              assertDatabasePortStartupAllowed(paths.stateDir);
            }
            await assertHistoricalGatewayOwnerStopped(paths, opts, singleOwner);
            if (!opts.databasePortRecovery && opts.databaseAccess !== "none") {
              try {
                await owner.run(() => {
                  // Offline maintenance must refuse newer schemas before changing source files.
                  if (role === "gateway") {
                    ensureOpenClawStatePermissions(databasePath, env, { createDirectory: true });
                  }
                  // F2 single-owner: skip the owner-lease assertion. Polones
                  // deletes the `gateway-owner` lease row before spawn, so
                  // there is nothing to assert — and a stale row left by a
                  // killed Gateway must not block this boot. The state-owner
                  // file (acquired above, with the weaker death proof) plus
                  // the exclusive TCP bind (N2) remain the guards.
                  if (!singleOwner) {
                    return assertGatewayOwnerLeaseStopped(
                      env,
                      owner,
                      role === "sqlite-maintenance",
                    );
                  }
                  return undefined;
                });
              } catch (error) {
                databaseFailure = { error };
                throw error;
              }
            }
            return owner;
          } catch (error) {
            owner.release();
            throw error;
          }
        },
        shouldRetry: (error) => {
          if (
            error instanceof GatewayLockNamespaceError &&
            (role === "gateway" || role === "sqlite-maintenance")
          ) {
            const remaining = Math.min(deadlineMs, heartbeatDeadlineMs) - now();
            if (remaining <= 0) {
              return false;
            }
            if (!waited) {
              (opts.onWait ?? log.warn)(
                `Waiting up to ${Math.ceil(remaining / 1000)} seconds for the previous Gateway to release state; an unverifiable owner will not be reclaimed automatically. ${error.message}`,
              );
            }
            waited = true;
            return { delayMs: Math.min(5_000, remaining) };
          }
          if (
            role === "sqlite-maintenance" ||
            !(error instanceof GatewayStateOwnerContentionError)
          ) {
            return false;
          }
          if (!waited && deadlineMs > startedAt && role === "gateway") {
            log.warn(
              `waiting for Gateway state ownership held by another OpenClaw process, up to ${Math.ceil((deadlineMs - startedAt) / 1000)} s`,
            );
          }
          waited = true;
          return true;
        },
      }));
  } catch (error) {
    opts.assertCurrent?.();
    const message = `failed to acquire gateway state ownership${waited ? `; waited ${Math.round(now() - startedAt)}ms for Gateway state ownership` : ""}`;
    const detail =
      error instanceof GatewayStateOwnerContentionError
        ? `${message}: ${error.message}. ${captureStalledGatewayStartup(env)?.description ?? "Stop the Gateway or wait for the current OpenClaw operation to finish"}. Run \`openclaw gateway stop\`, then retry.`
        : error instanceof GatewayLockNamespaceError
          ? error.message
          : error instanceof DatabasePortRecoveryError
            ? `${message}: ${error.message}`
            : message;
    throw new GatewayLockError(
      detail,
      error,
      databaseFailure && databaseFailure.error === error ? databasePath : undefined,
    );
  }
  if (waited && role === "gateway") {
    log.info(`Gateway state ownership acquired after ${((now() - startedAt) / 1000).toFixed(1)} s`);
  }
  const assertStateOwnerCurrent = (assertPolicy?: () => void, access?: "read") => {
    if (borrowedOwner) {
      parentMaintenance?.assertOwnerCurrent(access);
    }
    stateOwner.assertCurrent();
    if (
      role !== "gateway" &&
      role !== "agent-embedded" &&
      projection &&
      !projection.verifyStillHeld()
    ) {
      throw new Error("OpenClaw Gateway ownership projection is no longer current");
    }
    if (assertPolicy) {
      // Synchronous policy reads borrow storage custody without transferring resource ownership.
      stateOwner.run(assertPolicy);
      assertStateOwnerCurrent(undefined, access);
    }
  };
  const assertDatabaseAccess = (requestedPath: string) => {
    assertStateOwnerCurrent();
    if (opts.databaseAccess === "none") {
      throw new Error("Config-only ownership does not admit database access");
    }
    stateOwner.assertDatabaseAccess(requestedPath);
  };
  const resources =
    role === "sqlite-maintenance"
      ? createOpenClawDatabaseMaintenanceScope({
          schemaMaintenance: true,
          assertOwnerCurrent: (access) => assertStateOwnerCurrent(undefined, access),
          assertDatabaseAccess,
        })
      : undefined;
  let ownerLease: GatewayOwnerLease | undefined;
  try {
    assertStateOwnerCurrent(opts.assertCurrent);
    // Shipped Gateways discover this PID sidecar before starting. Synchronous
    // schema work retains the same fs-safe owner through its final reference.
    const shouldReclaim = ({ payload: previous }: { payload: unknown }) =>
      shouldReclaimGatewayLock({
        lockPath: paths.stateLockPath,
        payload: LockPayloadSchema.safeParse(previous).data ?? null,
        platform: opts.platform ?? process.platform,
        singleOwner,
      });
    if (!borrowedOwner && !singleOwner) {
      // F2 single-owner: skip the `gateway.state.lock` file-lock
      // projection entirely. Polones already guarantees exclusivity from
      // outside (and sweeps this file before spawn), so the projection
      // buys nothing here — and creating it would re-impose the exact
      // stale-lock wait this fast-path removes. The state-owner file
      // (acquired above) stays the on-disk ownership record, and the
      // exclusive TCP bind (N2) stays the live-process guard. Upstream
      // (singleOwner false) always creates the projection, as before.
      projection = createGatewayStateProjection(
        acquireFileLockSync(paths.stateLockPath, {
          lockPath: paths.stateLockPath,
          timeoutMs: 0,
          retry: { retries: 0 },
          staleRecovery: "remove-if-unchanged",
          reentrantOwner: payload.ownerId,
          payload: () => (role === "gateway" ? payload : { ...payload, role: "agent-embedded" }),
          shouldReclaim,
          shouldRemoveStaleLock: shouldReclaim,
        }),
      );
    }
    assertStateOwnerCurrent();
    if (role === "gateway" && opts.listenerMode && opts.port) {
      try {
        ownerLease = acquireGatewayOwnerLease({
          env,
          port: opts.port,
          mode: opts.listenerMode,
          supervisor: opts.supervisor ?? null,
          owner: payload.ownerId,
        });
        await ownerLease.ready;
      } catch (error) {
        databaseFailure = { error };
        throw error;
      }
    }
  } catch (error) {
    await ownerLease?.release();
    projection?.release();
    stateOwner.release();
    throw new GatewayLockError(
      "failed to acquire gateway state ownership",
      error,
      databaseFailure && databaseFailure.error === error ? databasePath : undefined,
    );
  }
  let released: Promise<void> | undefined;
  return {
    lockPath: stateOwner.path,
    stateLockPath: paths.stateLockPath,
    stateDir: paths.stateDir,
    assertCurrent: assertStateOwnerCurrent,
    assertDatabaseAccess,
    markListening: () => {
      assertStateOwnerCurrent();
      try {
        ownerLease?.markListening();
      } catch {
        assertStateOwnerCurrent();
        log.warn("Gateway listener bound, but startup readiness could not be recorded");
      }
    },
    run: (operation) => {
      if (resources) {
        // Reenter held custody before policy reads inspect this scope's database handles.
        return resources.run(operation);
      }
      assertStateOwnerCurrent();
      return operation();
    },
    release: () =>
      (released ??= (async () => {
        await ownerLease?.release();
        await resources?.close();
        projection?.release();
        projection = undefined;
        stateOwner.release();
      })().catch((error: unknown) => {
        released = undefined;
        throw error;
      })),
  };
}
