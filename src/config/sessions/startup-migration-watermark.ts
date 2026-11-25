// Incremental session migration watermark (fork: A4).
//
// Under the mobile boot profile (A1), `runSessionStartupMigration` records,
// per agent database, a fingerprint of the file *after* a full migration.
// On the next boot, a database whose fingerprint is unchanged — and whose
// agent schema version matches — skips the expensive per-target work
// (legacy run repair + canonical validation certification) and only gets
// the cheap `assertExistingDatabaseIdentity` + handoff. A changed database
// gets the full migration again.
//
// Storage: a fork-private additive table in the state SQLite database
// (`mobile_boot_session_migration`). The table is created only while the
// mobile profile is on, never touches the state schema version, and is
// ignored by upstream (unknown tables are not part of schema checks).
// Watermark rows are written ONLY after a full migration run succeeds;
// a failed run writes nothing, so the next boot migrates fully again
// (guardrail N6 — a stale watermark can never skip a migration that
// did not complete).
//
// Access discipline (docs/reference/database-schemas/worker-access.md):
// boot admission / migration is a documented main-thread exception (T2),
// same as the migration itself. Reads reuse the existing read-only state
// handle; writes go through the startup-checkpoint write path, exactly
// like `src/infra/startup-migration-checkpoint.ts`.
import fs from "node:fs";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { withOpenClawStateStartupMigrationCheckpointDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowed } from "../../state/openclaw-state-ownership.js";

export type SessionMigrationWatermarkEntry = {
  agentDatabasePath: string;
  agentId: string;
  agentSchemaVersion: number;
  fingerprint: string;
  migratedAtMs: number;
};

export type SessionMigrationWatermarkLogger = {
  warn: (message: string) => void;
};

type MobileBootSessionMigrationDatabase = {
  mobile_boot_session_migration: {
    agent_database_path: string;
    agent_id: string;
    agent_schema_version: number;
    fingerprint: string;
    migrated_at: number;
  };
};

/** Agent schema version the stored watermarks were written against. */
export const SESSION_MIGRATION_WATERMARK_AGENT_SCHEMA_VERSION = OPENCLAW_AGENT_SCHEMA_VERSION;

const CREATE_WATERMARK_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS mobile_boot_session_migration (
    agent_database_path TEXT NOT NULL PRIMARY KEY,
    agent_id TEXT NOT NULL,
    agent_schema_version INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    migrated_at INTEGER NOT NULL
  )
