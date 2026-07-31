import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { OrchestrationThread } from "@t3tools/contracts";

import { normalizeProject, normalizeThread } from "./normalization.ts";
import { nowIso } from "./time.ts";
import type {
  BridgeEnvironment,
  BridgeProject,
  BridgeSnapshot,
  BridgeStatusEvent,
  BridgeThread,
  BridgeThreadDetail,
  CommandReceiptRecord,
  PersistedBridgeState,
  T3ShellItem,
  T3ThreadItem,
} from "./types.ts";

const MAX_EVENTS = 10_000;
const MAX_RECEIPTS = 2_000;

const emptySnapshot = (): BridgeSnapshot => ({
  sourceCursor: 0,
  environment: null,
  projects: [],
  threads: [],
  details: {},
  managedThreadIds: [],
  threadLineage: {},
});

const emptyState = (): PersistedBridgeState => ({
  schemaVersion: 1,
  snapshot: emptySnapshot(),
  events: [],
  dedupeKeys: [],
  commandReceipts: [],
});

export const resumableShellCursor = (snapshot: BridgeSnapshot): number => {
  const environment = snapshot.environment;
  const fullyLive =
    environment !== null &&
    environment.connection === "live" &&
    environment.freshness === "live" &&
    snapshot.projects.every((project) => project.freshness === "live") &&
    snapshot.threads.every((thread) => thread.freshness === "live");
  return fullyLive && snapshot.sourceCursor > 0 ? snapshot.sourceCursor : 0;
};

export class BridgeStore {
  private state: PersistedBridgeState;
  private readonly eventListeners = new Set<(event: BridgeStatusEvent) => void>();
  private readonly filePath: string | null;

  constructor(filePath: string | null = null) {
    this.filePath = filePath;
    this.state = this.load();
    if (this.filePath !== null) this.persist();
  }

  snapshot(): BridgeSnapshot {
    return this.state.snapshot;
  }

  eventsAfter(sequence: number): ReadonlyArray<BridgeStatusEvent> {
    return this.state.events.filter((event) => event.sequence > sequence);
  }

