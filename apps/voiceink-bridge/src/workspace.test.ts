import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { OrchestrationProjectShell, OrchestrationThreadShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { BridgeCommandService } from "./commands.ts";
import { BridgeStore } from "./store.ts";
import type { T3Client } from "./t3Client.ts";
import { WorkspaceError, WorkspaceService } from "./workspace.ts";

const projectShell = (): OrchestrationProjectShell =>
  ({
    id: "project-1",
    title: "Project",
    workspaceRoot: "/tmp/project",
    repositoryIdentity: null,
    defaultModelSelection: { instanceId: "codex-default", model: "gpt-test" },
    scripts: [],
    createdAt: "2026-07-31T08:00:00Z",
    updatedAt: "2026-07-31T08:00:00Z",
  }) as unknown as OrchestrationProjectShell;

const threadShell = (): OrchestrationThreadShell =>
  ({
    id: "thread-1",
    projectId: "project-1",
    title: "Existing session",
    modelSelection: { instanceId: "codex-default", model: "gpt-test" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-07-31T08:00:00Z",
    updatedAt: "2026-07-31T08:01:00Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  }) as unknown as OrchestrationThreadShell;

const makeStore = (): BridgeStore => {
  const store = new BridgeStore();
  store.markConnected({
    id: "environment-1",
    label: "Local T3",
    serverVersion: "0.0.31",
    providers: [],
  });
  store.applyShellItem({
    kind: "snapshot",
    snapshot: {
      snapshotSequence: 1,
      projects: [projectShell()],
      threads: [threadShell()],
      updatedAt: "2026-07-31T08:00:00Z",
    },
  });
  return store;
};

const fakeT3 = (
  dispatched: unknown[],
  options: { readonly failDispatch?: boolean } = {},
): T3Client =>
  ({
    start: () => {},
    stop: async () => {},
    pair: async () => "token",
    dispatch: async (command: unknown) => {
      if (options.failDispatch === true) throw new Error("provider_unavailable");
      dispatched.push(command);
      return { sequence: dispatched.length };
    },
    connected: () => true,
  }) as unknown as T3Client;

interface Harness {
  readonly service: WorkspaceService;
  readonly store: BridgeStore;
  readonly dispatched: unknown[];
}

const makeService = (
  filePath: string | null = null,
  options: { readonly failDispatch?: boolean } = {},
): Harness => {
  const store = makeStore();
  const dispatched: unknown[] = [];
  const t3 = fakeT3(dispatched, options);
  const commands = new BridgeCommandService(store, t3, { verificationTimeoutMs: 10 });
  return { service: new WorkspaceService(store, commands, filePath), store, dispatched };
};

const readyDraftPatch = {
  draft: {
    goal: "Improve the Morningstar importer",
    targetProjectId: "project-1",
    modelSelection: { instanceId: "codex-default", model: "gpt-test" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    providerPrompt: "Implement importer option B with tests.",
  },
} as const;

describe("Conversation workspace and task draft", () => {
  it("supports multi-turn discussion without creating any T3 task", () => {
    const { service, dispatched } = makeService();
    const created = service.create("workspace-1", "voiceink-client");
    expect(created.state).toBe("exploring");
    let revision = created.revision;
    for (let index = 0; index < 5; index += 1) {
      const patched = service.patch("workspace-1", revision, `operation-${index}`, {
        draft: { background: `Turn ${index} discussion notes` },
        decision: {
          at: "2026-08-03T10:00:00Z",
          source: index % 2 === 0 ? "user" : "insa",
          text: `Decision ${index}`,
        },
      });
      revision = patched.revision;
    }
    const workspace = service.get("workspace-1");
    expect(workspace.draft.draftRevision).toBe(5);
    expect(workspace.draft.decisionLog).toHaveLength(5);
    expect(workspace.linkedExecutions).toHaveLength(0);
    expect(dispatched).toHaveLength(0);
  });

  it("enforces the state machine including cancellation and reopening", () => {
    const { service } = makeService();
    const created = service.create("workspace-2", "client");
    const shaping = service.transition("workspace-2", created.revision, "op-1", "shaping");
    const ready = service.transition("workspace-2", shaping.revision, "op-2", "ready");
    expect(ready.state).toBe("ready");
    expect(() =>
      service.transition("workspace-2", ready.revision, "op-3", "monitoring"),
    ).toThrowError(WorkspaceError);
    const closed = service.transition("workspace-2", ready.revision, "op-4", "closed");
    const reopened = service.transition("workspace-2", closed.revision, "op-5", "exploring");
    expect(reopened.state).toBe("exploring");
  });

  it("rejects stale revisions from conflicting clients without losing either edit", () => {
    const { service } = makeService();
    const created = service.create("workspace-3", "client-a");
    service.patch("workspace-3", created.revision, "client-a-op", {
      draft: { goal: "Client A goal" },
    });
    expect(() =>
      service.patch("workspace-3", created.revision, "client-b-op", {
        draft: { goal: "Client B goal" },
      }),
    ).toThrowError(/stale_revision/);
    expect(service.get("workspace-3").draft.goal).toBe("Client A goal");
  });

  it("replays idempotent operations without reapplying them", () => {
    const { service } = makeService();
    const created = service.create("workspace-4", "client");
    const first = service.patch("workspace-4", created.revision, "op-same", {
      draft: { goal: "Original" },
    });
    const replay = service.patch("workspace-4", first.revision + 99, "op-same", {
      draft: { goal: "Changed" },
    });
    expect(replay.revision).toBe(first.revision);
    expect(replay.draft.goal).toBe("Original");
  });

  it("materializes an approved draft atomically via bootstrap and links the execution", async () => {
    const { service, dispatched } = makeService();
    const created = service.create("workspace-5", "client");
    const patched = service.patch("workspace-5", created.revision, "op-draft", readyDraftPatch);
    const outcome = await service.materialize(
      "workspace-5",
      patched.revision,
      "op-materialize",
      { utterance: "Okay, setz das so um.", draftRevision: patched.draft.draftRevision },
      {
        mode: "create",
        commandId: "command-1",
        threadId: "thread-new",
        messageId: "message-1",
      },
    );
    expect(outcome.result.receipt.status).toBe("accepted");
    expect(outcome.workspace.state).toBe("executing");
    expect(outcome.workspace.linkedExecutions).toHaveLength(1);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "thread.turn.start",
      threadId: "thread-new",
      bootstrap: { createThread: { projectId: "project-1" } },
      titleSeed: "Improve the Morningstar importer",
    });
  });

  it("binds natural authorization to the exact draft revision", async () => {
    const { service } = makeService();
    const created = service.create("workspace-6", "client");
    const patched = service.patch("workspace-6", created.revision, "op-draft", readyDraftPatch);
    // The draft changes after the spoken commitment.
    const changed = service.patch("workspace-6", patched.revision, "op-change", {
      draft: { providerPrompt: "Do something materially different." },
    });
    await expect(
      service.materialize(
        "workspace-6",
        changed.revision,
        "op-materialize",
        { utterance: "Mach das.", draftRevision: patched.draft.draftRevision },
        { mode: "create", commandId: "command-2", threadId: "thread-x", messageId: "message-2" },
      ),
    ).rejects.toThrowError(/authorization_stale/);
  });

  it("prevents duplicate materialization and replays crash-safe", async () => {
    const { service, dispatched } = makeService();
    const created = service.create("workspace-7", "client");
    const patched = service.patch("workspace-7", created.revision, "op-draft", readyDraftPatch);
    const execution = {
      mode: "create",
      commandId: "command-3",
      threadId: "thread-y",
      messageId: "message-3",
    } as const;
    const authorization = {
      utterance: "Leg los.",
      draftRevision: patched.draft.draftRevision,
    };
    const first = await service.materialize(
      "workspace-7",
      patched.revision,
      "op-materialize",
      authorization,
      execution,
    );
    // Same operation replayed after a crash: no second dispatch.
    const replay = await service.materialize(
      "workspace-7",
      first.workspace.revision,
      "op-materialize",
      authorization,
      execution,
    );
    expect(replay.result.receipt.commandId).toBe("command-3");
    expect(dispatched).toHaveLength(1);
    // A different operation for the same draft revision is refused.
    await expect(
      service.materialize("workspace-7", first.workspace.revision, "op-second", authorization, {
        ...execution,
        commandId: "command-4",
      }),
    ).rejects.toThrowError(/already_materialized/);
  });

  it("keeps the draft intact when the first turn fails and consumes nothing", async () => {
    const { service, dispatched } = makeService(null, { failDispatch: true });
    const created = service.create("workspace-8", "client");
    const patched = service.patch("workspace-8", created.revision, "op-draft", readyDraftPatch);
    const outcome = await service.materialize(
      "workspace-8",
      patched.revision,
      "op-materialize",
      { utterance: "Los.", draftRevision: patched.draft.draftRevision },
      { mode: "create", commandId: "command-5", threadId: "thread-z", messageId: "message-5" },
    );
    expect(outcome.result.receipt.status).toBe("rejected");
    expect(outcome.workspace.state).toBe(patched.state);
    expect(outcome.workspace.linkedExecutions).toHaveLength(0);
    expect(dispatched).toHaveLength(0);
    // The unchanged commitment can retry with a fresh command id.
    expect(service.get("workspace-8").draft.draftRevision).toBe(patched.draft.draftRevision);
  });

  it("refuses materialization of an incomplete draft", async () => {
    const { service } = makeService();
    const created = service.create("workspace-9", "client");
    await expect(
      service.materialize(
        "workspace-9",
        created.revision,
        "op-materialize",
        { utterance: "Los.", draftRevision: 0 },
        { mode: "create", commandId: "command-6", threadId: "thread-q", messageId: "message-6" },
      ),
    ).rejects.toThrowError(/draft_incomplete/);
  });

  it("prefers reuse, forks for independence, and creates without context", () => {
    const { service } = makeService();
    const created = service.create("workspace-10", "client");
    const withThread = service.patch("workspace-10", created.revision, "op-thread", {
      activeThreadId: "thread-1",
    });
    expect(service.decideSessionStrategy(withThread)).toBe("reuse");
    expect(service.decideSessionStrategy(withThread, { independentInvestigation: true })).toBe(
      "fork",
    );
    expect(service.decideSessionStrategy(withThread, { cleanSessionRequested: true })).toBe(
      "create",
    );
    const bare = service.create("workspace-11", "client");
    expect(service.decideSessionStrategy(bare)).toBe("create");
  });

  it("is multi-client and restores state including consumed authorizations after restart", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workspace-test-"));
    const filePath = NodePath.join(directory, "workspaces.json");
    try {
      const first = makeService(filePath);
      const created = first.service.create("workspace-12", "voiceink");
      first.service.create("workspace-12", "t3-ui");
      const patched = first.service.patch(
        "workspace-12",
        created.revision + 1,
        "op-draft",
        readyDraftPatch,
      );
      await first.service.materialize(
        "workspace-12",
        patched.revision,
        "op-materialize",
        { utterance: "Setz um.", draftRevision: patched.draft.draftRevision },
        { mode: "create", commandId: "command-7", threadId: "thread-r", messageId: "message-7" },
      );

      // Restart: a fresh service over the same file.
      const second = makeService(filePath);
      const restored = second.service.get("workspace-12");
      expect(restored.clients).toEqual(["voiceink", "t3-ui"]);
      expect(restored.state).toBe("executing");
      expect(restored.linkedExecutions).toHaveLength(1);
      await expect(
        second.service.materialize(
          "workspace-12",
          restored.revision,
          "op-materialize-2",
          { utterance: "Setz um.", draftRevision: restored.draft.draftRevision },
          { mode: "create", commandId: "command-8", threadId: "thread-s", messageId: "message-8" },
        ),
      ).rejects.toThrowError(/already_materialized/);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("emits workspace events on the shared bridge stream", () => {
    const { service, store } = makeService();
    const events: string[] = [];
    const unsubscribe = store.subscribe((event) => events.push(event.type));
    service.create("workspace-13", "client");
    const created = service.get("workspace-13");
    service.patch("workspace-13", created.revision, "op-1", { draft: { goal: "Goal" } });
    unsubscribe();
    expect(events).toContain("workspace.created");
    expect(events).toContain("workspace.updated");
  });
});
