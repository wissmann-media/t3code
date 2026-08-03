import type { OrchestrationThread, OrchestrationThreadShell } from "@t3tools/contracts";
import { EventId, MessageId, ThreadId } from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { BridgeCommandError, BridgeCommandService } from "./commands.ts";
import { normalizeThread, normalizeThreadOutput } from "./normalization.ts";
import { BridgePairingSession } from "./server.ts";
import { BridgeStore, resumableShellCursor } from "./store.ts";
import type { T3Client } from "./t3Client.ts";

const threadShell = (
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id: "thread-1" as OrchestrationThreadShell["id"],
  projectId: "project-1" as OrchestrationThreadShell["projectId"],
  title: "Bridge work",
  modelSelection: {
    instanceId: "codex-default" as OrchestrationThreadShell["modelSelection"]["instanceId"],
    model: "gpt-test",
  },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: "feature/bridge",
  worktreePath: "/tmp/bridge",
  latestTurn: null,
  createdAt: "2026-07-30T12:00:00Z",
  updatedAt: "2026-07-30T12:00:00Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

describe("thread normalization", () => {
  it("prioritizes approvals over a running session", () => {
    const thread = normalizeThread(
      threadShell({
        hasPendingApprovals: true,
        session: {
          threadId: "thread-1" as OrchestrationThreadShell["id"],
          status: "running",
          providerName: "Codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-07-30T12:00:00Z",
        },
      }),
      "live",
      true,
    );
    expect(thread.status).toBe("waiting_for_approval");
    expect(thread.attention).toBe("approval");
    expect(thread.ownership).toBe("t3code");
    expect(thread.managed).toBe(true);
  });

  it("does not invent completion when a session disappears", () => {
    const thread = normalizeThread(threadShell(), "offline", false);
    expect(thread.status).toBe("idle");
    expect(thread.outcome).toBe("unknown");
    expect(thread.freshness).toBe("offline");
  });
});

describe("bounded thread output", () => {
  it("returns only the latest assistant message and redacts secrets", () => {
    const thread = {
      ...threadShell(),
      deletedAt: null,
      messages: [
        {
          id: MessageId.make("message-user"),
          role: "user",
          text: "Keep this prompt private",
          turnId: null,
          streaming: false,
          createdAt: "2026-07-30T12:00:00Z",
          updatedAt: "2026-07-30T12:00:00Z",
        },
        {
          id: MessageId.make("message-assistant"),
          role: "assistant",
          text: "Finished safely. api_key=secret-value-that-must-not-leak",
          turnId: null,
          streaming: false,
          createdAt: "2026-07-30T12:01:00Z",
          updatedAt: "2026-07-30T12:01:00Z",
        },
      ],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    } as OrchestrationThread;

    const output = normalizeThreadOutput(thread);

    expect(output.assistantText).toBe("Finished safely. [REDACTED]");
    expect(output.assistantText).not.toContain("prompt");
    expect(output.ownership).toBe("t3code");
    expect(output.freshness).toBe("live");
  });

  it("bounds assistant output to four thousand characters", () => {
    const thread = {
      ...threadShell(),
      deletedAt: null,
      messages: [
        {
          id: MessageId.make("message-assistant"),
          role: "assistant",
          text: "x".repeat(5_000),
          turnId: null,
          streaming: false,
          createdAt: "2026-07-30T12:01:00Z",
          updatedAt: "2026-07-30T12:01:00Z",
        },
      ],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    } as OrchestrationThread;

    const output = normalizeThreadOutput(thread);

    expect(output.truncated).toBe(true);
    expect(output.assistantText?.length).toBe(4_001);
  });
});

describe("BridgeStore", () => {
  it("replaces stale provider models when T3 publishes a refreshed catalog", () => {
    const store = new BridgeStore();
    store.markConnected({
      id: "environment-1",
      label: "Local T3",
      serverVersion: "0.0.31",
      providers: [
        {
          instanceId: "opencode",
          driver: "opencode",
          enabled: true,
          installed: true,
          state: "ready",
          authStatus: "authenticated",
          models: [
            {
              slug: "openrouter/aion-labs/aion-1.0",
              name: "Aion 1.0",
              isDefault: true,
            },
          ],
        },
      ],
    });

    store.updateProviders([
      {
        instanceId: "opencode",
        driver: "opencode",
        enabled: true,
        installed: true,
        state: "ready",
        authStatus: "authenticated",
        models: [
          {
            slug: "openrouter/aion-labs/aion-2.0",
            name: "Aion 2.0",
            isDefault: true,
          },
        ],
      },
    ]);

    expect(store.snapshot().environment?.providers[0]?.models).toEqual([
      {
        slug: "openrouter/aion-labs/aion-2.0",
        name: "Aion 2.0",
        isDefault: true,
      },
    ]);
  });

  it("deduplicates replayed shell events by source sequence", () => {
    const store = new BridgeStore();
    store.markConnected({ id: "environment-1", label: "Local T3", serverVersion: "0.0.31" });
    store.applyShellItem({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 10,
        projects: [],
        threads: [threadShell()],
        updatedAt: "2026-07-30T12:00:00Z",
      },
    });
    store.applyShellItem({ kind: "thread-upserted", sequence: 11, thread: threadShell() });
    const count = store.eventsAfter(0).length;
    store.applyShellItem({ kind: "thread-upserted", sequence: 11, thread: threadShell() });
    expect(store.eventsAfter(0)).toHaveLength(count);
    expect(store.snapshot().sourceCursor).toBe(11);
  });

  it("marks every projection offline without declaring completion", () => {
    const store = new BridgeStore();
    store.markConnected({ id: "environment-1", label: "Local T3", serverVersion: "0.0.31" });
    store.applyShellItem({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 10,
        projects: [],
        threads: [threadShell({ session: null })],
        updatedAt: "2026-07-30T12:00:00Z",
      },
    });
    store.markDisconnected("transport");
    expect(store.snapshot().environment?.connection).toBe("offline");
    expect(store.snapshot().threads[0]?.freshness).toBe("offline");
    expect(store.snapshot().threads[0]?.outcome).toBe("unknown");
  });

  it("forces a full shell snapshot after reconnecting persisted offline data", () => {
    const store = new BridgeStore();
    store.markConnected({ id: "environment-1", label: "Local T3", serverVersion: "0.0.31" });
    store.applyShellItem({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 10,
        projects: [],
        threads: [threadShell()],
        updatedAt: "2026-07-30T12:00:00Z",
      },
    });

    expect(resumableShellCursor(store.snapshot())).toBe(10);
    expect(
      resumableShellCursor({
        ...store.snapshot(),
        projects: [
          {
            id: "project-1",
            title: "Project",
            workspaceRoot: "/tmp/project",
            defaultProvider: "codex",
            updatedAt: "2026-07-30T12:00:00Z",
            freshness: "offline",
          },
        ],
      }),
    ).toBe(0);

    store.markDisconnected("transport");
    store.markConnected({ id: "environment-1", label: "Local T3", serverVersion: "0.0.31" });

    expect(store.snapshot().environment?.freshness).toBe("live");
    expect(store.snapshot().threads[0]?.freshness).toBe("offline");
    expect(resumableShellCursor(store.snapshot())).toBe(0);

    store.applyShellItem({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 10,
        projects: [],
        threads: [threadShell()],
        updatedAt: "2026-07-30T12:00:01Z",
      },
    });

    expect(store.snapshot().threads[0]?.freshness).toBe("live");
    expect(resumableShellCursor(store.snapshot())).toBe(10);
  });

  it("never imports transcript text and scrubs persisted detail on restart", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "voiceink-bridge-"));
    const file = NodePath.join(directory, "state.json");
    try {
      const store = new BridgeStore(file);
      store.markConnected({ id: "environment-1", label: "Local T3", serverVersion: "0.0.31" });
      store.applyThreadItem("thread-1", {
        kind: "snapshot",
        snapshot: {
          snapshotSequence: 1,
          thread: {
            id: "thread-1",
            projectId: "project-1",
            messages: [{ role: "assistant", text: "private transcript sentinel" }],
            activities: [
              {
                id: "activity-1",
                tone: "approval",
                kind: "permission",
                summary: "private command sentinel",
                createdAt: "2026-07-30T12:00:00Z",
                payload: { requestId: "approval-1" },
              },
            ],
            checkpoints: [],
          } as unknown as OrchestrationThread,
        },
      });

      const reopened = new BridgeStore(file);
      const detail = reopened.snapshot().details["thread-1"];
      expect(detail?.latestAssistantText).toBeNull();
      expect(detail?.recentActivity[0]?.summary).toBe("T3 Code is waiting for a decision.");
      expect(JSON.stringify(reopened.snapshot())).not.toContain("private transcript sentinel");
      expect(JSON.stringify(reopened.snapshot())).not.toContain("private command sentinel");
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("projects incremental approval activities without transcript content", () => {
    const store = liveStore();
    store.applyThreadItem("thread-1", {
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 10,
        thread: {
          id: "thread-1",
          projectId: "project-1",
          messages: [],
          activities: [],
          checkpoints: [],
        } as unknown as OrchestrationThread,
      },
    });
    store.applyThreadItem("thread-1", {
      kind: "event",
      event: {
        sequence: 11,
        eventId: EventId.make("event-approval"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: "2026-07-30T12:00:01Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.activity-appended",
        payload: {
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-approval"),
            tone: "approval",
            kind: "approval.requested",
            summary: "private approval detail",
            payload: { requestId: "approval-1", command: "private command" },
            turnId: null,
            createdAt: "2026-07-30T12:00:01Z",
          },
        },
      },
    });

    expect(store.snapshot().details["thread-1"]?.recentActivity).toEqual([
      {
        id: "activity-approval",
        tone: "approval",
        kind: "approval.requested",
        summary: "T3 Code is waiting for a decision.",
        createdAt: "2026-07-30T12:00:01Z",
        requestId: "approval-1",
      },
    ]);
    expect(JSON.stringify(store.snapshot())).not.toContain("private command");
    expect(JSON.stringify(store.snapshot())).not.toContain("private approval detail");
  });

  it("projects safe structured user-input questions for the voice bridge", () => {
    const store = liveStore();
    store.applyThreadItem("thread-1", {
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 20,
        thread: {
          id: "thread-1",
          projectId: "project-1",
          messages: [],
          checkpoints: [],
          activities: [
            {
              id: "activity-input",
              tone: "info",
              kind: "user-input.requested",
              summary: "User input requested",
              createdAt: "2026-07-30T12:00:02Z",
              payload: {
                requestId: "input-1",
                questions: [
                  {
                    id: "scope",
                    header: "Prüfumfang",
                    question: "Soll die gesamte Folgekette einbezogen werden?",
                    options: [
                      { label: "End-to-End", description: "Alles prüfen." },
                      { label: "Nur XML-Pipeline", description: "Nur XML prüfen." },
                    ],
                    multiSelect: false,
                  },
                ],
                secret: "must not cross the bridge",
              },
            },
          ],
        } as unknown as OrchestrationThread,
      },
    });

    expect(store.snapshot().details["thread-1"]?.recentActivity[0]?.request).toEqual({
      kind: "user-input",
      requestId: "input-1",
      questions: [
        {
          id: "scope",
          header: "Prüfumfang",
          question: "Soll die gesamte Folgekette einbezogen werden?",
          options: [
            { label: "End-to-End", description: "Alles prüfen." },
            { label: "Nur XML-Pipeline", description: "Nur XML prüfen." },
          ],
          multiSelect: false,
        },
      ],
    });
    expect(JSON.stringify(store.snapshot())).not.toContain("must not cross the bridge");
  });
});

