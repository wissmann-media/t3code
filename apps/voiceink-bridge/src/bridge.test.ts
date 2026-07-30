import type { OrchestrationThread, OrchestrationThreadShell } from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { BridgeCommandError, BridgeCommandService } from "./commands.ts";
import { normalizeThread } from "./normalization.ts";
import { BridgePairingSession } from "./server.ts";
import { BridgeStore } from "./store.ts";
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

describe("BridgeStore", () => {
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
  connected: () => true,
});
