// Fase 1 (fork: Lane F1-I) — unit tests for the early-listen stub.
//
// Covers §8.1: probe answers per phase, the N1 shell auth gate, the
// `Retry-After: 1` header, the atomic `handlerRef` swap, the registration
// file lifecycle, and the R-1 import-graph gate (the stub must stay
// dependency-free at load time).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  createListenPhase,
  createListenStubServer,
  markListenPhaseBound,
  matchesListenStubSecret,
  resolveListenStubSecrets,
  type GatewayHttpHandlerRef,
} from "./listen-stub.js";
import {
  removeGatewayRegistration,
  resolveGatewayRegistrationPath,
  updateGatewayRegistrationStatus,
  writeGatewayRegistration,
} from "./listen-registration.js";

const TOKEN = "stub-test-token";

async function startStub(secrets: { token?: string; password?: string } = { token: TOKEN }) {
  const phase = createListenPhase({ port: 0, bindHost: "127.0.0.1" });
  const { server, handlerRef } = createListenStubServer(phase, secrets);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  markListenPhaseBound(phase);
  const port = (server.address() as AddressInfo).port;
  return {
    phase,
    server,
    handlerRef,
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe("listen stub probes", () => {
  it("answers /health 200 live without auth", async () => {
    const stub = await startStub();
    try {
      const res = await fetch(`${stub.url}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, status: "live" });
      expect(res.headers.get("retry-after")).toBeNull();
    } finally {
      await stub.close();
    }
  });

  it("answers /ready 503 with Retry-After: 1 and starting details for loopback", async () => {
    const stub = await startStub();
    try {
      const res = await fetch(`${stub.url}/ready`);
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("1");
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.ready).toBe(false);
      expect(body.failing).toEqual(["starting"]);
    } finally {
      await stub.close();
    }
  });

  it("answers /startup 503 with the stub pendingReason", async () => {
    const stub = await startStub();
    try {
      const res = await fetch(`${stub.url}/startup`);
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("1");
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ ok: false, status: "starting", pendingReason: "bootstrap" });
    } finally {
      await stub.close();
    }
  });

  it("rejects non-GET probe methods with 405", async () => {
    const stub = await startStub();
    try {
      const res = await fetch(`${stub.url}/ready`, { method: "POST" });
      expect(res.status).toBe(405);
    } finally {
      await stub.close();
    }
  });

  it("answers HEAD probes with headers and no body", async () => {
    const stub = await startStub();
    try {
      const res = await fetch(`${stub.url}/health`, { method: "HEAD" });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
    } finally {
      await stub.close();
    }
  });

  it("answers unknown paths 503 service_starting with Retry-After: 1", async () => {
    const stub = await startStub();
    try {
      const res = await fetch(`${stub.url}/v1/chat/completions`, { method: "POST" });
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("1");
      expect(await res.json()).toEqual({ code: "service_starting" });
    } finally {
      await stub.close();
    }
  });
});

describe("listen stub shell auth gate (N1)", () => {
  it("serves the placeholder with a valid bearer token and no send input", async () => {
    const stub = await startStub();
    try {
      const res = await fetch(`${stub.url}/`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Starting gateway");
      expect(html).not.toContain("<input");
      expect(html).not.toContain("<form");
      expect(html).not.toContain("composer");
    } finally {
      await stub.close();
    }
  });

  it("serves the placeholder with ?token= and rejects a wrong token with 401", async () => {
    const stub = await startStub();
    try {
      const ok = await fetch(`${stub.url}/?token=${TOKEN}`);
      expect(ok.status).toBe(200);
      const wrong = await fetch(`${stub.url}/?token=nope`);
      expect(wrong.status).toBe(401);
      const missing = await fetch(`${stub.url}/`);
      expect(missing.status).toBe(401);
    } finally {
      await stub.close();
    }
  });

  it("answers 503 starting (never the shell, never 401) when no env secret is configured", async () => {
    const stub = await startStub({});
    try {
      const res = await fetch(`${stub.url}/`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ code: "service_starting" });
    } finally {
      await stub.close();
    }
  });

  it("matches the env token with a timing-safe comparison", () => {
    expect(matchesListenStubSecret(TOKEN, { token: TOKEN })).toBe(true);
    expect(matchesListenStubSecret("wrong", { token: TOKEN })).toBe(false);
    expect(matchesListenStubSecret(undefined, { token: TOKEN })).toBe(false);
    expect(matchesListenStubSecret(TOKEN, {})).toBe(false);
    expect(resolveListenStubSecrets({
      ...process.env,
      OPENCLAW_GATEWAY_TOKEN: TOKEN,
    })).toEqual({ token: TOKEN });
  });
});

describe("handlerRef swap (D-1)", () => {
  it("hands requests to the swapped-in handler with one assignment", async () => {
    const stub = await startStub();
    try {
      const before = await fetch(`${stub.url}/ready`);
      expect(before.status).toBe(503);
      // Simulate the transport handover: the swapped-in handler answers /ready 200.
      stub.handlerRef.current = Object.assign(
        async (_req: unknown, res: { statusCode: number; end: (b?: string) => void }) => {
          res.statusCode = 200;
          res.end(JSON.stringify({ ready: true }));
        },
        { dispose: () => {} },
      ) as unknown as GatewayHttpHandlerRef["current"];
      const after = await fetch(`${stub.url}/ready`);
      expect(after.status).toBe(200);
      expect(await after.json()).toEqual({ ready: true });
    } finally {
      await stub.close();
    }
  });
});

describe("gateway registration file", () => {
  it("writes starting, flips to ready, and removes on close", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-registration-"));
    try {
      const file = await writeGatewayRegistration({
        port: 18789,
        bindHost: "127.0.0.1",
        bootId: "test-boot-id",
        startedAtMs: Date.now(),
        stateDir,
      });
      expect(file).toBe(resolveGatewayRegistrationPath(stateDir));
      const written = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
      expect(written).toMatchObject({
        url: "http://127.0.0.1:18789",
        port: 18789,
        pid: process.pid,
        bootId: "test-boot-id",
        status: "starting",
      });
      expect(written).not.toHaveProperty("token");
      expect(written).not.toHaveProperty("password");
      await updateGatewayRegistrationStatus({ status: "ready", stateDir });
      const updated = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
      expect(updated.status).toBe("ready");
      await removeGatewayRegistration(stateDir);
      await expect(fs.readFile(file, "utf8")).rejects.toThrow();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("refuses to flip a registration owned by another pid", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-registration-"));
    try {
      const file = await writeGatewayRegistration({
        port: 18789,
        bindHost: "127.0.0.1",
        bootId: "test-boot-id",
        startedAtMs: Date.now(),
        stateDir,
      });
      const raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
      await fs.writeFile(file, JSON.stringify({ ...raw, pid: process.pid + 1 }), "utf8");
      await updateGatewayRegistrationStatus({ status: "ready", stateDir });
      const kept = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
      expect(kept.status).toBe("starting");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("stub import graph (R-1 gate)", () => {
  it("imports only the allowlisted light modules", async () => {
    const source = await fs.readFile(new URL("./listen-stub.ts", import.meta.url), "utf8");
    const runtimeImports = [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gmu)].map(
      (match) => match[1],
    );
    const allowed = new Set([
      "node:http",
      "node:crypto",
      "node:perf_hooks",
      "../../security/secret-equal.js",
      "../http-header-value.js",
      "../gateway-http-route-contracts.js",
    ]);
    for (const specifier of runtimeImports) {
      expect(
        allowed.has(specifier),
        `listen-stub.ts must not import ${specifier} at load time (R-1)`,
      ).toBe(true);
    }
    expect(runtimeImports.length).toBeGreaterThan(0);
  });
});
