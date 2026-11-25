import fs from "node:fs";
import path from "node:path";
import { formatCliCommand } from "../../cli/command-format.js";
import type { MobileBootOptions } from "../../gateway/mobile-boot.js";
import { withEngineStoreAdmission } from "../../infra/database-engine/admission-scope.js";
import {
  readDeferredPluginSessionImport,
  readStaleDeferredPluginSessionImport,
} from "../../infra/deferred-plugin-session-sources.js";
import { throwSqliteLifecycleErrors } from "../../infra/sqlite-lifecycle-errors.js";
import { recordStartupMigrationWarnings } from "../../infra/state-migrations.messages.js";
import { formatDoctorStateRepairFailure } from "../../infra/state-repair-message.js";
import { settleCurrentReadPreparations } from "../../shared/current-read-authority.js";
import { readAgentDatabaseAdmissionRefusal } from "../../state/agent-database-admission.js";
import { createAgentDatabaseDeletionClassifier } from "../../state/agent-deletion-discovery.js";
import {
  prepareAgentDatabaseDeletionSnapshotRead,
  readAgentDatabaseDeletionSnapshot,
} from "../../state/agent-deletion-journal.read.js";
import { AGENT_DATABASE_PREFLIGHT_CONCURRENCY } from "../../state/openclaw-agent-db-contract.js";
import { agentEngineInput } from "../../state/openclaw-agent-db-engine.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
  withOpenClawAgentDatabaseAsync,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { gatewayDiscoveryReadOptions } from "./combined-store-paths.js";
