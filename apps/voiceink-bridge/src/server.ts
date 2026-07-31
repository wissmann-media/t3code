import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeTimers from "node:timers";
import * as NodeURL from "node:url";

import { BridgeCommandError, BridgeCommandService } from "./commands.ts";
import {
  decodeApprovalResponse,
  decodeCreateProject,
  decodeCreateThread,
  decodeForkThread,
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
  LEGACY_BRIDGE_API_VERSION,
  STATUS_SCHEMA_VERSION,
  type BridgeStatusEvent,
  type BridgeThread,
} from "./types.ts";
import { nowEpochMillis } from "./time.ts";

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
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
  readonly listen: (port: number) => Promise<number>;
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
      new Promise<number>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          const address = server.address();
          resolve(typeof address === "object" && address !== null ? address.port : port);
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
  const apiVersion = url.pathname === "/v2" || url.pathname.startsWith("/v2/") ? 2 : 1;
  const path =
    apiVersion === 2 ? `/v1${url.pathname === "/v2" ? "" : url.pathname.slice(3)}` : url.pathname;

  if (method === "GET" && path === "/v1/health") {
    const environment = options.store.snapshot().environment;
    sendJson(response, 200, {
      apiVersion: apiVersion === 2 ? BRIDGE_API_VERSION : LEGACY_BRIDGE_API_VERSION,
      bridgeVersion: BRIDGE_VERSION,
      status: options.t3.connected() ? "live" : environment === null ? "starting" : "degraded",
      t3Connection: environment?.connection ?? "offline",
    });
    return;
  }

  if (method === "POST" && path === "/v1/pairing") {
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

  if (method === "GET" && path === "/v1/capabilities") {
    sendJson(response, 200, {
      apiVersion: apiVersion === 2 ? BRIDGE_API_VERSION : LEGACY_BRIDGE_API_VERSION,
      statusSchemaVersion: STATUS_SCHEMA_VERSION,
      bridgeVersion: BRIDGE_VERSION,
      compatible: true,
      scopes: ["orchestration:read", "orchestration:operate"],
      providers: options.store.snapshot().environment?.providers ?? [],
      capabilities:
        apiVersion === 2
          ? [
              "environment.read",
              "project.list",
              "project.read",
              "thread.list",
              "thread.read",
              "thread.output.read",
              "thread.activity.read",
              "thread.diff.read",
              "event.subscribe",
              "project.create",
              "thread.create",
              "thread.turn.start",
              "thread.fork.contextual",
              "thread.turn.interrupt",
              "thread.session.stop",
              "thread.approval.respond",
              "thread.user-input.respond",
            ]
          : [
              "environment.read",
              "project.read",
              "thread.read",
              "thread.output.read",
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
      ...(apiVersion === 2 ? { requiresProjectForThread: true, forkModes: ["contextual"] } : {}),
    });
    return;
  }

  const snapshot = options.store.snapshot();
  if (method === "GET" && path === "/v1/environments") {
    sendJson(response, 200, {
      environments: snapshot.environment === null ? [] : [snapshot.environment],
    });
    return;
  }
  if (method === "GET" && path === "/v1/projects") {
    sendJson(response, 200, {
      projects: snapshot.projects.toSorted((left, right) => left.title.localeCompare(right.title)),
    });
    return;
  }
  if (method === "GET" && path === "/v1/threads") {
    const projectId = url.searchParams.get("projectId");
    const status = url.searchParams.get("status");
    const provider = url.searchParams.get("provider");
    const updatedAfter = url.searchParams.get("updatedAfter");
    const selected =
      projectId === null
        ? snapshot.threads
        : snapshot.threads.filter((thread) => thread.projectId === projectId);
    const sorted = selected
      .filter((thread) => status === null || thread.status === status)
      .filter((thread) => provider === null || thread.provider === provider)
      .filter((thread) => updatedAfter === null || thread.updatedAt > updatedAfter)
      .toSorted(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
      );
    if (apiVersion === 1) {
      sendJson(response, 200, { threads: sorted });
      return;
    }
    const offset = parseOptionalOffset(url.searchParams.get("cursor"));
    const limit = parseOptionalLimit(url.searchParams.get("limit"));
    const page = sorted.slice(offset, offset + limit).map(publicThread);
    const nextCursor = offset + page.length < sorted.length ? String(offset + page.length) : null;
    sendJson(response, 200, { threads: page, nextCursor });
    return;
  }
  if (method === "GET" && path === "/v1/events") {
    streamEvents(options.store, request, response, parseCursor(url.searchParams.get("after")));
    return;
  }

  const projectMatch = /^\/v1\/projects\/([^/]+)$/.exec(path);
  if (method === "GET" && projectMatch?.[1] !== undefined) {
    const projectId = decodeURIComponent(projectMatch[1]);
    const project = snapshot.projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) sendJson(response, 404, { error: "not_found" });
    else sendJson(response, 200, { project });
    return;
  }

  const threadMatch = /^\/v1\/threads\/([^/]+)$/.exec(path);
  const threadOutputMatch = /^\/v1\/threads\/([^/]+)\/output$/.exec(path);
  const threadActivityMatch = /^\/v1\/threads\/([^/]+)\/activity$/.exec(path);
  if (method === "GET" && threadOutputMatch?.[1] !== undefined) {
    const threadId = decodeURIComponent(threadOutputMatch[1]);
    const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
    if (thread === undefined) {
      sendJson(response, 404, { error: "not_found" });
    } else if (!options.t3.connected()) {
      sendJson(response, 503, { error: "t3_unavailable" });
    } else {
      const output = await options.t3.threadOutput(threadId);
      if (
        output.threadId !== thread.id ||
        output.projectId !== thread.projectId ||
        output.ownership !== "t3code" ||
        output.freshness !== "live"
      ) {
        sendJson(response, 409, { error: "invalid_thread_output" });
      } else {
        sendJson(response, 200, { output });
      }
    }
    return;
  }

  if (apiVersion === 2 && method === "GET" && threadActivityMatch?.[1] !== undefined) {
    const threadId = decodeURIComponent(threadActivityMatch[1]);
    const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
    if (thread === undefined) {
      sendJson(response, 404, { error: "not_found" });
    } else if (!options.t3.connected()) {
      sendJson(response, 503, { error: "t3_unavailable" });
    } else {
      if (options.store.snapshot().details[threadId] === undefined) {
        await options.t3.refreshThread(threadId);
      }
      sendJson(response, 200, {
        threadId,
        projectId: thread.projectId,
        activity: options.store.snapshot().details[threadId]?.recentActivity ?? [],
      });
    }
    return;
  }

  if (method === "GET" && threadMatch?.[1] !== undefined) {
    const threadId = decodeURIComponent(threadMatch[1]);
    const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
    if (thread === undefined) {
      sendJson(response, 404, { error: "not_found" });
    } else {
      sendJson(response, 200, {
        thread: apiVersion === 2 ? publicThread(thread) : thread,
        detail: snapshot.details[threadId] ?? null,
      });
    }
    return;
  }

  const diffMatch = /^\/v1\/threads\/([^/]+)\/diff$/.exec(path);
  if (method === "GET" && diffMatch?.[1] !== undefined) {
    const threadId = decodeURIComponent(diffMatch[1]);
    let detail = snapshot.details[threadId];
    if (detail === undefined && apiVersion === 2 && options.t3.connected()) {
      await options.t3.refreshThread(threadId);
      detail = options.store.snapshot().details[threadId];
    }
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

  if (method === "POST" && path === "/v1/projects") {
    sendJson(
      response,
      202,
      await options.commands.createProject(await decodeCreateProject(await readJsonBody(request))),
    );
    return;
  }
  if (method === "POST" && path === "/v1/threads") {
    sendJson(
      response,
      202,
      await options.commands.createThread(await decodeCreateThread(await readJsonBody(request))),
    );
    return;
  }

  const adoptMatch = /^\/v1\/threads\/([^/]+)\/adopt$/.exec(path);
  if (apiVersion === 1 && method === "POST" && adoptMatch?.[1] !== undefined) {
    const threadId = decodeURIComponent(adoptMatch[1]);
    await decodeThreadCommand(await readJsonBody(request));
    options.commands.adopt(threadId);
    sendJson(response, 200, { threadId, ownership: "t3code", managed: true });
    return;
  }

  const turnMatch = /^\/v1\/threads\/([^/]+)\/turns$/.exec(path);
  if (method === "POST" && turnMatch?.[1] !== undefined) {
    const threadId = decodeURIComponent(turnMatch[1]);
    sendJson(
      response,
      202,
      await options.commands.startTurn(
        threadId,
        await decodeStartTurn(await readJsonBody(request)),
        apiVersion === 2,
      ),
    );
    return;
  }

  const forkMatch = /^\/v1\/threads\/([^/]+)\/forks$/.exec(path);
  if (apiVersion === 2 && method === "POST" && forkMatch?.[1] !== undefined) {
    const sourceThreadId = decodeURIComponent(forkMatch[1]);
    sendJson(
      response,
      202,
      await options.commands.forkThread(
        sourceThreadId,
        await decodeForkThread(await readJsonBody(request)),
      ),
    );
    return;
  }

  const interruptMatch = /^\/v1\/threads\/([^/]+)\/interrupt$/.exec(path);
  if (method === "POST" && interruptMatch?.[1] !== undefined) {
    const threadId = decodeURIComponent(interruptMatch[1]);
    sendJson(
      response,
      202,
      await options.commands.interrupt(
        threadId,
        await decodeThreadCommand(await readJsonBody(request)),
        apiVersion === 2,
      ),
    );
    return;
  }

  const stopMatch = /^\/v1\/threads\/([^/]+)\/stop$/.exec(path);
  if (method === "POST" && stopMatch?.[1] !== undefined) {
    const threadId = decodeURIComponent(stopMatch[1]);
    sendJson(
      response,
      202,
      await options.commands.stop(
        threadId,
        await decodeThreadCommand(await readJsonBody(request)),
        apiVersion === 2,
      ),
    );
    return;
  }

  const approvalMatch = /^\/v1\/approvals\/([^/]+)\/respond$/.exec(path);
  if (method === "POST" && approvalMatch?.[1] !== undefined) {
    const requestId = decodeURIComponent(approvalMatch[1]);
    const body = await decodeApprovalResponse(await readJsonBody(request));
    sendJson(
      response,
      202,
      await options.commands.respondApproval(body.threadId, requestId, body, apiVersion === 2),
    );
    return;
  }

  const inputMatch = /^\/v1\/user-input\/([^/]+)\/respond$/.exec(path);
  if (method === "POST" && inputMatch?.[1] !== undefined) {
    const requestId = decodeURIComponent(inputMatch[1]);
    const body = await decodeUserInputResponse(await readJsonBody(request));
    sendJson(
      response,
      202,
      await options.commands.respondUserInput(body.threadId, requestId, body, apiVersion === 2),
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
  let body = Buffer.from(`${JSON.stringify(value)}\n`);
  if (body.length > MAX_RESPONSE_BYTES) {
    status = 507;
    body = Buffer.from('{"error":"response_too_large"}\n');
  }
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
};

const parseOptionalOffset = (value: string | null): number => {
  if (value === null || value === "") return 0;
  if (!/^[0-9]+$/.test(value)) throw new RequestBodyError(400, "invalid_cursor");
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset > 100_000) {
    throw new RequestBodyError(400, "invalid_cursor");
  }
  return offset;
};

const parseOptionalLimit = (value: string | null): number => {
  if (value === null || value === "") return 200;
  if (!/^[0-9]+$/.test(value)) throw new RequestBodyError(400, "invalid_limit");
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new RequestBodyError(400, "invalid_limit");
  }
  return limit;
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

const publicThread = (thread: BridgeThread): Omit<BridgeThread, "managed"> => {
  const { managed: _managed, ...value } = thread;
  return value;
};
