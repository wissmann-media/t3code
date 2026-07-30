import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeTimers from "node:timers";
import * as NodeURL from "node:url";

import { BridgeCommandError, BridgeCommandService } from "./commands.ts";
import {
  decodeApprovalResponse,
  decodeCreateProject,
  decodeCreateThread,
  decodePairing,
  decodeStartTurn,
  decodeThreadCommand,
  decodeUserInputResponse,
} from "./schemas.ts";
import { BridgeStore } from "./store.ts";
import type { T3Client } from "./t3Client.ts";
import {
  BRIDGE_API_VERSION,
  BRIDGE_VERSION,
  STATUS_SCHEMA_VERSION,
  type BridgeStatusEvent,
} from "./types.ts";
import { nowEpochMillis } from "./time.ts";

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_SSE_BUFFER_BYTES = 512 * 1024;

export class BridgePairingSession {
  readonly code = NodeCrypto.randomInt(0, 100_000_000).toString().padStart(8, "0");
  private readonly expiresAt = nowEpochMillis() + 5 * 60 * 1_000;
  private consumed = false;
  private readonly bearerToken: string;

  constructor(bearerToken: string) {
    this.bearerToken = bearerToken;
  }

  exchange(code: string): string | null {
    if (this.consumed || nowEpochMillis() > this.expiresAt) return null;
    if (!safeEqual(code, this.code)) return null;
    this.consumed = true;
    return this.bearerToken;
  }
}

export interface BridgeServer {
  readonly listen: (port: number) => Promise<void>;
  readonly close: () => Promise<void>;
}

export const createBridgeServer = (options: {
  readonly store: BridgeStore;
  readonly commands: BridgeCommandService;
  readonly t3: T3Client;
  readonly bearerToken: string;
  readonly pairing: BridgePairingSession;
}): BridgeServer => {
  const server = NodeHttp.createServer((request, response) => {
    void routeRequest(options, request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof BridgeCommandError) {
        const status =
          error.code === "not_found"
            ? 404
            : error.code === "not_managed" || error.code === "command_conflict"
              ? 409
              : 503;
        sendJson(response, status, { error: error.code });
        return;
      }
      if (error instanceof RequestBodyError) {
        sendJson(response, error.status, { error: error.code });
        return;
      }
      sendJson(response, 500, { error: "internal_error" });
    });
  });
  server.keepAliveTimeout = 15_000;
  server.headersTimeout = 20_000;
  server.requestTimeout = 20_000;
  server.maxRequestsPerSocket = 100;

  return {
    listen: (port) =>
      new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      }),
  };
};

