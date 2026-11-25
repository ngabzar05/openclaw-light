import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  computeAgentDatabaseMigrationFingerprint,
  readSessionMigrationWatermarks,
  writeSessionMigrationWatermarks,
  type SessionMigrationWatermarkEntry,
} from "./startup-migration-watermark.js";

const entry = (agentDatabasePath: string, fingerprint: string): SessionMigrationWatermarkEntry => ({
  agentDatabasePath,
  agentId: "main",
  agentSchemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
  fingerprint,
  migratedAtMs: 1_700_000_000_000,
});

describe("computeAgentDatabaseMigrationFingerprint (fork: A4)", () => {
  it("is stable for an untouched file and changes after a write", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "f1-watermark-"));
    const pathname = path.join(dir, "agent.sqlite");
    writeFileSync(pathname, Buffer.alloc(4096));
    const first = computeAgentDatabaseMigrationFingerprint(pathname);
    const second = computeAgentDatabaseMigrationFingerprint(pathname);
    expect(first).toBeDefined();
    expect(second).toBe(first);
    writeFileSync(pathname, Buffer.alloc(8192));
    expect(computeAgentDatabaseMigrationFingerprint(pathname)).not.toBe(first);
  });

  it("changes when only the mtime changes, and is undefined for a missing file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "f1-watermark-"));
    const pathname = path.join(dir, "agent.sqlite");
    writeFileSync(pathname, Buffer.alloc(1024));
    const before = computeAgentDatabaseMigrationFingerprint(pathname);
    const later = new Date(Date.now() + 60_000);
    utimesSync(pathname, later, later);
    expect(computeAgentDatabaseMigrationFingerprint(pathname)).not.toBe(before);
    expect(
      computeAgentDatabaseMigrationFingerprint(path.join(dir, "missing.sqlite")),
    ).toBeUndefined();
  });
});

describe("session migration watermark storage (fork: A4)", () => {
  it("returns an empty map when the state database does not exist", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "f1-watermark-"));
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: path.join(dir, "state"),
    };
    expect(readSessionMigrationWatermarks(env)).toEqual(new Map());
  });

  it("round-trips watermarks through the state database", () =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { env } = state;
      const shared = openOpenClawStateDatabase({ env });
      try {
        expect(readSessionMigrationWatermarks(env).size).toBe(0);
        writeSessionMigrationWatermarks(
          env,
          new Map([
            ["/tmp/a.sqlite", entry("/tmp/a.sqlite", "fp-a")],
            ["/tmp/b.sqlite", entry("/tmp/b.sqlite", "fp-b")],
          ]),
        );
        const rows = readSessionMigrationWatermarks(env);
        expect([...rows.keys()].toSorted()).toEqual(["/tmp/a.sqlite", "/tmp/b.sqlite"]);
        expect(rows.get("/tmp/a.sqlite")?.fingerprint).toBe("fp-a");
        // Writing an empty set is a no-op and never creates the table.
        writeSessionMigrationWatermarks(env, new Map());
        expect(readSessionMigrationWatermarks(env).size).toBe(2);
      } finally {
        await closeOpenClawStateDatabaseByPathAsync(shared.path);
      }
    }));

  it("ignores rows written against an older agent schema version", () =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { env } = state;
      const shared = openOpenClawStateDatabase({ env });
      try {
        writeSessionMigrationWatermarks(
          env,
          new Map([["/tmp/a.sqlite", entry("/tmp/a.sqlite", "fp-a")]]),
        );
        expect(readSessionMigrationWatermarks(env).size).toBe(1);
        shared.db
          .prepare(
            "UPDATE mobile_boot_session_migration SET agent_schema_version = ? WHERE agent_database_path = ?",
          )
          .run(Math.max(0, OPENCLAW_AGENT_SCHEMA_VERSION - 1), "/tmp/a.sqlite");
        // Schema bump resets the watermark: the row no longer authorizes a skip.
        expect(readSessionMigrationWatermarks(env).size).toBe(0);
      } finally {
        await closeOpenClawStateDatabaseByPathAsync(shared.path);
      }
    }));
});
