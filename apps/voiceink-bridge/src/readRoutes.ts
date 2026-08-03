import type * as NodeHttp from "node:http";
import type * as NodeURL from "node:url";

import type { OrchestrationThread } from "@t3tools/contracts";

import { normalizeProject, normalizeThread, redactOutput } from "./normalization.ts";
import {
  BridgeStore,
  minimizedActivitySummary,
  requestDetailsFromActivity,
  requestIdFromPayload,
} from "./store.ts";
import type { T3Client } from "./t3Client.ts";
import type { BridgeThread } from "./types.ts";

/** Per-response text bound. Larger content is read in explicit chunks. */
const MESSAGE_TEXT_CHUNK_CHARS = 20_000;
/** Bound for the speech-facing summary view. */
const SPOKEN_SUMMARY_CHARS = 1_200;
const PLAN_MARKDOWN_CHARS = 20_000;

export interface ReadRouteContext {
  readonly method: string;
  readonly path: string;
  readonly url: NodeURL.URL;
  readonly response: NodeHttp.ServerResponse;
}

export interface ReadRouteOptions {
  readonly store: BridgeStore;
  readonly t3: T3Client;
}

class ReadRouteError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/**
 * Handle a Bridge v3 read route (path already normalized to the /v1 prefix).
 * Returns false when the route is not a v3 read so the caller continues.
 */
export const handleV3ReadRoute = async (
  options: ReadRouteOptions,
  context: ReadRouteContext,
): Promise<boolean> => {
  const { method, path, url, response } = context;
  try {
    if (method === "GET" && path === "/v1/search") {
      await handleSearch(options, url, response);
      return true;
    }
    if (method === "GET" && path === "/v1/archived") {
      await handleArchived(options, response);
      return true;
    }
    const messageChunk = /^\/v1\/threads\/([^/]+)\/messages\/([^/]+)$/.exec(path);
    if (method === "GET" && messageChunk !== null) {
      await handleMessageChunk(
        options,
        decodeURIComponent(messageChunk[1]!),
        decodeURIComponent(messageChunk[2]!),
        url,
        response,
      );
      return true;
    }
    const collection =
      /^\/v1\/threads\/([^/]+)\/(messages|activities|interactions|checkpoints|turn-diff|plans|summary|retain)$/.exec(
        path,
      );
    if (collection === null) return false;
    const threadId = decodeURIComponent(collection[1]!);
    const kind = collection[2]!;
    if (kind === "retain") {
      if (method === "POST") {
        options.t3.retainThread(threadId);
        sendJson(response, 200, {
          threadId,
          retained: true,
          retainedThreadIds: options.t3.retainedThreadIds(),
        });
        return true;
      }
      if (method === "DELETE") {
        options.t3.releaseThread(threadId);
        sendJson(response, 200, {
          threadId,
          retained: false,
          retainedThreadIds: options.t3.retainedThreadIds(),
        });
        return true;
      }
      return false;
    }
    if (method !== "GET") return false;
    switch (kind) {
      case "messages":
        await handleMessages(options, threadId, url, response);
        return true;
      case "activities":
        await handleActivities(options, threadId, url, response);
        return true;
      case "interactions":
        await handleInteractions(options, threadId, response);
        return true;
      case "checkpoints":
        await handleCheckpoints(options, threadId, response);
        return true;
      case "turn-diff":
        await handleTurnDiff(options, threadId, url, response);
        return true;
      case "plans": {
        const planId = url.searchParams.get("planId");
        await handlePlans(options, threadId, planId, response);
        return true;
      }
      case "summary":
        await handleSummary(options, threadId, response);
        return true;
      default:
        return false;
    }
  } catch (error) {
    if (error instanceof ReadRouteError) {
      sendJson(response, error.status, { error: error.code });
      return true;
    }
    if (error instanceof Error && error.message === "t3_unavailable") {
      sendJson(response, 503, { error: "t3_unavailable" });
      return true;
    }
    if (error instanceof Error && error.message === "thread_snapshot_unavailable") {
      sendJson(response, 404, { error: "not_found" });
      return true;
    }
    throw error;
  }
};

const requireConnected = (options: ReadRouteOptions): void => {
  if (!options.t3.connected()) throw new ReadRouteError(503, "t3_unavailable");
};

const fetchThread = async (
  options: ReadRouteOptions,
  threadId: string,
): Promise<OrchestrationThread> => {
  requireConnected(options);
  return options.t3.threadDetail(threadId);
};

/**
 * Case- and diacritic-insensitive fold so German titles match spoken queries
 * ("Übersicht" matches "ubersicht", "groß" matches "gross").
 */
const fold = (value: string): string =>
  value.toLowerCase().replaceAll("ß", "ss").normalize("NFKD").replace(/\p{M}/gu, "");

