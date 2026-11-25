import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getCliParentPid } from "../../cli-parent-lifetime.mjs";
import { isForegroundGatewayRunArgv } from "../../gateway-run-argv.mjs";
import {
  getFileLockProcessStartTime,
  isPidAlive,
  isPidDefinitelyDead,
} from "../shared/pid-alive.js";
import { resolveOpenClawStateDirForDatabasePath } from "../state/openclaw-state-db.paths.js";
import { readProcessMachineIdentity } from "./current-machine-identity.js";
import { acquireFileLockSync } from "./file-lock-manager.js";
import {
  classifyGatewayLockProcessNamespace,
  describeGatewayLockHolder,
  LockPayloadSchema,
  GatewayLockNamespaceError,
  parseGatewayLockPayload,
  readGatewayLockProcessNamespace,
  type LockPayload,
} from "./gateway-lock-payload.js";
import { classifyOpenClawArgv } from "./gateway-process-argv.js";
import {
  ensureOwnerDirectory,
  resolveStateOwnerIdentity,
  type StateOwnerDirectoryIdentity,
} from "./gateway-state-owner-directory.js";
import {
  GatewayStateOwnerContentionError,
  StateDatabaseAccessError,
  StateDatabaseAdmissionPendingError,
  StateDatabaseOfflineMaintenanceError,
} from "./gateway-state-owner-errors.js";
import { inspectStaleLockOwner } from "./stale-lock-file.js";

const ownerInspections = new AsyncLocalStorage<{ deadOwner?: { path: string; raw: string } }>();

/** Retain only one exact dead owner, and only during this admission operation. */
export function withPersistedStateOwnerInspection<T>(operation: () => T): T {
  return ownerInspections.run({}, operation);
}

function comparableStateOwnerStaleReason(
  payload: Record<string, unknown>,
  namespace: "same" | "dead" | "unknown",
): "owner-process-exited" | "owner-starttime-changed" | undefined {
  return namespace === "dead"
    ? "owner-process-exited"
    : namespace === "same"
      ? inspectStaleLockOwner({ payload: { pid: payload.pid, starttime: payload.startTime } })
          ?.reason
      : undefined;
}

/**
 * Reclamation requires proof that the recorded owner stopped.
 *
 * F2 single-owner mode (fork: Lane C, `options.singleOwner === true`):
 * an `"unknown"` namespace no longer blocks reclamation when the recorded
 * PID is provably dead (`isPidDefinitelyDead`: kill ESRCH + no
 * `/proc/<pid>/status`). Under PRoot/Groot the namespace cannot be
 * classified across a restart (D-12: no PID namespace isolates the numbers,
 * no guest init protects PID 1), so without this weaker proof every dirty
 * boot would wait out the full contention deadline. The weaker proof is
 * ONLY accepted in single-owner mode — Polones guarantees from outside
 * that no live second Gateway exists — and only for a PID that is
 * provably dead; a live or merely unverifiable PID still throws, exactly
 * as upstream, and still waits out the (shortened) deadline.
 */
export function isGatewayStateOwnerDefinitelyStale(
  value: unknown,
  lockPath: string,
  options: { singleOwner?: boolean } = {},
): boolean {
  const payload = isRecord(value) ? value : null;
  if (!payload) {
    // Exclusive creation precedes publication; an incomplete record still owns its lock.
    return false;
  }
  const namespace = classifyGatewayLockProcessNamespace(payload, lockPath);
  if (namespace === "unknown") {
    // F2: see the doc comment above. `payload.pid` comes from an
    // untrusted on-disk record, so it is validated before use.
    if (
      options.singleOwner === true &&
      Number.isSafeInteger(payload.pid) &&
      typeof payload.pid === "number" &&
      isPidDefinitelyDead(payload.pid)
    ) {
      return true;
    }
    throw new GatewayLockNamespaceError(payload, lockPath);
  }
  return comparableStateOwnerStaleReason(payload, namespace) !== undefined;
}

export {
  GatewayStateOwnerContentionError,
  StateDatabaseAdmissionPendingError,
  StateDatabaseMaintenanceScopeError,
  StateDatabaseOfflineMaintenanceError,
} from "./gateway-state-owner-errors.js";

export const isStateDatabaseMaintenanceContention = (error: unknown): boolean =>
  error instanceof AggregateError
    ? error.errors.length > 0 && error.errors.every(isStateDatabaseMaintenanceContention)
    : error instanceof StateDatabaseAdmissionPendingError ||
      error instanceof StateDatabaseOfflineMaintenanceError;

