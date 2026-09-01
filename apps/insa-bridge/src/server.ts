import NodeHttp from "node:http";
import NodeTimers from "node:timers";
import type {
  BridgeCommandService,
  BridgeStatusEvent,
  BridgeStore,
  T3Client,
} from "@t3tools/bridge-client";
import { decodeCanonicalCommand } from "@t3tools/bridge-client";

const MAX_SSE_BUFFER_BYTES = 1024 * 1024;

export interface InsaBridgeServerOptions {
  readonly store: BridgeStore;
  readonly commands: BridgeCommandService;
  readonly t3: T3Client;
  readonly bearerToken: string;
  /** Versions-Wächter: erwartete (Repo-)Version vs. verbundener Server. */
  readonly version?: () => { expected: string; actual: string | null };
}

/**
 * Insa-T3-Bridge: bewusst kleiner Contract (v1) für den Insa-Daemon.
 * Lesen aus dem lokalen Spiegel (funktioniert auch bei T3-Offline),
 * Live-Routen und Kommandos fail-closed mit klaren Fehlern — die
 * Robustheits-Lektion der alten Bridge (Abbrüche, Zugriffsprobleme)
 * steckt in der wiederverwendeten Command-/Client-Schicht.
 */
export function createInsaBridgeServer(options: InsaBridgeServerOptions) {
  const eventStreams = new Set<NodeHttp.ServerResponse>();
  const server = NodeHttp.createServer((request, response) => {
    void route(options, request, response, eventStreams).catch((error: unknown) => {
      const known = error as { statusCode?: number; message?: string };
      sendJson(response, known.statusCode ?? 500, {
        error: known.message?.slice(0, 300) ?? "internal_error",
      });
    });
  });
  return {
    /** port 0 = ephemer; liefert den tatsächlich gebundenen Port. */
    listen: (port: number) =>
      new Promise<number>((resolve) =>
        server.listen(port, "127.0.0.1", () => {
          const address = server.address();
          resolve(typeof address === "object" && address !== null ? address.port : port);
        }),
      ),
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const response of eventStreams) response.destroy();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}

const fail = (statusCode: number, message: string): never => {
  throw Object.assign(new Error(message), { statusCode });
};