describe("BridgeCommandService", () => {
  it("reuses a matching idempotent receipt and rejects a changed command", async () => {
    const store = liveStore();
    const dispatched: unknown[] = [];
    const t3 = fakeT3(dispatched);
    const service = new BridgeCommandService(store, t3);
    const request = {
      commandId: "command-1",
      projectId: "project-new",
      title: "New",
      workspaceRoot: "/tmp/new",
    };
    const first = await service.createProject(request);
    const second = await service.createProject(request);
    expect(second).toEqual(first);
    expect(dispatched).toHaveLength(1);
    await expect(
      service.createProject({ ...request, workspaceRoot: "/tmp/changed" }),
    ).rejects.toMatchObject({ code: "command_conflict" });
  });

  it("fails closed for an unmanaged thread", async () => {
    const store = liveStore();
    const service = new BridgeCommandService(store, fakeT3([]));
    await expect(service.interrupt("unmanaged", { commandId: "command-2" })).rejects.toBeInstanceOf(
      BridgeCommandError,
    );
  });

  it("normalizes omitted optional thread paths to null for T3", async () => {
    const store = liveStore();
    const dispatched: unknown[] = [];
    const service = new BridgeCommandService(store, fakeT3(dispatched));

    await service.createThread({
      commandId: "command-thread",
      threadId: "thread-new",
      projectId: "project-new",
      title: "New thread",
      modelSelection: { instanceId: "codex", model: "gpt-test" },
      runtimeMode: "approval-required",
      interactionMode: "default",
    });

    expect(dispatched[0]).toMatchObject({
      type: "thread.create",
      branch: null,
      worktreePath: null,
    });
  });
});