/** Persisted ownership can identify a holder but cannot lend this process maintenance authority. */
export function assertPersistedStateDatabaseAccessAllowed(params: {
  databasePath: string;
  ownerPath: string;
  assertMaintenance: () => void;
}): void {
  const { databasePath, ownerPath, assertMaintenance } = params;
  const unavailable = `OpenClaw state ownership at ${databasePath} could not be verified from ${ownerPath}; restart the Gateway.`;
  let raw: string;
  try {
    raw = fs.readFileSync(ownerPath, "utf8");
  } catch (error) {
    if (extractErrorCode(error) === "ENOENT") {
      return;
    }
    throw new StateDatabaseAccessError(unavailable, { cause: error });
  }
  const inspection = ownerInspections.getStore();
  if (inspection?.deadOwner?.path === ownerPath && inspection.deadOwner.raw === raw) {
    return;
  }
  const owner = parseGatewayLockPayload(raw);
  if (!owner) {
    // Native exclusive creation precedes the payload write; cold admission may wait for publication.
    throw new StateDatabaseAdmissionPendingError(databasePath, unavailable);
  }
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    throw new StateDatabaseAccessError(unavailable);
  }
  // Ordinary SQLite access does not reclaim the owner or borrow schema custody.
  // Unknown namespaces retain maintenance contention without probing a local PID.
  const namespace = classifyGatewayLockProcessNamespace(owner, ownerPath);
  const staleReason = comparableStateOwnerStaleReason(owner, namespace);
  if (staleReason) {
    if (inspection && staleReason === "owner-process-exited") {
      inspection.deadOwner = { path: ownerPath, raw };
    }
    return;
  }
  // Workers share the process PID, but their schema authority still comes from
  // the host operation's retained lease and is never inferred from this record.
  if (namespace === "same" && owner.pid === process.pid && !isMainThread) {
    return;
  }
  if (namespace === "same" && !isPidAlive(owner.pid)) {
    // The owner can exit after the stale check. Cold admission must re-observe
    // proof of death, not treat this transient disagreement as a terminal failure.
    throw new StateDatabaseAdmissionPendingError(databasePath, unavailable);
  }
  const role = owner.role ?? "gateway";
  if (role === "gateway" || role === "agent-embedded") {
    return;
  }
  if (namespace === "same" && owner.pid === process.pid) {
    assertMaintenance();
    return;
  }
  const maintenancePending = `OpenClaw state at ${databasePath} is undergoing offline maintenance by ${role} process ${owner.pid} (ownerKind=${owner.stateOwnerKind ?? "process"}); retry when it finishes. For update progress, run \`openclaw update status --json\`.`;
  if (owner.stateOwnerKind === "schema" && owner.role === "sqlite-maintenance") {
    throw new StateDatabaseAdmissionPendingError(databasePath, maintenancePending);
  }
  throw new StateDatabaseOfflineMaintenanceError(databasePath, maintenancePending);
}

export function defaultPayload(databasePath: string): LockPayload {
  const stateDir = resolveOpenClawStateDirForDatabasePath(databasePath);
  const startTime = getFileLockProcessStartTime(process.pid);
  const parentPid = getCliParentPid();
  const parentStartTime = parentPid === undefined ? null : getFileLockProcessStartTime(parentPid);
  return {
    pid: process.pid,
    ownerId: randomUUID(),
    createdAt: new Date().toISOString(),
    stateDir,
    configPath: path.join(stateDir, "openclaw.json"),
    role: "sqlite-maintenance",
    processNamespace: readGatewayLockProcessNamespace(),
    machineIdentity: process.platform === "darwin" ? readProcessMachineIdentity() : undefined,
    ...(parentPid === undefined ? {} : { parentPid }),
    ...(parentStartTime === null ? {} : { parentStartTime }),
    ...(startTime === null ? {} : { startTime }),
  };
}

/** Keep queued CLI schema preparation behind the Gateway while Doctor restores its stop. */
export function reserveGatewayStateRestoration(
  databasePath: string,
  assertOwnerCurrent: () => void,
) {
  assertOwnerCurrent();
  const lockPath = `${resolveStateOwnerIdentity(databasePath).ownerPath}.gateway-restoration`;
  const payload = defaultPayload(databasePath);
  const stale = ({ payload: previous }: { payload: unknown }) =>
    isGatewayStateOwnerDefinitelyStale(previous, lockPath);
  const lock = acquireFileLockSync(lockPath, {
    lockPath,
    timeoutMs: 0,
    retry: { retries: 0 },
    staleMs: Infinity,
    staleRecovery: "remove-if-unchanged",
    payload: () => {
      assertOwnerCurrent();
      return payload;
    },
    shouldReclaim: stale,
    shouldRemoveStaleLock: stale,
  });
  let released = false;
  return {
    assertCurrent() {
      if (released || !lock.verifyStillHeld()) {
        throw new Error("Gateway restoration reservation is no longer current.");
      }
    },
    release() {
      lock.release();
      released = true;
    },
  };
}

