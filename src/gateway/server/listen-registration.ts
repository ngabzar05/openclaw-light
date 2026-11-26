// Fase 1 (fork: Lane F1-I) — early gateway registration file.
//
// Mirrors OpenCode's `service.json`, written at `http.bound` so a client
// (or an operator debugging a slow boot) can learn the gateway is alive
// before `/ready`. Polones does NOT read this file in Fase 1 — it is for
// debug + future clients only (D-4).
//
// The file NEVER contains a password or token (N1): Polones manages the
// gateway token in SecretStore. A stale file is detectable: the reader
// must check that `pid` is still alive and `bootId` matches the process
// it expects. Writes are atomic (temp file + rename) and best-effort — a
// registration failure must never fail startup.
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../config/state-dir.js";

export const GATEWAY_REGISTRATION_FILENAME = "gateway-registration.json";

export type GatewayRegistrationStatus = "starting" | "ready";

export type GatewayRegistration = {
  url: string;
  port: number;
  pid: number;
  bootId: string;
  status: GatewayRegistrationStatus;
  version?: string;
  startedAtMs: number;
};

export function resolveGatewayRegistrationPath(stateDir?: string): string {
  return path.join(stateDir ?? resolveStateDir(process.env), GATEWAY_REGISTRATION_FILENAME);
}

async function resolveGatewayVersion(): Promise<string | undefined> {
  try {
    const { resolveRuntimeServiceVersion } = await import("../../version.js");
    return resolveRuntimeServiceVersion(process.env);
  } catch {
    return undefined;
  }
}

async function writeRegistrationAtomically(
  registrationPath: string,
  registration: GatewayRegistration,
): Promise<void> {
  const tmpPath = `${registrationPath}.tmp-${process.pid}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(registration, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, registrationPath);
}

/** Write the registration file at `http.bound`. Returns the file path. */
export async function writeGatewayRegistration(params: {
  port: number;
  bindHost: string;
  bootId: string;
  startedAtMs: number;
  stateDir?: string;
}): Promise<string> {
  const registrationPath = resolveGatewayRegistrationPath(params.stateDir);
  const version = await resolveGatewayVersion();
  const registration: GatewayRegistration = {
    url: `http://${params.bindHost === "0.0.0.0" ? "127.0.0.1" : params.bindHost}:${params.port}`,
    port: params.port,
    pid: process.pid,
    bootId: params.bootId,
    status: "starting",
    ...(version ? { version } : {}),
    startedAtMs: params.startedAtMs,
  };
  await writeRegistrationAtomically(registrationPath, registration);
  return registrationPath;
}

/** Flip the registration status to `ready` at `mark("ready")`. No-op when the file is gone. */
export async function updateGatewayRegistrationStatus(params: {
  status: GatewayRegistrationStatus;
  stateDir?: string;
}): Promise<void> {
  const registrationPath = resolveGatewayRegistrationPath(params.stateDir);
  try {
    const raw = await fs.readFile(registrationPath, "utf8");
    const registration = JSON.parse(raw) as GatewayRegistration;
    if (registration.pid !== process.pid) {
      return;
    }
    await writeRegistrationAtomically(registrationPath, {
      ...registration,
      status: params.status,
    });
  } catch {
    // Best-effort: a missing or unreadable file is not a startup failure.
  }
}

/** Remove the registration file on clean close. Best-effort; never throws. */
export async function removeGatewayRegistration(stateDir?: string): Promise<void> {
  try {
    await fs.rm(resolveGatewayRegistrationPath(stateDir), { force: true });
  } catch {
    // Best-effort.
  }
}