const handleSearch = async (
  options: ReadRouteOptions,
  url: NodeURL.URL,
  response: NodeHttp.ServerResponse,
): Promise<void> => {
  const query = url.searchParams.get("q") ?? "";
  if (query.trim().length < 2 || query.length > 200) {
    throw new ReadRouteError(400, "invalid_query");
  }
  const scope = url.searchParams.get("scope") ?? "all";
  if (scope !== "active" && scope !== "archived" && scope !== "all") {
    throw new ReadRouteError(400, "invalid_scope");
  }
  const projectId = url.searchParams.get("projectId");
  const provider = url.searchParams.get("provider");
  const status = url.searchParams.get("status");
  const updatedAfter = url.searchParams.get("updatedAfter");
  const offset = parseOffset(url.searchParams.get("cursor"));
  const limit = parseLimit(url.searchParams.get("limit"), 50);
  requireConnected(options);

  interface SearchRow {
    readonly threadId: string;
    readonly projectId: string;
    readonly title: string | null;
    readonly archived: boolean;
    readonly updatedAt: string | null;
    readonly provider: string | null;
    readonly model: string | null;
    readonly status: string | null;
    readonly matchedBy: string[];
    readonly snippet?: string;
    readonly messageCreatedAt?: string | null;
  }
  const rows = new Map<string, SearchRow>();
  const folded = fold(query.trim());

  const addTitleMatches = (threads: ReadonlyArray<BridgeThread>, archived: boolean): void => {
    for (const thread of threads) {
      if (!fold(thread.title).includes(folded)) continue;
      const existing = rows.get(thread.id);
      if (existing !== undefined) {
        existing.matchedBy.push("title");
        continue;
      }
      rows.set(thread.id, {
        threadId: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        archived,
        updatedAt: thread.updatedAt,
        provider: thread.provider,
        model: thread.model,
        status: thread.status,
        matchedBy: ["title"],
      });
    }
  };

  const activeThreads = options.store.snapshot().threads;
  if (scope !== "archived") addTitleMatches(activeThreads, false);
  let archivedThreads: ReadonlyArray<BridgeThread> = [];
  if (scope !== "active") {
    const snapshot = await options.t3.archivedShellSnapshot();
    archivedThreads = snapshot.threads.map((thread) => normalizeThread(thread, "live", false));
    addTitleMatches(archivedThreads, true);
  }

  const known = new Map<string, { archived: boolean; thread: BridgeThread }>();
  for (const thread of activeThreads) known.set(thread.id, { archived: false, thread });
  for (const thread of archivedThreads) {
    if (!known.has(thread.id)) known.set(thread.id, { archived: true, thread });
  }

  const matches = await options.t3.searchThreads(query.trim(), 50);
  for (const match of matches) {
    const shell = known.get(match.threadId);
    if (scope === "active" && shell?.archived !== false) continue;
    if (scope === "archived" && shell?.archived !== true) continue;
    const snippet = redactOutput(match.snippet);
    const existing = rows.get(match.threadId);
    if (existing !== undefined) {
      existing.matchedBy.push(`content:${match.source}`);
      if (existing.snippet === undefined) {
        rows.set(match.threadId, {
          ...existing,
          snippet,
          messageCreatedAt: match.messageCreatedAt,
        });
      }
      continue;
    }
    rows.set(match.threadId, {
      threadId: match.threadId,
      projectId: match.projectId,
      title: shell?.thread.title ?? null,
      archived: shell?.archived ?? false,
      updatedAt: shell?.thread.updatedAt ?? null,
      provider: shell?.thread.provider ?? null,
      model: shell?.thread.model ?? null,
      status: shell?.thread.status ?? null,
      matchedBy: [`content:${match.source}`],
      snippet,
      messageCreatedAt: match.messageCreatedAt,
    });
  }

  const filtered = [...rows.values()]
    .filter((row) => projectId === null || row.projectId === projectId)
    .filter((row) => provider === null || row.provider === provider)
    .filter((row) => status === null || row.status === status)
    .filter(
      (row) => updatedAfter === null || (row.updatedAt !== null && row.updatedAt > updatedAfter),
    )
    .toSorted(
      (left, right) =>
        (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") ||
        left.threadId.localeCompare(right.threadId),
    );
  const page = filtered.slice(offset, offset + limit);
  sendJson(response, 200, {
    query: query.trim(),
    scope,
    results: page,
    nextCursor: offset + page.length < filtered.length ? String(offset + page.length) : null,
    totalMatched: filtered.length,
    freshness: "live",
  });
};

const handleArchived = async (
  options: ReadRouteOptions,
  response: NodeHttp.ServerResponse,
): Promise<void> => {
  requireConnected(options);
  const snapshot = await options.t3.archivedShellSnapshot();
  sendJson(response, 200, {
    snapshotSequence: snapshot.snapshotSequence,
    updatedAt: snapshot.updatedAt,
    projects: snapshot.projects.map((project) => normalizeProject(project, "live")),
    threads: snapshot.threads.map((thread) => publicThread(normalizeThread(thread, "live", false))),
    freshness: "live",
  });
};

const handleMessages = async (
  options: ReadRouteOptions,
  threadId: string,
  url: NodeURL.URL,
  response: NodeHttp.ServerResponse,
): Promise<void> => {
  const offset = parseOffset(url.searchParams.get("cursor"));
  const limit = parseLimit(url.searchParams.get("limit"), 50);
  const thread = await fetchThread(options, threadId);
  const page = thread.messages.slice(offset, offset + limit).map((message) => {
    const safe = redactOutput(message.text);
    const truncated = safe.length > MESSAGE_TEXT_CHUNK_CHARS;
    return {
      id: message.id,
      role: message.role,
      turnId: message.turnId,
      streaming: message.streaming,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      text: truncated ? safe.slice(0, MESSAGE_TEXT_CHUNK_CHARS) : safe,
      textLength: safe.length,
      truncated,
      attachments: (message.attachments ?? []).map((attachment) => ({
        type: attachment.type,
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      })),
    };
  });
  sendJson(response, 200, {
    threadId: thread.id,
    projectId: thread.projectId,
    messages: page,
    totalMessages: thread.messages.length,
    nextCursor: offset + page.length < thread.messages.length ? String(offset + page.length) : null,
    freshness: "live",
    ownership: "t3code",
  });
};

const handleMessageChunk = async (
  options: ReadRouteOptions,
  threadId: string,
  messageId: string,
  url: NodeURL.URL,
  response: NodeHttp.ServerResponse,
): Promise<void> => {
  const offset = parseOffset(url.searchParams.get("offset"));
  const thread = await fetchThread(options, threadId);
  const message = thread.messages.find((candidate) => candidate.id === messageId);
  if (message === undefined) throw new ReadRouteError(404, "not_found");
  const safe = redactOutput(message.text);
  const text = safe.slice(offset, offset + MESSAGE_TEXT_CHUNK_CHARS);
  sendJson(response, 200, {
    threadId: thread.id,
    messageId: message.id,
    offset,
    text,
    totalLength: safe.length,
    nextOffset: offset + text.length < safe.length ? offset + text.length : null,
    freshness: "live",
  });
};

const handleActivities = async (
  options: ReadRouteOptions,
  threadId: string,
  url: NodeURL.URL,
  response: NodeHttp.ServerResponse,
): Promise<void> => {
  const offset = parseOffset(url.searchParams.get("cursor"));
  const limit = parseLimit(url.searchParams.get("limit"), 100);
  const thread = await fetchThread(options, threadId);
  const page = thread.activities.slice(offset, offset + limit).map((activity) => {
    const requestId = requestIdFromPayload(activity.payload);
    const request = requestDetailsFromActivity(activity.payload, activity.kind);
    return {
      id: activity.id,
      tone: activity.tone,
      kind: activity.kind,
      summary: minimizedActivitySummary(activity.tone),
      createdAt: activity.createdAt,
      ...(requestId === null ? {} : { requestId }),
      ...(request === undefined ? {} : { request }),
    };
  });
  sendJson(response, 200, {
    threadId: thread.id,
    projectId: thread.projectId,
    activities: page,
    totalActivities: thread.activities.length,
    nextCursor:
      offset + page.length < thread.activities.length ? String(offset + page.length) : null,
    freshness: "live",
  });
};

const handleInteractions = async (
  options: ReadRouteOptions,
  threadId: string,
  response: NodeHttp.ServerResponse,
): Promise<void> => {
  const thread = await fetchThread(options, threadId);
  const shell = options.store.snapshot().threads.find((candidate) => candidate.id === threadId);
  const requests = thread.activities
    .map((activity) => {
      const request = requestDetailsFromActivity(activity.payload, activity.kind);
      return request === undefined
        ? null
        : { activityId: activity.id, createdAt: activity.createdAt, ...request };
    })
    .filter((request): request is NonNullable<typeof request> => request !== null);
  sendJson(response, 200, {
    threadId: thread.id,
    projectId: thread.projectId,
    pendingApprovals: shell?.status === "waiting_for_approval",
    pendingUserInput: shell?.status === "waiting_for_input",
    requests: requests.toReversed(),
    freshness: "live",
  });
};

const handleCheckpoints = async (
  options: ReadRouteOptions,
  threadId: string,
  response: NodeHttp.ServerResponse,
): Promise<void> => {
  const thread = await fetchThread(options, threadId);
  sendJson(response, 200, {
    threadId: thread.id,
    projectId: thread.projectId,
    checkpoints: thread.checkpoints.map((checkpoint) => ({
      turnId: checkpoint.turnId,
      checkpointTurnCount: checkpoint.checkpointTurnCount,
      checkpointRef: checkpoint.checkpointRef,
      status: checkpoint.status,
      completedAt: checkpoint.completedAt,
      assistantMessageId: checkpoint.assistantMessageId,
      files: checkpoint.files.map((file) => ({
        path: file.path,
        kind: file.kind,
        additions: file.additions,
        deletions: file.deletions,
      })),
      revertTarget: {
        command: "thread.checkpoint.revert",
        turnCount: checkpoint.checkpointTurnCount,
      },
    })),
    freshness: "live",
  });
};

const handleTurnDiff = async (
  options: ReadRouteOptions,
  threadId: string,
  url: NodeURL.URL,
  response: NodeHttp.ServerResponse,
): Promise<void> => {
  const fromTurnCount = parseRequiredInt(url.searchParams.get("fromTurnCount"), "invalid_from");
  const toTurnCount = parseRequiredInt(url.searchParams.get("toTurnCount"), "invalid_to");
  const ignoreWhitespace = url.searchParams.get("ignoreWhitespace") === "true";
  requireConnected(options);
  const diff = await options.t3.turnDiff(threadId, fromTurnCount, toTurnCount, ignoreWhitespace);
  sendJson(response, 200, { threadId, ...diff, freshness: "live" });
};

const handlePlans = async (
  options: ReadRouteOptions,
  threadId: string,
  planId: string | null,
  response: NodeHttp.ServerResponse,
): Promise<void> => {
  const thread = await fetchThread(options, threadId);
  const shell = options.store.snapshot().threads.find((candidate) => candidate.id === threadId);
  const plans = thread.proposedPlans
    .filter((plan) => planId === null || plan.id === planId)
    .map((plan) => {
      const safe = redactOutput(plan.planMarkdown);
      const truncated = safe.length > PLAN_MARKDOWN_CHARS;
      return {
        id: plan.id,
        turnId: plan.turnId,
        planMarkdown: truncated ? safe.slice(0, PLAN_MARKDOWN_CHARS) : safe,
        planMarkdownLength: safe.length,
        truncated,
        implementedAt: plan.implementedAt,
        implementationThreadId: plan.implementationThreadId,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
        sourceReference: { threadId: thread.id, planId: plan.id },
      };
    });
  if (planId !== null && plans.length === 0) throw new ReadRouteError(404, "not_found");
  sendJson(response, 200, {
    threadId: thread.id,
    projectId: thread.projectId,
    hasActionableProposedPlan: shell?.hasActionableProposedPlan ?? false,
    plans,
    freshness: "live",
  });
};

const handleSummary = async (
  options: ReadRouteOptions,
  threadId: string,
  response: NodeHttp.ServerResponse,
): Promise<void> => {
  const thread = await fetchThread(options, threadId);
  const shell = options.store.snapshot().threads.find((candidate) => candidate.id === threadId);
  const latestAssistant = thread.messages
    .toReversed()
    .find((message) => message.role === "assistant" && message.text.trim().length > 0);
  const safe = latestAssistant === undefined ? null : redactOutput(latestAssistant.text);
  const truncated = safe !== null && safe.length > SPOKEN_SUMMARY_CHARS;
  sendJson(response, 200, {
    threadId: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    status: shell?.status ?? null,
    attention: shell?.attention ?? null,
    archived: thread.archivedAt !== null,
    spokenSummary:
      safe === null ? null : truncated ? `${safe.slice(0, SPOKEN_SUMMARY_CHARS)}…` : safe,
    truncated,
    latestAssistantMessageId: latestAssistant?.id ?? null,
    totalMessages: thread.messages.length,
    updatedAt: thread.updatedAt,
    freshness: "live",
    ownership: "t3code",
  });
};

const publicThread = (thread: BridgeThread): Omit<BridgeThread, "managed"> => {
  const { managed: _managed, ...value } = thread;
  return value;
};

const parseOffset = (value: string | null): number => {
  if (value === null || value === "") return 0;
  if (!/^[0-9]+$/.test(value)) throw new ReadRouteError(400, "invalid_cursor");
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset > 10_000_000) {
    throw new ReadRouteError(400, "invalid_cursor");
  }
  return offset;
};

const parseLimit = (value: string | null, fallback: number): number => {
  if (value === null || value === "") return fallback;
  if (!/^[0-9]+$/.test(value)) throw new ReadRouteError(400, "invalid_limit");
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new ReadRouteError(400, "invalid_limit");
  }
  return limit;
};

const parseRequiredInt = (value: string | null, code: string): number => {
  if (value === null || !/^[0-9]+$/.test(value)) throw new ReadRouteError(400, code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ReadRouteError(400, code);
  return parsed;
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