  subscribe(listener: (event: BridgeStatusEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  markConnecting(): void {
    this.updateEnvironment({
      connection: "connecting",
      freshness: this.state.snapshot.environment === null ? "offline" : "stale",
      errorCode: null,
    });
  }

  markConnected(environment: {
    readonly id: string;
    readonly label: string;
    readonly serverVersion: string;
    readonly providers?: BridgeEnvironment["providers"];
  }): void {
    const timestamp = nowIso();
    const next: BridgeEnvironment = {
      id: environment.id,
      label: environment.label,
      serverVersion: environment.serverVersion,
      connection: "live",
      freshness: "live",
      lastConnectedAt: timestamp,
      lastSnapshotAt: this.state.snapshot.environment?.lastSnapshotAt ?? null,
      errorCode: null,
      providers: environment.providers ?? [],
    };
    this.replaceSnapshot({ ...this.state.snapshot, environment: next });
    this.appendEvent("environment.connected", `connection:${timestamp}`, {
      freshness: "live",
      payload: {
        connection: "live",
        serverVersion: environment.serverVersion,
        providerCount: next.providers.length,
      },
    });
  }

  markDisconnected(reason: string): void {
    this.updateEnvironment({
      connection: "offline",
      freshness: "offline",
      errorCode: reason,
    });
    const environment = this.state.snapshot.environment;
    if (environment !== null) {
      this.replaceSnapshot({
        ...this.state.snapshot,
        projects: this.state.snapshot.projects.map((project) => ({
          ...project,
          freshness: "offline",
        })),
        threads: this.state.snapshot.threads.map((thread) => ({
          ...thread,
          freshness: "offline",
        })),
      });
      this.appendEvent("environment.disconnected", `disconnect:${this.nextSequence()}`, {
        freshness: "offline",
        payload: { connection: "offline", reasonCode: reason },
      });
    }
  }

  applyShellItem(item: T3ShellItem): void {
    if (item.kind === "synchronized") {
      this.appendEvent(
        "environment.synchronized",
        `shell-sync:${this.state.snapshot.sourceCursor}`,
        {
          freshness: "live",
          payload: { sourceCursor: this.state.snapshot.sourceCursor },
        },
      );
      return;
    }
    if (item.kind === "snapshot") {
      const managed = new Set(this.state.snapshot.managedThreadIds);
      const timestamp = nowIso();
      const environment =
        this.state.snapshot.environment === null
          ? null
          : { ...this.state.snapshot.environment, lastSnapshotAt: timestamp };
      this.replaceSnapshot({
        ...this.state.snapshot,
        sourceCursor: item.snapshot.snapshotSequence,
        environment,
        projects: item.snapshot.projects.map((project) => normalizeProject(project, "live")),
        threads: item.snapshot.threads.map((thread) => {
          const normalized = normalizeThread(thread, "live", managed.has(thread.id));
          const lineage = this.state.snapshot.threadLineage[thread.id];
          return lineage === undefined ? normalized : { ...normalized, ...lineage };
        }),
      });
      this.appendEvent("shell.snapshot", `shell-snapshot:${item.snapshot.snapshotSequence}`, {
        freshness: "live",
        payload: {
          sourceCursor: item.snapshot.snapshotSequence,
          projectCount: item.snapshot.projects.length,
          threadCount: item.snapshot.threads.length,
        },
      });
      return;
    }

    if (item.sequence <= this.state.snapshot.sourceCursor) return;
    const managed = new Set(this.state.snapshot.managedThreadIds);
    if (item.kind === "project-upserted") {
      const projects = upsert(this.state.snapshot.projects, normalizeProject(item.project, "live"));
      this.replaceSnapshot({ ...this.state.snapshot, sourceCursor: item.sequence, projects });
      this.appendEvent("project.updated", `shell:${item.sequence}`, {
        projectId: item.project.id,
        freshness: "live",
        payload: { title: item.project.title, workspaceRoot: item.project.workspaceRoot },
      });
      return;
    }
    if (item.kind === "project-removed") {
      this.replaceSnapshot({
        ...this.state.snapshot,
        sourceCursor: item.sequence,
        projects: this.state.snapshot.projects.filter((project) => project.id !== item.projectId),
      });
      this.appendEvent("project.removed", `shell:${item.sequence}`, {
        projectId: item.projectId,
        freshness: "live",
        payload: {},
      });
      return;
    }
    if (item.kind === "thread-upserted") {
      const normalized = normalizeThread(item.thread, "live", managed.has(item.thread.id));
      const lineage = this.state.snapshot.threadLineage[item.thread.id];
      const thread = lineage === undefined ? normalized : { ...normalized, ...lineage };
      this.replaceSnapshot({
        ...this.state.snapshot,
        sourceCursor: item.sequence,
        threads: upsert(this.state.snapshot.threads, thread),
      });
      this.appendEvent(`thread.${thread.status}`, `shell:${item.sequence}`, {
        projectId: thread.projectId,
        threadId: thread.id,
        provider: thread.provider,
        freshness: "live",
        payload: {
          status: thread.status,
          attention: thread.attention,
          outcome: thread.outcome,
          managed: thread.managed,
          sourceSequence: item.sequence,
        },
      });
      return;
    }
    this.replaceSnapshot({
      ...this.state.snapshot,
      sourceCursor: item.sequence,
      threads: this.state.snapshot.threads.filter((thread) => thread.id !== item.threadId),
      details: withoutKey(this.state.snapshot.details, item.threadId),
      managedThreadIds: this.state.snapshot.managedThreadIds.filter((id) => id !== item.threadId),
      threadLineage: withoutKey(this.state.snapshot.threadLineage, item.threadId),
    });
    this.appendEvent("thread.removed", `shell:${item.sequence}`, {
      threadId: item.threadId,
      freshness: "live",
      payload: { sourceSequence: item.sequence },
    });
  }

  applyThreadItem(threadId: string, item: T3ThreadItem): void {
    if (item.kind === "synchronized") return;
    const detail =
      item.kind === "snapshot"
        ? normalizeThreadDetail(item.snapshot.snapshotSequence, item.snapshot.thread)
        : applyThreadDetailEvent(threadId, this.state.snapshot.details[threadId], item.event);
    if (detail === null) return;
    const details: Record<string, BridgeThreadDetail> = {
      ...this.state.snapshot.details,
      [threadId]: detail,
    };
    this.replaceSnapshot({ ...this.state.snapshot, details });
    this.appendEvent("thread.detail.updated", `thread:${threadId}:${detail.snapshotSequence}`, {
      threadId,
      freshness: "live",
      payload: {
        sourceSequence: detail.snapshotSequence,
        activityCount: detail.recentActivity.length,
        checkpointCount: detail.checkpointCount,
      },
    });
  }

  adoptThread(threadId: string): boolean {
    if (!this.state.snapshot.threads.some((thread) => thread.id === threadId)) return false;
    this.manageThread(threadId);
    return true;
  }

  manageThread(threadId: string): void {
    if (this.state.snapshot.managedThreadIds.includes(threadId)) return;
    const ids = [...this.state.snapshot.managedThreadIds, threadId];
    this.replaceSnapshot({
      ...this.state.snapshot,
      managedThreadIds: ids,
      threads: this.state.snapshot.threads.map((thread) =>
        thread.id === threadId ? { ...thread, managed: true } : thread,
      ),
    });
  }

  forgetManagedThread(threadId: string): void {
    this.replaceSnapshot({
      ...this.state.snapshot,
      managedThreadIds: this.state.snapshot.managedThreadIds.filter((id) => id !== threadId),
      threads: this.state.snapshot.threads.map((thread) =>
        thread.id === threadId ? { ...thread, managed: false } : thread,
      ),
    });
  }

  isManagedThread(threadId: string): boolean {
    return this.state.snapshot.managedThreadIds.includes(threadId);
  }

  recordThreadLineage(
    threadId: string,
    forkedFromThreadId: string,
    forkMode: "native" | "contextual",
  ): void {
    this.replaceSnapshot({
      ...this.state.snapshot,
      threadLineage: {
        ...this.state.snapshot.threadLineage,
        [threadId]: { forkedFromThreadId, forkMode },
      },
      threads: this.state.snapshot.threads.map((thread) =>
        thread.id === threadId ? { ...thread, forkedFromThreadId, forkMode } : thread,
      ),
    });
  }

  receipt(commandId: string): CommandReceiptRecord | undefined {
    return this.state.commandReceipts.find((record) => record.receipt.commandId === commandId);
  }

  saveReceipt(record: CommandReceiptRecord): void {
    const receipts = [
      record,
      ...this.state.commandReceipts.filter(
        (candidate) => candidate.receipt.commandId !== record.receipt.commandId,
      ),
    ].slice(0, MAX_RECEIPTS);
    this.state = { ...this.state, commandReceipts: receipts };
    this.persist();
  }

  private appendEvent(
    type: string,
    dedupeKey: string,
    fields: {
      readonly projectId?: string;
      readonly threadId?: string;
      readonly provider?: string;
      readonly freshness: BridgeStatusEvent["freshness"];
      readonly payload: Readonly<Record<string, unknown>>;
    },
  ): BridgeStatusEvent | null {
    if (this.state.dedupeKeys.some(([key]) => key === dedupeKey)) return null;
    const environmentId = this.state.snapshot.environment?.id;
    if (environmentId === undefined) return null;
    const sequence = this.nextSequence();
    const event: BridgeStatusEvent = {
      schemaVersion: 1,
      eventId: NodeCrypto.randomUUID(),
      sequence,
      environmentId,
      ...(fields.projectId === undefined ? {} : { projectId: fields.projectId }),
      ...(fields.threadId === undefined ? {} : { threadId: fields.threadId }),
      ...(fields.provider === undefined ? {} : { provider: fields.provider }),
      type,
      occurredAt: nowIso(),
      freshness: fields.freshness,
      source: { system: "t3code", authoritative: true, ownership: "t3code" },
      payload: fields.payload,
    };
    this.state = {
      ...this.state,
      events: [...this.state.events, event].slice(-MAX_EVENTS),
      dedupeKeys: [...this.state.dedupeKeys, [dedupeKey, sequence] as const].slice(-MAX_EVENTS),
    };
    this.persist();
    for (const listener of this.eventListeners) listener(event);
    return event;
  }

  private nextSequence(): number {
    return (this.state.events.at(-1)?.sequence ?? 0) + 1;
  }

  private updateEnvironment(
    fields: Pick<BridgeEnvironment, "connection" | "freshness" | "errorCode">,
  ): void {
    const environment = this.state.snapshot.environment;
    if (environment === null) return;
    this.replaceSnapshot({
      ...this.state.snapshot,
      environment: { ...environment, ...fields },
    });
  }

  private replaceSnapshot(snapshot: BridgeSnapshot): void {
    this.state = { ...this.state, snapshot };
    this.persist();
  }

  private load(): PersistedBridgeState {
    if (this.filePath === null || !NodeFS.existsSync(this.filePath)) return emptyState();
    try {
      const parsed: unknown = JSON.parse(NodeFS.readFileSync(this.filePath, "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "schemaVersion" in parsed &&
        parsed.schemaVersion === 1
      ) {
        return minimizePersistedState(parsed as PersistedBridgeState);
      }
    } catch {
      return emptyState();
    }
    return emptyState();
  }

  private persist(): void {
    if (this.filePath === null) return;
    NodeFS.mkdirSync(NodePath.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.tmp`;
    NodeFS.writeFileSync(tempPath, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
    NodeFS.renameSync(tempPath, this.filePath);
  }
}

const upsert = <T extends { readonly id: string }>(
  values: ReadonlyArray<T>,
  value: T,
): ReadonlyArray<T> => [...values.filter((candidate) => candidate.id !== value.id), value];

const withoutKey = <T>(
  values: Readonly<Record<string, T>>,
  key: string,
): Readonly<Record<string, T>> =>
  Object.fromEntries(Object.entries(values).filter(([candidate]) => candidate !== key));

const normalizeThreadDetail = (
  snapshotSequence: number,
  thread: OrchestrationThread,
): BridgeThreadDetail => {
  return {
    threadId: thread.id,
    snapshotSequence,
    checkpointCount: thread.checkpoints.length,
    // The Bridge observes lifecycle, not conversation history. Even attention
    // subscriptions must never import an existing assistant transcript.
    latestAssistantText: null,
    recentActivity: thread.activities.slice(-20).map((activity) => {
      const requestId = requestIdFromPayload(activity.payload);
      return {
        id: activity.id,
        tone: activity.tone,
        kind: activity.kind,
        summary: minimizedActivitySummary(activity.tone),
        createdAt: activity.createdAt,
        ...(requestId === null ? {} : { requestId }),
      };
    }),
  };
};

const applyThreadDetailEvent = (
  threadId: string,
  current: BridgeThreadDetail | undefined,
  event: Extract<T3ThreadItem, { readonly kind: "event" }>["event"],
): BridgeThreadDetail | null => {
  if (event.type !== "thread.activity-appended" || event.payload.threadId !== threadId) {
    return null;
  }
  if (current !== undefined && event.sequence <= current.snapshotSequence) {
    return null;
  }
  const activity = event.payload.activity;
  const requestId = requestIdFromPayload(activity.payload);
  const normalized = {
    id: activity.id,
    tone: activity.tone,
    kind: activity.kind,
    summary: minimizedActivitySummary(activity.tone),
    createdAt: activity.createdAt,
    ...(requestId === null ? {} : { requestId }),
  };
  return {
    threadId,
    snapshotSequence: event.sequence,
    checkpointCount: current?.checkpointCount ?? 0,
    latestAssistantText: null,
    recentActivity: [
      ...(current?.recentActivity.filter((candidate) => candidate.id !== activity.id) ?? []),
      normalized,
    ].slice(-20),
  };
};

const minimizedActivitySummary = (
  tone: BridgeThreadDetail["recentActivity"][number]["tone"],
): string => {
  switch (tone) {
    case "approval":
      return "T3 Code is waiting for a decision.";
    case "error":
      return "T3 Code reported an error.";
    case "tool":
      return "T3 Code completed a tool step.";
    case "info":
      return "T3 Code updated thread activity.";
  }
};

const minimizePersistedState = (state: PersistedBridgeState): PersistedBridgeState => ({
  ...state,
  snapshot: {
    ...state.snapshot,
    threadLineage: state.snapshot.threadLineage ?? {},
    details: Object.fromEntries(
      Object.entries(state.snapshot.details).map(([threadId, detail]) => [
        threadId,
        {
          ...detail,
          latestAssistantText: null,
          recentActivity: detail.recentActivity.slice(-20).map((activity) => ({
            ...activity,
            summary: minimizedActivitySummary(activity.tone),
          })),
        },
      ]),
    ),
  },
});

const requestIdFromPayload = (payload: unknown): string | null => {
  if (typeof payload !== "object" || payload === null || !("requestId" in payload)) return null;
  const requestId = payload.requestId;
  return typeof requestId === "string" && requestId.length <= 240 ? requestId : null;
};