import {
  isLegacySessionRecordOwnedByTarget,
  listLegacySessionTranscriptFiles,
  readLegacySessionStoreEntries,
  shouldFilterLegacySessionRecordsByTarget,
} from "./legacy-store-inspection.js";
import { SessionStoreMigrationRequiredError } from "./migration-required.js";
import { resolveSqliteReadScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { isCanonicalSqliteSessionMainKeyCurrent } from "./session-canonical-key-read.js";
import { setCanonicalSqliteSessionMainKey } from "./session-canonical-key.js";
import { parseSqliteSessionEntryRecord } from "./session-entry-json.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target-paths.js";
import {
  resolveSqliteTargetFromSessionStorePath,
  type SessionStoreRegistryRead,
} from "./session-sqlite-target.js";
import {
  computeAgentDatabaseMigrationFingerprint,
  readSessionMigrationWatermarks,
  SESSION_MIGRATION_WATERMARK_AGENT_SCHEMA_VERSION,
  writeSessionMigrationWatermarks,
  type SessionMigrationWatermarkEntry,
} from "./startup-migration-watermark.js";
import {
  isConfiguredAgentDatabaseTarget,
  resolveAllAgentSessionStoreTargetsSync,
  resolveConfiguredAgentDatabaseCandidatePaths,
  resolveConfiguredAgentDatabaseTargets,
} from "./targets.js";

export type SessionStartupMigrationLogger = Record<"info" | "warn", (message: string) => void>;

export function assertSessionStoreMigrationComplete(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  targets?: readonly { agentId?: string; storePath: string }[];
  registeredDatabases?: SessionStoreRegistryRead;
  operation?: "doctor";
}): void {
  const env = params.env ?? process.env;
  const readOptions = { env, registeredDatabases: params.registeredDatabases };
  const targets = (
    params.targets ?? resolveAllAgentSessionStoreTargetsSync(params.cfg, readOptions)
  ).filter(
    (target) => !target.agentId || !readAgentDatabaseAdmissionRefusal(target.agentId, { env }),
  );
  const sourcesByPath = new Map<string, typeof targets>();
  for (const target of targets) {
    const sourcePath = path.resolve(target.storePath);
    sourcesByPath.set(sourcePath, [...(sourcesByPath.get(sourcePath) ?? []), target]);
  }
  const legacySources = [...sourcesByPath].filter(
    ([storePath]) => !storePath.endsWith(".sqlite") && fs.existsSync(storePath),
  );
  if (legacySources.length === 0) {
    return;
  }
  const deletionSnapshot = readAgentDatabaseDeletionSnapshot(
    env,
    params.operation === "doctor" ? "maintenance" : "runtime",
  );
  const classifyDeletion =
    deletionSnapshot &&
    createAgentDatabaseDeletionClassifier({
      env,
      retainedDeletions: deletionSnapshot.retainedDeletions,
      registeredAgentDatabases: deletionSnapshot.registeredAgentDatabases,
      configuredAgentDatabaseTargets: (excludeTarget) =>
        resolveConfiguredAgentDatabaseTargets(params.cfg, {
          ...readOptions,
          excludeTarget: (target) =>
            excludeTarget(
              resolveUnsuffixedSqliteTargetFromSessionStorePath(target.storePath).path,
              target.agentId,
            ),
        }),
    });
  const legacyStore = legacySources.find(([storePath, candidates]) => {
    type SourceOwner = {
      target: { agentId: string; storePath: string };
      destination: string;
      retained: boolean;
      imported: boolean;
    };
    const owners = new Map<string, SourceOwner>();
    for (const target of candidates) {
      if (!target.agentId) {
        return true;
      }
      const destination = resolveSqliteTargetFromSessionStorePath(target.storePath, {
        agentId: target.agentId,
        ...readOptions,
      }).path;
      const deletion =
        classifyDeletion?.(storePath, target.agentId) ??
        classifyDeletion?.(destination, target.agentId);
      const staleImport = readStaleDeferredPluginSessionImport({
        target: { ...target, agentId: target.agentId },
        sqlitePath: destination,
        env,
      });
      if (staleImport) {
        recordStartupMigrationWarnings([
          `Session import receipt belongs to another database; serving live SQLite at ${destination}. Run openclaw doctor --fix to recover retained history.`,
        ]);
      }
      // A foreign receipt leaves recovery inputs protected, not a migration veto on this database.
      const retained =
        (deletion !== undefined && deletion !== "unavailable") || Boolean(staleImport);
      owners.set(`${target.agentId}\0${destination}`, {
        target: { ...target, agentId: target.agentId },
        destination,
        retained,
        imported:
          !retained &&
          readDeferredPluginSessionImport({
            cfg: params.cfg,
            target: { ...target, agentId: target.agentId },
            sqlitePath: destination,
            env,
            purpose: "readiness",
          }) !== undefined,
      });
    }
    // A shared path still needs record-level ownership even when every candidate is held.
    if (
      [...owners.values()].every(
        ({ target, retained, imported }) =>
          (imported || retained) && !shouldFilterLegacySessionRecordsByTarget(target),
      )
    ) {
      return false;
    }
    // A roster entry is only a possible importer. Inspect retained source ownership
    // here, never in runtime session access, and bind parsed bytes to every receipt.
    const issues: Array<{ code: string; message: string; sessionKey?: string }> = [];
    const source = readLegacySessionStoreEntries({ storePath }, issues);
    if (issues.some((issue) => issue.code !== "entry_invalid") || !source.bytes) {
      return [...owners.values()].some(({ imported, retained }) => !imported && !retained);
    }
    // Empty indexes may have unindexed history: retain the existing requirement
    // for every named owner's verified receipt rather than infer ownership here.
    const required = new Set<SourceOwner>(source.entries.length === 0 ? owners.values() : []);
    for (const sessionKey of [
      ...source.entries.map((entry) => entry.sessionKey),
      ...issues.flatMap((issue) => (issue.sessionKey ? [issue.sessionKey] : [])),
    ]) {
      const matches = [...owners.values()].filter(
        ({ target }) =>
          !shouldFilterLegacySessionRecordsByTarget(target) ||
          isLegacySessionRecordOwnedByTarget(params.cfg, target, sessionKey),
      );
      if (matches.length !== 1) {
        return true;
      }
      required.add(matches[0]!);
    }
    let hasUnindexedHistory: boolean | undefined;
    return [...required].some(({ target, destination, retained, imported }) => {
      if (
        imported ||
        (retained &&
          (source.entries.length > 0 || !shouldFilterLegacySessionRecordsByTarget(target)))
      ) {
        return false;
      }
      // Owners without a database cannot have completed a core session import.
      // Without a receipt or unindexed history, demanding one deadlocks startup:
      // Doctor refuses to create a database just for the receipt.
      if (source.entries.length === 0 && !fs.existsSync(destination)) {
        hasUnindexedHistory ??=
          listLegacySessionTranscriptFiles(path.dirname(storePath)).length > 0;
        if (!hasUnindexedHistory) {
          return false;
        }
      }
      return true;
    });
  })?.[0];
  if (legacyStore) {
    throw new SessionStoreMigrationRequiredError(
      params.operation === "doctor"
        ? formatDoctorStateRepairFailure(
            `Legacy session store requires migration at ${legacyStore}`,
            "Repair the retained source using the migration report's named file and validation error, preserving the original history.",
          )
        : `Legacy session store requires migration: ${legacyStore}. Run "${formatCliCommand("openclaw doctor --fix", env)}" against the same state/config before starting OpenClaw.`,
    );
  }
}

