// Incremental session migration (fork: A4) — integration proof for
// `runSessionStartupMigration` with the mobile boot profile on.
//
// First run migrates fully and records a watermark per agent database;
// a second run with an unchanged database skips the expensive per-target
// work but still hands the database off; a changed database is migrated
// fully again. With the profile off, no watermark is ever written and
// every run migrates fully, exactly like upstream (guardrail N10).
import { expect, it, vi } from "vitest";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.js";
import {
  computeAgentDatabaseMigrationFingerprint,
  readSessionMigrationWatermarks,
} from "./startup-migration-watermark.js";
import { runSessionStartupMigration } from "./startup-migration.js";

const MOBILE_BOOT = { enabled: true } as const;

function migrationHarness(env: NodeJS.ProcessEnv) {
  const cfg = {
    agents: {
      ownership: "explicit" as const,
      entries: { main: {} },
    },
  };
  const handoff = vi.fn(async () => {});
  const infos: string[] = [];
  const warns: string[] = [];
  return {
    cfg,
    handoff,
    infos,
    warns,
    run: (mobileBoot?: { enabled: boolean }) =>
      runSessionStartupMigration({
        cfg,
        env,
        log: {
          info: (message: string) => infos.push(message),
          warn: (message: string) => warns.push(message),
        },
        handoffDatabase: handoff,
        mobileBoot,
      }),
    seed: (sessionKey: string) =>
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey },
        {
          sessionId: `session-${sessionKey}`,
          lifecycleRevision: `revision-${sessionKey}`,
          updatedAt: 100,
        },
      ),
  };
}

it("second run skips full migration for an unchanged database and still hands it off", async () => {
  await withOpenClawTestState({ scenario: "empty" }, async (state) => {
    const { env } = state;
    const harness = migrationHarness(env);
    harness.seed("agent:main:main");
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });

    await expect(harness.run(MOBILE_BOOT)).resolves.toBeUndefined();
    expect(harness.handoff).toHaveBeenCalledTimes(1);
    expect(harness.infos.some((message) => message.includes("skipped full migration"))).toBe(false);
    const firstMarks = readSessionMigrationWatermarks(env);
    const first = firstMarks.get(databasePath);
    expect(first).toBeDefined();
    expect(first?.agentId).toBe("main");
    expect(first?.fingerprint).toBe(computeAgentDatabaseMigrationFingerprint(databasePath));

    harness.infos.length = 0;
    await expect(harness.run(MOBILE_BOOT)).resolves.toBeUndefined();
    // A skipped target is still handed off: the runtime owner needs every
    // admitted database, migrated or not.
    expect(harness.handoff).toHaveBeenCalledTimes(2);
    expect(
      harness.infos.some((message) =>
        message.includes("skipped full migration for 1 unchanged database(s)"),
      ),
    ).toBe(true);
    const secondMarks = readSessionMigrationWatermarks(env);
    const second = secondMarks.get(databasePath);
    expect(second?.migratedAtMs).toBe(first?.migratedAtMs);
    expect(second?.fingerprint).toBe(first?.fingerprint);
  });
});

it("a changed database is migrated fully again and its watermark advances", async () => {
  await withOpenClawTestState({ scenario: "empty" }, async (state) => {
    const { env } = state;
    const harness = migrationHarness(env);
    harness.seed("agent:main:main");
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });

    await expect(harness.run(MOBILE_BOOT)).resolves.toBeUndefined();
    const first = readSessionMigrationWatermarks(env).get(databasePath);
    expect(first).toBeDefined();

    // Mutating the database changes its fingerprint, so the next run must
    // not take the watermark shortcut.
    harness.seed("agent:main:second");
    expect(computeAgentDatabaseMigrationFingerprint(databasePath)).not.toBe(first?.fingerprint);

    harness.infos.length = 0;
    await expect(harness.run(MOBILE_BOOT)).resolves.toBeUndefined();
    expect(harness.handoff).toHaveBeenCalledTimes(2);
    expect(harness.infos.some((message) => message.includes("skipped full migration"))).toBe(false);
    const second = readSessionMigrationWatermarks(env).get(databasePath);
    expect(second).toBeDefined();
    expect(second?.fingerprint).toBe(computeAgentDatabaseMigrationFingerprint(databasePath));
    expect(second?.migratedAtMs).toBeGreaterThanOrEqual(first?.migratedAtMs ?? 0);
  });
});

it("with the mobile profile off, every run migrates fully and writes no watermark", async () => {
  await withOpenClawTestState({ scenario: "empty" }, async (state) => {
    const { env } = state;
    const harness = migrationHarness(env);
    harness.seed("agent:main:main");

    await expect(harness.run()).resolves.toBeUndefined();
    await expect(harness.run()).resolves.toBeUndefined();
    expect(harness.handoff).toHaveBeenCalledTimes(2);
    expect(harness.infos.some((message) => message.includes("skipped full migration"))).toBe(false);
    expect(readSessionMigrationWatermarks(env).size).toBe(0);
  });
});