function assertGatewayRestorationPriority(
  databasePath: string,
  restorationPath: string,
  payload: LockPayload,
): void {
  if (payload.role === "gateway") {
    return;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(restorationPath, "utf8");
  } catch (error) {
    if (extractErrorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }
  const reservation = parseGatewayLockPayload(raw);
  if (
    isGatewayStateOwnerDefinitelyStale(reservation, restorationPath) ||
    reservation?.pid === payload.pid
  ) {
    return;
  }
  // Gateway bootstrap may need schema admission before acquiring its process root.
  if (
    payload.pid === process.pid &&
    isForegroundGatewayRunArgv(process.argv) &&
    classifyOpenClawArgv(process.argv, { command: "gateway" }).kind === "openclaw"
  ) {
    return;
  }
  throw new StateDatabaseAdmissionPendingError(
    databasePath,
    `Gateway restoration has priority for OpenClaw state at ${databasePath}; retry when it finishes.`,
  );
}

export function acquireGatewayStateOwnerFile(
  databasePath: string,
  pathname: string,
  payload: LockPayload,
  busyTimeoutMs = 0,
  createdDirectories?: StateOwnerDirectoryIdentity[],
  /**
   * F2 single-owner mode (fork: Lane C). Threaded to
   * `isGatewayStateOwnerDefinitelyStale`: a stale owner whose namespace
   * is `"unknown"` is reclaimable when its PID is provably dead.
   * Default (omitted) is upstream behavior.
   */
  options: { singleOwner?: boolean } = {},
) {
  const deadline = performance.now() + busyTimeoutMs;
  const restorationPath = `${resolveStateOwnerIdentity(databasePath).ownerPath}.gateway-restoration`;
  assertGatewayRestorationPriority(databasePath, restorationPath, payload);
  ensureOwnerDirectory(path.dirname(pathname), createdDirectories);
  const observed: { holder: LockPayload | null } = { holder: null };
  const stale = ({ payload: value }: { payload: unknown }) => {
    observed.holder = LockPayloadSchema.safeParse(value).data ?? null;
    return isGatewayStateOwnerDefinitelyStale(observed.holder, pathname, options);
  };
  if (busyTimeoutMs > 0) {
    try {
      const previous = (observed.holder = parseGatewayLockPayload(
        fs.readFileSync(pathname, "utf8"),
      ));
      if (
        previous &&
        !isGatewayStateOwnerDefinitelyStale(previous, pathname, options) &&
        (previous.pid === process.pid ||
          ((previous.role ?? "gateway") === "gateway" && isPidAlive(previous.pid)))
      ) {
        // A serving Gateway cannot lend schema authority. An unregistered local
        // holder may need this host to service grants, so it cannot be waited on.
        throw new GatewayStateOwnerContentionError(databasePath);
      }
    } catch (error) {
      if (extractErrorCode(error) !== "ENOENT") {
        throw error;
      }
    }
  }
  for (let retriedMissingParent = false; ;) {
    try {
      return acquireFileLockSync(pathname, {
        lockPath: pathname,
        retry:
          busyTimeoutMs > 0
            ? { factor: 1.25, minTimeout: 10, maxTimeout: 25, randomize: false }
            : { retries: 0 },
        timeoutMs: Math.max(0, Math.ceil(deadline - performance.now())),
        staleMs: Infinity,
        staleRecovery: "remove-if-unchanged",
        reentrantOwner: payload.ownerId,
        payload: () => {
          // Sync waiters can predate Doctor's reservation. Recheck every physical attempt.
          assertGatewayRestorationPriority(databasePath, restorationPath, payload);
          return payload;
        },
        // Reclamation validates foreign payloads; held custody compares exact bytes and token.
        shouldReclaim: stale,
        shouldRemoveStaleLock: stale,
      });
    } catch (error) {
      const code = extractErrorCode(error);
      if (code === "ENOENT" && !retriedMissingParent) {
        // Final lease cleanup can remove the parent before exclusive creation.
        // Recreate it once without extending the original contention budget.
        retriedMissingParent = true;
        ensureOwnerDirectory(path.dirname(pathname), createdDirectories);
        continue;
      }
      if (code === "file_lock_timeout" || code === "file_lock_stale") {
        const { holder } = observed;
        const holderDetail = describeGatewayLockHolder(
          holder ?? {},
          pathname,
          holder && isPidAlive(holder.pid) ? "live" : "unknown",
        );
        throw new GatewayStateOwnerContentionError(
          databasePath,
          error,
          holderDetail,
          holder ? { pid: holder.pid, role: holder.role } : undefined,
        );
      }
      throw error;
    }
  }
}