/** Maintains existing stores, optionally handing each live database to its runtime owner. */
export async function runSessionStartupMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentIds?: ReadonlySet<string>;
  assertCurrent?: () => void;
  log: SessionStartupMigrationLogger;
  handoffDatabase?: (database: OpenClawAgentDatabaseOptions) => Promise<void>;
  /**
   * Mobile boot profile (fork: A1/F1/A4). When enabled, the per-target
   * migration becomes incremental (A4, watermark — see
   * `startup-migration-watermark.ts`); when absent/disabled, every target
   * is migrated fully, exactly like upstream (guardrail N10).
   */
  mobileBoot?: MobileBootOptions;
  /**
   * Optional startup-trace measurement, injected by the gateway bootstrap
   * (F9). The config layer never imports the gateway trace itself, so the
   * dependency stays one-directional. When absent, steps run unmeasured.
   */
  measure?: <T>(name: string, run: () => T | Promise<T>) => Promise<T>;
}): Promise<void> {
  params.assertCurrent?.();
  const measure =
    params.measure ??
    (<T>(_name: string, run: () => T | Promise<T>): Promise<T> => Promise.resolve().then(run));
  const env = cloneEnvWithPlatformSemantics(params.env ?? process.env);
  const { snapshot } = await measure("sessions.admission.deletion-snapshot", () =>
    prepareAgentDatabaseDeletionSnapshotRead({ env }, "runtime-discovery").read(),
  );
  params.assertCurrent?.();
  const discovery = gatewayDiscoveryReadOptions(params.cfg, { env, snapshot });
  const registeredDatabaseRows = discovery.registeredDatabases ?? [];
  const targets = resolveAllAgentSessionStoreTargetsSync(params.cfg, {
    ...discovery,
    agentIds: params.agentIds,
    excludeTarget: (target) => {
      if (discovery.excludeTarget(target)) {
        params.log.info(
          `session: skipping held agent database for ${target.agentId}; run "${formatCliCommand("openclaw doctor --fix", env)}" for explicit restoration guidance`,
        );
        return true;
      }
      return Boolean(readAgentDatabaseAdmissionRefusal(target.agentId, { env }));
    },
  });
  // Stable installations may still have file-backed history. Only Doctor imports it;
  // do not serve an empty SQLite history or rewrite those files during startup.
  await measure("sessions.admission.store-identity", () =>
    withEngineStoreAdmission(() =>
      assertSessionStoreMigrationComplete({
        cfg: params.cfg,
        env,
        targets,
        registeredDatabases: registeredDatabaseRows,
      }),
    ),
  );
  const { assertAcpSessionKeysMigratedForStartup, assertEmbeddedAcpMetadataMigratedForStartup } =
    await import("../../acp/runtime/session-meta-startup.js");
  const { migrateLegacyMainSessionKeys } = await import("./legacy-main-session-migration.js");
  // Both inspections are read-only; join them before repair, including on refusal.
  const [, result] = await settleCurrentReadPreparations([
    params.agentIds
      ? undefined
      : measure("sessions.admission.acp-keys", () =>
          assertAcpSessionKeysMigratedForStartup(
            params.cfg,
            env,
            targets.map((target) => target.agentId),
            undefined,
            params.assertCurrent,
            discovery.excludeTarget,
          ),
        ),
    // Fleet-wide guidance belongs to boot; a deferred agent must not wait on other stores.
    params.agentIds
      ? undefined
      : measure("sessions.admission.legacy-main-keys", () =>
          migrateLegacyMainSessionKeys({ cfg: params.cfg, env, mode: "detect" }),
        ),
  ] as const);
  params.assertCurrent?.();
  if (result && result.warnings.length > 0) {
    params.log.warn(
      `session: retired main-agent session migration warnings:\n${result.warnings.map((warning) => `- ${warning}`).join("\n")}`,
    );
  }

  const databases = new Set<string>();
  const coldCloses = new Set<string>();
  let interruptedSessions = 0;
  // A4: incremental migration. The watermark is read once, before any
  // per-target work: a target whose fingerprint is unchanged since its
  // last successful full migration skips the expensive per-target work
  // below (legacy run repair + canonical validation certification) and
  // only gets the cheap identity assertion + handoff. The fleet-wide
  // steps above (deletion snapshot, ACP keys, legacy main keys) always
  // run — they are not per-session work and must not be skipped.
  const incrementalMigration = params.mobileBoot?.enabled === true;
  const watermarks = incrementalMigration
    ? await measure("sessions.admission.watermark-read", () =>
        Promise.resolve(readSessionMigrationWatermarks(env, params.log)),
      )
    : new Map<string, SessionMigrationWatermarkEntry>();
  // Fingerprints recorded after each target's full migration succeeds;
  // written to the state database only after the WHOLE run succeeds
  // (see the write at the end of this function). Only the path + agent
  // are recorded here: the fingerprint itself is computed at the end of
  // the run, after cold handles close — closing a database can checkpoint
  // its WAL, so a fingerprint taken earlier would describe bytes the next
  // boot never sees and the watermark would never hit.
  const migratedDatabaseAgentIds = new Map<string, string>();
  let skippedWatermarkTargets = 0;
  const registeredDatabases = new Set(
    registeredDatabaseRows.map((entry) => `${entry.agentId}\0${entry.path}`),
  );
  const configuredTargets = resolveConfiguredAgentDatabaseCandidatePaths(params.cfg, {
    env,
  }).map((pathname) => ({ path: pathname }));
  const tasks = targets.map((target) => async () => {
    params.assertCurrent?.();
    const options = toDatabaseOptions(resolveSqliteReadScope({ ...target, env }));
    const databasePath = resolveOpenClawAgentSqlitePath(options);
    if (databases.has(databasePath) || !fs.existsSync(databasePath)) {
      return;
    }
    databases.add(databasePath);
    // Missing registry entries still need recovery before runtime can discover their lineage.
    if (
      registeredDatabases.has(`${options.agentId}\0${databasePath}`) &&
      !isConfiguredAgentDatabaseTarget(configuredTargets, options.agentId, databasePath)
    ) {
      return;
    }
    // A4: unchanged since the last successful full migration — skip the
    // repair + certification below, but still hand the database off: the
    // runtime owner (transcript maintenance, page-cache warming) needs
    // every admitted database, migrated or not. The cheap identity
    // assertion for this database runs through the handoff's
    // `assertCurrent` closure (`assertExistingDatabaseIdentity`).
    const storedWatermark = incrementalMigration ? watermarks.get(databasePath) : undefined;
    const watermarkHit =
      storedWatermark !== undefined &&
      computeAgentDatabaseMigrationFingerprint(databasePath) === storedWatermark.fingerprint;
    let alreadyOpen: boolean | undefined;
    let handedOff = false;
    try {
      if (watermarkHit) {
        skippedWatermarkTargets += 1;
        await measure("sessions.admission.target-skipped", async () => {
          params.assertCurrent?.();
          const handoffDatabase = params.handoffDatabase;
          if (handoffDatabase) {
            await handoffDatabase(options);
            params.assertCurrent?.();
            handedOff = true;
          }
        });
        return;
      }
      const { repairLegacySessionRunOutcomes } =
        await import("../../commands/doctor/shared/session-entry-rewrite.js");
      params.assertCurrent?.();
      alreadyOpen = isOpenClawAgentDatabaseOpen(databasePath);
      const mainKey = params.cfg.session?.mainKey;
      try {
        if (
          !registeredDatabases.has(`${options.agentId}\0${databasePath}`) ||
          !isCanonicalSqliteSessionMainKeyCurrent(options, mainKey)
        ) {
          if (agentEngineInput()) {
            withEngineStoreAdmission(() => {
              params.assertCurrent?.();
              setCanonicalSqliteSessionMainKey(openOpenClawAgentDatabase(options), mainKey);
            });
          } else {
            await withOpenClawAgentDatabaseAsync(
              options,
              (database) => setCanonicalSqliteSessionMainKey(database, mainKey),
              params.assertCurrent,
            );
          }
        }
      } catch (error) {
        params.assertCurrent?.();
        params.log.warn(
          `session: SQLite startup maintenance failed for ${target.agentId}; continuing: ${String(error)}`,
        );
      }
      let embeddedAcpSessionKey: string | undefined;
      interruptedSessions += await repairLegacySessionRunOutcomes(
        { agentId: options.agentId, env, storePath: databasePath },
        () => params.assertCurrent?.(),
        (row) => {
          // Pre-repair rows are valid only while legacy repair never adds or removes `acp`.
          if (
            embeddedAcpSessionKey === undefined &&
            parseSqliteSessionEntryRecord(row)?.acp != null
          ) {
            embeddedAcpSessionKey = row.session_key;
          }
        },
      );
      // Canonical refusal is readiness failure. Drain before runtime visitors can
      // otherwise parse a whole migrated store on the main thread.
      const { certifySessionCanonicalValidationPending } =
        await import("./session-canonical-validation-readiness.js");
      const { withSqliteCanonicalValidationWorker } =
        await import("./session-accessor.sqlite-reclamation-worker.js");
      params.assertCurrent?.();
      await withSqliteCanonicalValidationWorker((withWorker) =>
        certifySessionCanonicalValidationPending(options, withWorker, params.assertCurrent),
      );
      params.assertCurrent?.();
      if (params.agentIds) {
        await assertAcpSessionKeysMigratedForStartup(
          params.cfg,
          env,
          targets.map((admittedTarget) => admittedTarget.agentId),
          options,
          params.assertCurrent,
          discovery.excludeTarget,
        );
      }
      assertEmbeddedAcpMetadataMigratedForStartup(options, embeddedAcpSessionKey);
      const handoffDatabase = params.handoffDatabase;
      if (handoffDatabase) {
        // Runtime readiness failures must propagate; only successful handoff
        // transfers the cold connection beyond this maintenance operation.
        params.assertCurrent?.();
        await handoffDatabase(options);
        params.assertCurrent?.();
        handedOff = true;
      }
      // A4: record the migrated target. The fingerprint is computed at
      // the end of the run (after cold closes), not here.
      if (incrementalMigration) {
        migratedDatabaseAgentIds.set(databasePath, options.agentId);
      }
    } finally {
      if (alreadyOpen === false && !handedOff) {
        coldCloses.add(databasePath);
      }
    }
  });
  // Share preflight's two-agent disk budget: overlap admission without multiplying
  // SQLite scans and worker heaps across the whole fleet. Drain active work on failure.
  const { withSqliteCanonicalValidationWorkerPool } =
    await import("./session-accessor.sqlite-canonical-worker-pool.js");
  const errors = new Set<unknown>();
  try {
    await measure("sessions.admission.targets", () =>
      withSqliteCanonicalValidationWorkerPool(env, async () => {
        const { hasError, firstError } = await runTasksWithConcurrency({
          tasks,
          limit: AGENT_DATABASE_PREFLIGHT_CONCURRENCY,
          errorMode: "stop",
        });
        if (hasError) {
          errors.add(firstError);
          throw firstError;
        }
      }),
    );
  } catch (error) {
    errors.add(error);
  }
  // Native lease release writes shared state synchronously; sibling workers must
  // finish their admission requests before cold handles close on the main thread.
  for (const databasePath of coldCloses) {
    try {
      await closeOpenClawAgentDatabaseByPathAsync(databasePath);
    } catch (error) {
      errors.add(error);
    }
  }
  throwSqliteLifecycleErrors([...errors], "Session startup migration and cleanup failed");
  if (interruptedSessions > 0) {
    params.log.info(`session: normalized ${interruptedSessions} legacy run(s) to killed`);
  }
  params.assertCurrent?.();
  // A4: persist the watermark ONLY now — the whole run succeeded, so
  // every recorded target really was fully migrated. A failed run throws
  // above and writes nothing. Fingerprints are computed here, after the
  // cold closes above, so they describe the exact on-disk state the next
  // boot will see. Targets skipped via watermark keep their stored rows.
  if (incrementalMigration) {
    if (skippedWatermarkTargets > 0) {
      params.log.info(
        `session: skipped full migration for ${skippedWatermarkTargets} unchanged database(s) via migration watermark`,
      );
    }
    const entries: SessionMigrationWatermarkEntry[] = [];
    for (const [databasePath, agentId] of migratedDatabaseAgentIds) {
      const fingerprint = computeAgentDatabaseMigrationFingerprint(databasePath);
      if (fingerprint === undefined) {
        continue;
      }
      entries.push({
        agentDatabasePath: databasePath,
        agentId,
        agentSchemaVersion: SESSION_MIGRATION_WATERMARK_AGENT_SCHEMA_VERSION,
        fingerprint,
        migratedAtMs: Date.now(),
      });
    }
    if (entries.length > 0) {
      writeSessionMigrationWatermarks(env, entries, params.log);
    }
  }
}
