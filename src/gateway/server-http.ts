import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { runHttpConnectionRequest } from "../infra/http-request-lifecycle.js";
import { createGatewayHttpRequestHandler } from "./server-http-request.js";
import type { GatewayHttpRequestHandler, GatewayHttpServerOptions } from "./server-http.types.js";

const requestHandlers = new WeakMap<HttpServer, GatewayHttpRequestHandler>();

export function getGatewayHttpRequestHandler(server: HttpServer): GatewayHttpRequestHandler {
  const handler = requestHandlers.get(server);
  if (!handler) {
    throw new Error("Gateway HTTP owner is unavailable");
  }
  return handler;
}

export function createGatewayHttpServer(opts: GatewayHttpServerOptions): HttpServer {
  const handler = createGatewayHttpRequestHandler(opts);
  const server =
    opts.testListener ??
    (opts.tlsOptions ? createHttpsServer(opts.tlsOptions) : createHttpServer());
  requestHandlers.set(server, handler);
  server.on("request", (req, res) => void handler(req, res));
  server.once("close", () => handler.dispose());
  server.on("checkContinue", (req, res) => void handler(req, res, "continue"));
  server.on("checkExpectation", (req, res) => void handler(req, res, "reject"));
  server.on("connect", (req, socket) => {
    void runHttpConnectionRequest(
      req,
      async () => {
        socket.destroy();
      },
      "upgrade",
    );
  });
  return server;
}

/**
 * Fase 1 (fork: Lane F1-I) — install the full request handler on a
 * server the early-listen stub already bound. Unlike
 * `createGatewayHttpServer` this does NOT attach `request` /
 * `checkContinue` / `checkExpectation` / `connect` / `close` listeners:
 * the stub installed those once, dispatching through `handlerRef`, so
 * the full handler takes over with the single `handlerRef.current`
 * assignment the transport performs at `mark("ready")` — no listener is
 * ever attached twice. Only the `WeakMap` entry is (re)pointed at the
 * full handler, so `getGatewayHttpRequestHandler` keeps working for
 * ingress routing. The caller owns the handover timing.
 */
export function installPreboundGatewayHttpHandler(
  server: HttpServer,
  opts: GatewayHttpServerOptions,
): GatewayHttpRequestHandler {
  const handler = createGatewayHttpRequestHandler(opts);
  requestHandlers.set(server, handler);
  return handler;
}
