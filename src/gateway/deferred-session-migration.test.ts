import { describe, expect, it, vi } from "vitest";
import { createDeferredSessionMigration } from "./deferred-session-migration.js";
import type { PreparedStartupSessionDatabase } from "./server-startup-session-migration.js";

const fakeDatabases = [
  {
    database: { path: "/tmp/fake-agent.sqlite" },
    assertCurrent: () => {},
  },
] as unknown as readonly PreparedStartupSessionDatabase[];

describe("createDeferredSessionMigration (fork: F1)", () => {
  it("resolves ready with the databases from the started run", async () => {
    const deferred = createDeferredSessionMigration();
    deferred.start(async () => fakeDatabases);
    await expect(deferred.ready).resolves.toBe(fakeDatabases);
  });

  it("rejects ready when the run fails, so startup can fail closed", async () => {
    const deferred = createDeferredSessionMigration();
    const failure = new Error("migration boom");
    deferred.start(async () => {
      throw failure;
    });
    await expect(deferred.ready).rejects.toBe(failure);
  });

  it("ignores a second start so the migration can never run twice", async () => {
    const deferred = createDeferredSessionMigration();
    const first = vi.fn(async () => fakeDatabases);
    const second = vi.fn(async () => fakeDatabases);
    deferred.start(first);
    deferred.start(second);
    await expect(deferred.ready).resolves.toBe(fakeDatabases);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });
});
