// Deferred session migration (fork: F1) — boot proof.
//
// Under the mobile boot profile the fleet-wide session migration must NOT
// run before listen: the Gateway binds, answers, and only then migrates,
// in parallel with `runtime.post-attach`. Agent RPCs stay gated until the
// migration settles, so reaching `startupSettled` + a successful
// `sessions.list` proves the deferred migration completed before ready
// (guardrail N6 — deferred, never skipped). The watermark the migration
// writes (A4) is the durable evidence it ran; a second boot against the
// same state must leave the watermark untouched, proving the skip path
// end to end.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replaceSessionEntrySync } from "../../../../src/config/sessions/session-accessor.js";
import {
  computeAgentDatabaseMigrationFingerprint,
  readSessionMigrationWatermarks,
} from "../../../../src/config/sessions/startup-migration-watermark.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { MOBILE_BOOT_ENV_VAR } from "../../../../src/gateway/mobile-boot.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { resolveOpenClawAgentSqlitePath } from "../../../../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../../../src/state/openclaw-state-db.js";
import { setTestEnvValue } from "../../../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { prepareRecoveryHome, resetGatewayState } from "./gateway-startup-routing.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Gateway mobile boot F1 (deferred session migration)", () => {
  beforeEach(resetGatewayState);
  afterEach(resetGatewayState);

  it(
    "defers the fleet-wide migration past listen and skips it on the next boot",
    { timeout: 600_000 },
    async () => {
      const tempHome = tempDirs.make("openclaw-gateway-mobile-boot-f1-");
      const token = `gateway-mobile-boot-f1-${process.pid}`;
      const { configPath, workspaceDir, envSnapshot } = await prepareRecoveryHome(tempHome, token);
      closeOpenClawStateDatabaseForTest();
      setTestEnvValue(MOBILE_BOOT_ENV_VAR, "1");
      try {
        const env = { ...process.env };
        // Seed one session so the main agent database exists before boot.
        replaceSessionEntrySync(
          { agentId: "main", env, sessionKey: "agent:main:main" },
          {
            sessionId: "session-main",
            lifecycleRevision: "revision-main",
            updatedAt: 100,
          },
        );
        const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
        const config = {
          agents: {
            defaults: { workspace: workspaceDir, skipBootstrap: true },
            entries: { main: {} },
          },
          gateway: { auth: { mode: "token", token } },
          plugins: { slots: { memory: "none" } },
        } satisfies OpenClawConfig;

        const start = () =>
          startGatewayWithClient({
            cfg: config,
            configPath,
            token,
            clientDisplayName: "vitest-gateway-mobile-boot-f1",
          });

        // Boot 1: deferred migration runs after listen and writes the watermark.
        let gateway = await start();
        let firstMark;
        try {
          await gateway.server.startupSettled;
          // Agent RPCs are unlocked only after the deferred migration settles.
          const listed = await gateway.client.request<{
            sessions: Array<{ key: string }>;
          }>("sessions.list", {});
          expect(Array.isArray(listed.sessions)).toBe(true);
          firstMark = readSessionMigrationWatermarks(env).get(databasePath);
          expect(firstMark).toBeDefined();
          expect(firstMark?.agentId).toBe("main");
          expect(firstMark?.fingerprint).toBe(
            computeAgentDatabaseMigrationFingerprint(databasePath),
          );
        } finally {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "mobile-boot F1 first boot complete" });
        }
        closeOpenClawStateDatabaseForTest();
        resetGatewayState();

        // Boot 2: same state, unchanged database — the watermark must be left
        // untouched, proving the second boot took the A4 skip path.
        gateway = await start();
        try {
          await gateway.server.startupSettled;
          const listed = await gateway.client.request<{
            sessions: Array<{ key: string }>;
          }>("sessions.list", {});
          expect(Array.isArray(listed.sessions)).toBe(true);
          const secondMark = readSessionMigrationWatermarks(env).get(databasePath);
          expect(secondMark?.migratedAtMs).toBe(firstMark?.migratedAtMs);
          expect(secondMark?.fingerprint).toBe(firstMark?.fingerprint);
        } finally {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "mobile-boot F1 second boot complete" });
        }
        closeOpenClawStateDatabaseForTest();
      } finally {
        envSnapshot.restore();
      }
    },
  );
});