const routeRequest = async (
  options: {
    readonly store: BridgeStore;
    readonly commands: BridgeCommandService;
    readonly t3: T3Client;
    readonly bearerToken: string;
    readonly pairing: BridgePairingSession;
  },
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
): Promise<void> => {
  const method = request.method ?? "GET";
  const url = new NodeURL.URL(request.url ?? "/", "http://127.0.0.1");

  if (method === "GET" && url.pathname === "/v1/health") {
    const environment = options.store.snapshot().environment;
    sendJson(response, 200, {
      apiVersion: BRIDGE_API_VERSION,
      bridgeVersion: BRIDGE_VERSION,
      status: options.t3.connected() ? "live" : environment === null ? "starting" : "degraded",
      t3Connection: environment?.connection ?? "offline",
    });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/pairing") {
    const body = await decodePairing(await readJsonBody(request));
    const token = options.pairing.exchange(body.code);
    if (token === null) {
      sendJson(response, 401, { error: "invalid_or_expired_pairing_code" });
      return;
    }
    sendJson(response, 200, { tokenType: "Bearer", accessToken: token });
    return;
  }

  if (!authorized(request, options.bearerToken)) {
    response.setHeader("WWW-Authenticate", 'Bearer realm="VoiceInk T3 Bridge"');
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }

  if (method === "GET" && url.pathname === "/v1/capabilities") {
    sendJson(response, 200, {
      apiVersion: BRIDGE_API_VERSION,
      statusSchemaVersion: STATUS_SCHEMA_VERSION,
      bridgeVersion: BRIDGE_VERSION,
      compatible: true,
      scopes: ["orchestration:read", "orchestration:operate"],
      capabilities: [
        "environment.read",
        "project.read",
        "thread.read",
        "thread.diff.read",
        "event.subscribe",
        "project.create",
        "thread.create",
        "thread.adopt",
        "thread.turn.start",
        "thread.turn.interrupt",
        "thread.session.stop",
        "thread.approval.respond",
        "thread.user-input.respond",
      ],
    });
    return;
  }

  const snapshot = options.store.snapshot();
  if (method === "GET" && url.pathname === "/v1/environments") {
    sendJson(response, 200, {
      environments: snapshot.environment === null ? [] : [snapshot.environment],
    });
    return;
  }
  if (method === "GET" && url.pathname === "/v1/projects") {
    sendJson(response, 200, { projects: snapshot.projects });
    return;
  }
  if (method === "GET" && url.pathname === "/v1/threads") {
    const projectId = url.searchParams.get("projectId");
    const threads =
      projectId === null
        ? snapshot.threads
        : snapshot.threads.filter((thread) => thread.projectId === projectId);
    sendJson(response, 200, { threads });
    return;
  }
  if (method === "GET" && url.pathname === "/v1/events") {
    streamEvents(options.store, request, response, parseCursor(url.searchParams.get("after")));
    return;
  }

  const projectMatch = /^\/v1\/projects\/([^/]+)$/.exec(url.pathname);
  if (method === "GET" && projectMatch?.[1] !== undefined) {
    const projectId = decodeURIComponent(projectMatch[1]);
    const project = snapshot.projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) sendJson(response, 404, { error: "not_found" });
    else sendJson(response, 200, { project });
    return;
  }

  const threadMatch = /^\/v1\/threads\/([^/]+)$/.exec(url.pathname);
  if (method === "GET" && threadMatch?.[1] !== undefined) {
    const threadId = decodeURIComponent(threadMatch[1]);
    const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
    if (thread === undefined) {
      sendJson(response, 404, { error: "not_found" });
    } else {
      sendJson(response, 200, { thread, detail: snapshot.details[threadId] ?? null });
    }
    return;
  }

  const diffMatch = /^\/v1\/threads\/([^/]+)\/diff$/.exec(url.pathname);
  if (method === "GET" && diffMatch?.[1] !== undefined) {
    const threadId = decodeURIComponent(diffMatch[1]);
    const detail = snapshot.details[threadId];
    if (detail === undefined) {
      sendJson(response, 409, { error: "thread_detail_not_ready" });
      return;
    }
    if (detail.checkpointCount === 0) {
      sendJson(response, 200, {
        threadId,
        diff: "",
        fromTurnCount: 0,
        toTurnCount: 0,
      });
      return;
    }
    const diff = await options.t3.fullThreadDiff(threadId, detail.checkpointCount);
    sendJson(response, 200, { threadId, ...diff });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/projects") {
    sendJson(
      response,
      202,
      await options.commands.createProject(await decodeCreateProject(await readJsonBody(request))),
    );
    return;
  }
  if (method === "POST" && url.pathname === "/v1/threads") {
    sendJson(
      response,
      202,
      await options.commands.createThread(await decodeCreateThread(await readJsonBody(request))),
    );
    return;
  }

  const adoptMatch = /^\/v1\/threads\/([^/]+)\/adopt$/.exec(url.pathname);
  if (method === "POST" && adoptMatch?.[1] !== undefined) {
    const threadId = decodeURIComponent(adoptMatch[1]);
    await decodeThreadCommand(await readJsonBody(request));
    options.commands.adopt(threadId);
    sendJson(response, 200, { threadId, ownership: "t3code", managed: true });
    return;
  }

  const turnMatch = /^\/v1\/threads\/([^/]+)\/turns$/.exec(url.pathname);
  if (method === "POST" && turnMatch?.[1] !== undefined) {
    const threadId = decodeURIComponent(turnMatch[1]);
    sendJson(
      response,
      202,
      await options.commands.startTurn(
        threadId,
        await decodeStartTurn(await readJsonBody(request)),
      ),
    );
    return;
  }

  const interruptMatch = /^\/v1\/threads\/([^/]+)\/interrupt$/.exec(url.pathname);
  if (method === "POST" && interruptMatch?.[1] !== undefined) {
    const threadId = decodeURIComponent(interruptMatch[1]);
    sendJson(
      response,
      202,
      await options.commands.interrupt(
        threadId,
        await decodeThreadCommand(await readJsonBody(request)),
      ),
    );
    return;
  }

  const stopMatch = /^\/v1\/threads\/([^/]+)\/stop$/.exec(url.pathname);
  if (method === "POST" && stopMatch?.[1] !== undefined) {
    const threadId = decodeURIComponent(stopMatch[1]);
    sendJson(
      response,
      202,
      await options.commands.stop(threadId, await decodeThreadCommand(await readJsonBody(request))),
    );
    return;
  }

  const approvalMatch = /^\/v1\/approvals\/([^/]+)\/respond$/.exec(url.pathname);
  if (method === "POST" && approvalMatch?.[1] !== undefined) {
    const requestId = decodeURIComponent(approvalMatch[1]);
    const body = await decodeApprovalResponse(await readJsonBody(request));
    sendJson(response, 202, await options.commands.respondApproval(body.threadId, requestId, body));
    return;
  }

  const inputMatch = /^\/v1\/user-input\/([^/]+)\/respond$/.exec(url.pathname);
  if (method === "POST" && inputMatch?.[1] !== undefined) {
    const requestId = decodeURIComponent(inputMatch[1]);
    const body = await decodeUserInputResponse(await readJsonBody(request));
    sendJson(
      response,
      202,
      await options.commands.respondUserInput(body.threadId, requestId, body),
    );
    return;
  }

  sendJson(response, 404, { error: "not_found" });
};