async function route(
  options: InsaBridgeServerOptions,
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  eventStreams: Set<NodeHttp.ServerResponse>,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  const method = request.method ?? "GET";

  if (request.headers.authorization !== `Bearer ${options.bearerToken}`) {
    return sendJson(response, 401, { error: "unauthorized" });
  }

  if (method === "GET" && path === "/v1/health") {
    const snapshot = options.store.snapshot();
    const connected = options.t3.connected();
    const version = options.version?.() ?? null;
    const versionSkew =
      version !== null && version.actual !== null && version.actual !== version.expected;
    return sendJson(response, 200, {
      apiVersion: 1,
      status: !connected ? "degraded" : versionSkew ? "version-skew" : "ok",
      t3Connection: connected ? "online" : "offline",
      environment: snapshot.environment?.label ?? null,
      sourceCursor: snapshot.sourceCursor,
      eventCursor: options.store.eventsAfter(0).at(-1)?.sequence ?? 0,
      ...(version === null
        ? {}
        : {
            expectedServerVersion: version.expected,
            serverVersion: version.actual,
            versionSkew,
          }),
    });
  }

  if (method === "GET" && path === "/v1/events") {
    return streamEvents(
      options.store,
      request,
      response,
      parseCursor(url.searchParams.get("after")),
      eventStreams,
    );
  }

  if (method === "GET" && path === "/v1/projects") {
    return sendJson(response, 200, { projects: options.store.snapshot().projects });
  }

  if (method === "GET" && path === "/v1/threads") {
    const projectId = url.searchParams.get("projectId");
    const connected = options.t3.connected();
    const snapshot = options.store.snapshot();
    const threads = snapshot.threads
      .filter((t) => !projectId || t.projectId === projectId)
      .map((t) => ({
        id: t.id,
        environmentId: snapshot.environment?.id ?? null,
        projectId: t.projectId,
        title: t.title,
        provider: t.provider,
        model: t.model,
        status: t.status,
        attention: t.attention,
        outcome: t.outcome,
        interactionMode: t.interactionMode,
        runtimeMode: t.runtimeMode,
        updatedAt: t.updatedAt,
        // Der persistierte Spiegel behält die letzte Quell-Frische. Sobald
        // die Live-Verbindung weg ist, darf die API daraus aber nie ein
        // aktuelles Lebenszeichen machen.
        freshness: connected ? t.freshness : "stale-cache",
        liveVerified: connected && t.freshness === "live",
        branch: t.branch,
        worktreePath: t.worktreePath,
      }));
    return sendJson(response, 200, { threads });
  }

  const outputMatch = /^\/v1\/threads\/([^/]+)\/output$/.exec(path);
  if (method === "GET" && outputMatch) {
    if (!options.t3.connected()) fail(503, "t3_unavailable");
    // Nicht nur die letzte Assistant-Message: Interaktive Rückfragen leben
    // in den activities, vorgelegte Pläne in proposedPlans — ohne beides
    // sah Insa bei waiting_for_input nur Randbemerkungen (Befund 21.08.).
    const [output, detail] = await Promise.all([
      options.t3.threadOutput(outputMatch[1]!),
      options.t3.threadDetail(outputMatch[1]!),
    ]);
    return sendJson(response, 200, {
      ...output,
      latestTurnState: detail.latestTurn?.state ?? null,
      // Broker-Runden bestehen aus User-Result + Assistant-Request. Fünf
      // Nachrichten ließen bei längeren Werkzeugfolgen den Rundenzähler und
      // Abschlussmarker aus dem Sichtfenster fallen. 40 deckt das harte
      // Maximum von zehn Runden plus Start-/Abschluss-Turn mit Reserve ab.
      letzteNachrichten: detail.messages.slice(-40).map((m) => ({
        role: m.role,
        text: m.text.length > 4000 ? `${m.text.slice(0, 4000)}…` : m.text,
        createdAt: m.createdAt,
      })),
      aktivitaeten: detail.activities.slice(-10).map((a) => {
        const payload = a.payload === undefined ? "" : JSON.stringify(a.payload);
        // Bei user-input.requested steckt der komplette Fragenkatalog im
        // payload (ALLE questions eines Requests) — ein knappes Cap schnitt
        // Frage 2/3 ab, Insa beantwortete nur Frage 1 und der Rest wurde
        // mit dem Request verworfen (Befund 21.08. abends).
        const cap = a.kind === "user-input.requested" ? 12_000 : 800;
        return {
          kind: a.kind,
          tone: a.tone,
          summary: a.summary.length > 500 ? `${a.summary.slice(0, 500)}…` : a.summary,
          payload: payload.length > cap ? `${payload.slice(0, cap)}…` : payload,
          createdAt: a.createdAt,
        };
      }),
      vorgeschlagenePlaene: detail.proposedPlans.map((p) => ({
        planMarkdown:
          p.planMarkdown.length > 24_000 ? `${p.planMarkdown.slice(0, 24_000)}…` : p.planMarkdown,
        implementedAt: p.implementedAt,
        createdAt: p.createdAt,
      })),
    });
  }

  const diffMatch = /^\/v1\/threads\/([^/]+)\/diff$/.exec(path);
  if (method === "GET" && diffMatch) {
    if (!options.t3.connected()) fail(503, "t3_unavailable");
    const toTurnCount = Number(url.searchParams.get("toTurnCount") ?? "0");
    return sendJson(response, 200, await options.t3.fullThreadDiff(diffMatch[1]!, toTurnCount));
  }

  if (method === "POST" && path === "/v1/commands") {
    if (!options.t3.connected()) fail(503, "t3_unavailable");
    const rawBody = await readJsonBody(request);
    const command = await decodeCanonicalCommand(rawBody).catch((error: unknown) =>
      fail(422, `invalid_command: ${String(error).slice(0, 200)}`),
    );
    return sendJson(response, 202, await options.commands.canonical(command, rawBody));
  }

  return sendJson(response, 404, { error: "not_found" });
}

const parseCursor = (value: string | null): number => {
  if (value === null || value === "") return 0;
  if (!/^[0-9]+$/.test(value)) fail(400, "invalid_cursor");
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) fail(400, "invalid_cursor");
  return cursor;
};

const streamEvents = (
  store: BridgeStore,
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  after: number,
  eventStreams: Set<NodeHttp.ServerResponse>,
): void => {
  response.writeHead(200, {
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
  });
  eventStreams.add(response);
  response.write(": insa-t3-bridge\n\n");
  for (const event of store.eventsAfter(after)) writeEvent(response, event);
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
  const close = (): void => {
    NodeTimers.clearInterval(heartbeat);
    unsubscribe();
    eventStreams.delete(response);
  };
  request.once("close", close);
  response.once("close", close);
};

const writeEvent = (response: NodeHttp.ServerResponse, event: BridgeStatusEvent): void => {
  response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
};

function sendJson(response: NodeHttp.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readJsonBody(request: NodeHttp.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) fail(413, "body_too_large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) fail(400, "empty_body");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return fail(400, "invalid_json");
  }
}
