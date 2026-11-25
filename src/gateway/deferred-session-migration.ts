import type { SessionStartupMigrationLogger } from "../config/sessions/startup-migration.js";
// Deferred session migration (fork: F1) — the fleet-wide startup session
// migration, owned as a promise instead of a pre-listen blocking step.
//
// Upstream runs `prepareGatewayStartupSessions` inside the bootstrap
// `preparations` array, before `http.listen`. Under the mobile boot profile
// (A1) the bootstrap only *creates* this owner and returns it; the actual
// migration is started by `finishGatewayStartup` right after `http.bound`
// and runs in parallel with `runtime.post-attach`. Agent RPCs stay gated
// until `ready` settles: `finishGatewayStartup` awaits it before
// `unlockStartupMethods`, so `chat.send`/`agent` keep returning the
// existing retryable startup-unavailable error (`startup-sidecars`) until
// the migration is done (guardrail N6 — deferred, never skipped; a
// migration failure fails startup exactly like the upstream pre-listen
// failure did).
//
// This module is deliberately dependency-free at load time (one deferred
// + type-only imports) so the bootstrap can create the owner without
// importing the heavy migration graph before listen. The starter below
// dynamic-imports `prepareGatewayStartupSessions` only when started,
// post-listen, so that property is preserved.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { MobileBootOptions } from "./mobile-boot.js";
import type { PreparedStartupSessionDatabase } from "./server-startup-session-migration.js";

/** Fleet-wide session migration that starts after HTTP listen (F1). */
export type DeferredSessionMigration = {
  /** Settles with the admitted databases once the deferred migration completes. */
  readonly ready: Promise<readonly PreparedStartupSessionDatabase[]>;
  /**
   * Start the migration. The first call wins; later calls are no-ops, so a
   * second starter (or a restart of the same boot path) cannot migrate twice.
   */
  start: (run: () => Promise<readonly PreparedStartupSessionDatabase[]>) => void;
};

export function createDeferredSessionMigration(): DeferredSessionMigration {
  const deferred = createDeferredCore<readonly PreparedStartupSessionDatabase[]>();
  let started = false;
  return {
    ready: deferred.promise,
    start(run) {
      if (started) {
        return;
      }
      started = true;
      void run().then(
        (databases) => deferred.resolve(databases),
        (error: unknown) => deferred.reject(error),
      );
    },
  };
}

/**
 * Start the deferred fleet-wide session migration (F1) after HTTP listen.
 * Runs the migration in parallel with `runtime.post-attach` and resolves
 * `onSettled` on either outcome, so the per-agent preparation gate can
 * proceed (on failure startup still fails where `finishGatewayStartup`
 * awaits `ready`). Lives here — not in `server-startup-finish.ts` — so
 * that file stays under the 700-line limit.
 */
export function startDeferredSessionMigration(
  deferred: DeferredSessionMigration,
  params: {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    log: SessionStartupMigrationLogger;
    mobileBoot?: MobileBootOptions;
    isClosing: () => boolean;
    abortSignal: AbortSignal;
    measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T>;
    onSettled: () => void;
  },
): void {
  deferred.start(() =>
    params.measure("sessions.admission", async () => {
      const { prepareGatewayStartupSessions } =
        await import("./server-startup-session-migration.js");
      return prepareGatewayStartupSessions({
        cfg: params.cfg,
        env: params.env,
        log: params.log,
        mobileBoot: params.mobileBoot,
        assertCurrent: () => {
          if (params.isClosing()) {
            throw new Error("Gateway is closing");
          }
          params.abortSignal.throwIfAborted();
        },
        // F9: measure the migration sub-steps, as the bootstrap did.
        measure: params.measure,
      });
    }),
  );
  void deferred.ready.then(params.onSettled, params.onSettled);
}