const authorized = (request: NodeHttp.IncomingMessage, expected: string): boolean => {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  return safeEqual(header.slice("Bearer ".length), expected);
};

const safeEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length && NodeCrypto.timingSafeEqual(leftBytes, rightBytes)
  );
};

class RequestBodyError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const readJsonBody = async (request: NodeHttp.IncomingMessage): Promise<unknown> => {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new RequestBodyError(415, "unsupported_media_type");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) throw new RequestBodyError(413, "request_too_large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestBodyError(400, "invalid_json");
  }
};

const sendJson = (response: NodeHttp.ServerResponse, status: number, value: unknown): void => {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
};

const parseCursor = (value: string | null): number => {
  if (value === null || value === "") return 0;
  if (!/^[0-9]+$/.test(value)) throw new RequestBodyError(400, "invalid_cursor");
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) throw new RequestBodyError(400, "invalid_cursor");
  return cursor;
};

const streamEvents = (
  store: BridgeStore,
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  after: number,
): void => {
  const existing = store.eventsAfter(after);
  response.writeHead(200, {
    "Cache-Control": "no-cache, no-store",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
  });
  response.write(": voiceink-t3-bridge\n\n");
  for (const event of existing) writeEvent(response, event);
  const unsubscribe = store.subscribe((event) => {
    if (response.writableLength > MAX_SSE_BUFFER_BYTES) {
      response.destroy();
      return;
    }
    writeEvent(response, event);
  });
  const heartbeat = NodeTimers.setInterval(() => {
    if (!response.destroyed) response.write(": keepalive\n\n");
  }, 15_000);
  request.once("close", () => {
    NodeTimers.clearInterval(heartbeat);
    unsubscribe();
  });
};

const writeEvent = (response: NodeHttp.ServerResponse, event: BridgeStatusEvent): void => {
  response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
};