describe("BridgePairingSession", () => {
  it("is action-bound, expiring, and single-use", () => {
    const session = new BridgePairingSession("secret-token");
    expect(session.exchange("00000000")).toBeNull();
    expect(session.exchange(session.code)).toBe("secret-token");
    expect(session.exchange(session.code)).toBeNull();
  });
});

const liveStore = (): BridgeStore => {
  const store = new BridgeStore();
  store.markConnected({ id: "environment-1", label: "Local T3", serverVersion: "0.0.31" });
  store.applyShellItem({
    kind: "snapshot",
    snapshot: {
      snapshotSequence: 1,
      projects: [],
      threads: [],
      updatedAt: "2026-07-30T12:00:00Z",
    },
  });
  return store;
};

const fakeT3 = (dispatched: unknown[]): T3Client => ({
  start: () => {},
  stop: async () => {},
  pair: async () => "token",
  dispatch: async (command) => {
    dispatched.push(command);
    return { sequence: dispatched.length };
  },
  fullThreadDiff: async () => ({ diff: "", fromTurnCount: 0, toTurnCount: 0 }),
  threadOutput: async () => ({
    threadId: "thread-1",
    projectId: "project-1",
    assistantText: null,
    createdAt: null,
    truncated: false,
    freshness: "live",
    ownership: "t3code",
  }),
  refreshThread: async () => {},
  connected: () => true,
});