`;

/**
 * Cheap fingerprint of an agent database file: sizes + mtimes of the
 * database and its SQLite sidecars, plus the SQLite header change counter
 * (bytes 24-27, big-endian). Any committed write changes the WAL mtime
 * (or the main file on checkpoint); the change counter catches commits
 * even when mtime granularity would miss them. Returns `undefined` when
 * the file cannot be read — the caller treats that as a watermark miss
 * (full migration), never as a hit.
 */
export function computeAgentDatabaseMigrationFingerprint(pathname: string): string | undefined {
  try {
    const parts: string[] = [];
    for (const candidate of [
      pathname,
      `${pathname}-wal`,
      `${pathname}-shm`,
      `${pathname}-journal`,
    ]) {
      try {
        const stat = fs.statSync(candidate);
        parts.push(`${stat.size}:${stat.mtimeMs}`);
      } catch {
        parts.push("-");
      }
    }
    const fd = fs.openSync(pathname, "r");
    try {
      const header = Buffer.alloc(100);
      const read = fs.readSync(fd, header, 0, 100, 0);
      parts.push(read >= 28 ? String(header.readUInt32BE(24)) : "-");
    } finally {
      fs.closeSync(fd);
    }
    return parts.join("|");
  } catch {
    return undefined;
  }
}

/**
 * Read all stored watermarks. Any failure — missing state database,
 * missing table (first mobile boot), Postgres state store — yields an
 * empty map, i.e. full migration for every target. Never throws.
 */
export function readSessionMigrationWatermarks(
  env: NodeJS.ProcessEnv,
  log?: SessionMigrationWatermarkLogger,
): Map<string, SessionMigrationWatermarkEntry> {
  try {
    const rows =
      withExistingOpenClawStateDatabaseReadOnly(
        ({ db }) => {
          if (isPostgresSqlConnection(db)) {
            return [];
          }
          const stateDb = getNodeSqliteKysely<MobileBootSessionMigrationDatabase>(db);
          return executeSqliteQuerySync(
            db,
            stateDb
              .selectFrom("mobile_boot_session_migration")
              .select([
                "agent_database_path as agentDatabasePath",
                "agent_id as agentId",
                "agent_schema_version as agentSchemaVersion",
                "fingerprint",
                "migrated_at as migratedAtMs",
              ]),
          ).rows;
        },
        { env },
      ) ?? [];
    const entries = new Map<string, SessionMigrationWatermarkEntry>();
    for (const row of rows) {
      // A schema bump resets every watermark: rows written against an
      // older agent schema never authorize skipping a migration.
      if (row.agentSchemaVersion !== SESSION_MIGRATION_WATERMARK_AGENT_SCHEMA_VERSION) {
        continue;
      }
      entries.set(row.agentDatabasePath, {
        agentDatabasePath: row.agentDatabasePath,
        agentId: row.agentId,
        agentSchemaVersion: row.agentSchemaVersion,
        fingerprint: row.fingerprint,
        migratedAtMs: row.migratedAtMs,
      });
    }
    return entries;
  } catch (error) {
    // First mobile boot has no watermark table yet — that is expected,
    // not a warning. Any other read failure also just means "migrate
    // fully", so warn once and continue.
    if (!String(error).includes("no such table")) {
      log?.warn(
        `session: migration watermark read failed; migrating all sessions fully: ${String(error)}`,
      );
    }
    return new Map();
  }
}

/**
 * Persist watermark rows for targets whose full migration just succeeded.
 * Callers must invoke this only after the whole migration run succeeded;
 * a failed run must not write. Failures are logged, never thrown — the
 * only consequence is a full migration on the next boot.
 */
export function writeSessionMigrationWatermarks(
  env: NodeJS.ProcessEnv,
  entries:
    | ReadonlyMap<string, SessionMigrationWatermarkEntry>
    | readonly SessionMigrationWatermarkEntry[],
  log?: SessionMigrationWatermarkLogger,
): void {
  const rows = [...entries.values()];
  if (rows.length === 0) {
    return;
  }
  try {
    const databasePath = resolveOpenClawStateSqlitePath(env);
    withOpenClawStateStartupMigrationCheckpointDatabase(
      (db) => {
        if (isPostgresSqlConnection(db)) {
          return;
        }
        runSqliteImmediateTransactionSync(
          db,
          () => {
            assertOpenClawStateWriteAllowed({ database: db, databasePath, env });
            // sqlite-allow-raw -- DDL for the fork-private watermark table;
            // additive CREATE TABLE IF NOT EXISTS, no schema-version change.
            db.exec(CREATE_WATERMARK_TABLE_SQL);
            const stateDb = getNodeSqliteKysely<MobileBootSessionMigrationDatabase>(db);
            for (const entry of rows) {
              executeSqliteQuerySync(
                db,
                stateDb
                  .deleteFrom("mobile_boot_session_migration")
                  .where("agent_database_path", "=", entry.agentDatabasePath),
              );
              executeSqliteQuerySync(
                db,
                stateDb.insertInto("mobile_boot_session_migration").values({
                  agent_database_path: entry.agentDatabasePath,
                  agent_id: entry.agentId,
                  agent_schema_version: entry.agentSchemaVersion,
                  fingerprint: entry.fingerprint,
                  migrated_at: entry.migratedAtMs,
                }),
              );
            }
          },
          {
            databaseLabel: databasePath,
            operationLabel: "state.mobile-boot-migration-watermark.write",
          },
        );
      },
      { env, atomic: false },
    );
  } catch (error) {
    log?.warn(
      `session: migration watermark write failed; next boot migrates all sessions fully: ${String(error)}`,
    );
  }
}
