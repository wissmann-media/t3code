import type {
  OrchestrationProjectShell,
  OrchestrationThread,
  OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { BridgeCommandService } from "./commands.ts";
import { ConsultationService } from "./consultation.ts";
import { BridgeStore } from "./store.ts";
import type { T3Client } from "./t3Client.ts";

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

const consultationThreadShell = (threadId: string, status: string): OrchestrationThreadShell =>
  ({
    id: threadId,
    projectId: "project-1",
    title: "Consultation: Frage",
    modelSelection: { instanceId: "codex-default", model: "gpt-test" },
    runtimeMode: "approval-required",
    interactionMode: "plan",
    branch: null,
    worktreePath: null,
    latestTurn:
      status === "completed"
        ? {
            turnId: "turn-1",
            state: "completed",
            requestedAt: "2026-08-03T10:00:00Z",
            startedAt: "2026-08-03T10:00:01Z",
            completedAt: "2026-08-03T10:00:30Z",
            assistantMessageId: null,
          }
        : null,
    createdAt: "2026-08-03T10:00:00Z",
    updatedAt: "2026-08-03T10:00:30Z",
    archivedAt: "2026-08-03T10:00:02Z",
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: "2026-08-03T10:00:00Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: status === "completed",
  }) as unknown as OrchestrationThreadShell;

const makeStore = (options: { readonly planModeSupported?: boolean } = {}): BridgeStore => {
  const store = new BridgeStore();
  store.markConnected({
    id: "environment-1",
    label: "Local T3",
    serverVersion: "0.0.31",
    providers: [
      {
        instanceId: "codex-default",
        driver: "codex",
        enabled: true,
        installed: true,
        state: "ready",
        authStatus: "authenticated",
        ...(options.planModeSupported === false ? { showInteractionModeToggle: false } : {}),
        models: [{ slug: "gpt-test", name: "GPT Test", isDefault: true }],
      },
    ],
  });
  store.applyShellItem({
    kind: "snapshot",
    snapshot: {
      snapshotSequence: 1,
      projects: [projectShell()],
      threads: [],
      updatedAt: "2026-08-03T10:00:00Z",
    },
  });
  return store;
};

const consultationDetail = (threadId: string): OrchestrationThread =>
  ({
    ...consultationThreadShell(threadId, "completed"),
    deletedAt: null,
    messages: [
      {
        id: "message-answer",
        role: "assistant",
        text: "Analyse: Option B ist tragfähig, weil …",
        turnId: "turn-1",
        streaming: false,
        createdAt: "2026-08-03T10:00:30Z",
        updatedAt: "2026-08-03T10:00:30Z",
      },
    ],
    proposedPlans: [
      {
        id: "plan-consult",
        turnId: "turn-1",
        planMarkdown: "# Analyse\nOption B, weil …",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: "2026-08-03T10:00:30Z",
        updatedAt: "2026-08-03T10:00:30Z",
      },
    ],
    activities: [],
    checkpoints: [],
    session: null,
  }) as unknown as OrchestrationThread;

interface Harness {
  readonly service: ConsultationService;
  readonly store: BridgeStore;
  readonly dispatched: unknown[];
  readonly retained: string[];
}

const makeService = (
  options: { readonly planModeSupported?: boolean; readonly failDispatch?: boolean } = {},
): Harness => {
  const store = makeStore(options);
  const dispatched: unknown[] = [];
  const retained: string[] = [];
  const t3 = {
    start: () => {},
    stop: async () => {},
    pair: async () => "token",
    dispatch: async (command: unknown) => {
      if (options.failDispatch === true) throw new Error("provider_unavailable");
      dispatched.push(command);
      return { sequence: dispatched.length };
    },
    threadDetail: async (threadId: string) => consultationDetail(threadId),
    retainThread: (threadId: string) => retained.push(threadId),
    releaseThread: (threadId: string) => {
      const index = retained.indexOf(threadId);
      if (index >= 0) retained.splice(index, 1);
    },
    retainedThreadIds: () => retained,
    connected: () => true,
  } as unknown as T3Client;
  const commands = new BridgeCommandService(store, t3, { verificationTimeoutMs: 10 });
  return { service: new ConsultationService(store, commands, t3), store, dispatched, retained };
};

const waitFor = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
  let waited = 0;
  while (!predicate()) {
    if (waited > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
    waited += 10;
  }
};

describe("ConsultationRun", () => {
  it("starts hidden, plan-mode, retained, and never as a visible task", async () => {
    const { service, dispatched, retained } = makeService();
    const run = await service.start({
      consultationId: "consult-1",
      projectId: "project-1",
      question: "Wie riskant ist die Elasticsearch-Migration?",
    });
    expect(run.status).toBe("running");
    expect(run.threadId).toBe("consultation-consult-1");
    expect(dispatched[0]).toMatchObject({
      type: "thread.turn.start",
      interactionMode: "plan",
      bootstrap: { createThread: { projectId: "project-1", interactionMode: "plan" } },
    });
    const prompt = (dispatched[0] as { message: { text: string } }).message.text;
    expect(prompt).toContain("read-only consultation");
    expect(prompt).toContain("Wie riskant ist die Elasticsearch-Migration?");
    expect(retained).toContain("consultation-consult-1");
  });

  it("deduplicates retries on the same consultation id", async () => {
    const { service, dispatched } = makeService();
    await service.start({
      consultationId: "consult-2",
      projectId: "project-1",
      question: "Frage",
    });
    const before = dispatched.length;
    const replay = await service.start({
      consultationId: "consult-2",
      projectId: "project-1",
      question: "Frage",
    });
    expect(replay.consultationId).toBe("consult-2");
    expect(dispatched.length).toBe(before);
  });

  it("fails closed when the provider cannot guarantee non-mutation", async () => {
    const { service } = makeService({ planModeSupported: false });
    await expect(
      service.start({
        consultationId: "consult-3",
        projectId: "project-1",
        question: "Frage",
      }),
    ).rejects.toThrowError(/provider_cannot_guarantee_non_mutation/);
  });

  it("completes from the provider result with plan evidence and stable references", async () => {
    const { service, store, retained } = makeService();
    const run = await service.start({
      consultationId: "consult-4",
      projectId: "project-1",
      question: "Frage",
    });
    store.applyShellItem({
      kind: "thread-upserted",
      sequence: 10,
      thread: consultationThreadShell(run.threadId, "completed"),
    });
    await waitFor(() => service.get("consult-4").status === "completed");
    const finished = service.get("consult-4");
    expect(finished.answer).toContain("Option B");
    expect(finished.evidence.map((item) => item.kind)).toEqual(["plan", "message"]);
    expect(finished.evidence[0]).toMatchObject({
      threadId: run.threadId,
      itemId: "plan-consult",
    });
    expect(retained).not.toContain(run.threadId);
  });

  it("cancels a running consultation and suppresses the late result", async () => {
    const { service, store } = makeService();
    const run = await service.start({
      consultationId: "consult-5",
      projectId: "project-1",
      question: "Frage",
    });
    const cancelled = await service.cancel("consult-5");
    expect(cancelled.status).toBe("cancelled");
    // A late completion event must not resurrect the run.
    store.applyShellItem({
      kind: "thread-upserted",
      sequence: 11,
      thread: consultationThreadShell(run.threadId, "completed"),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(service.get("consult-5").status).toBe("cancelled");
  });

  it("times out and reports the real failure instead of waiting forever", async () => {
    const { service } = makeService();
    await service.start({
      consultationId: "consult-6",
      projectId: "project-1",
      question: "Frage",
      timeoutMs: 1_000,
    });
    // The service clamps to the provided timeout; simulate expiry quickly by
    // waiting slightly longer than the minimum allowed in tests.
    await waitFor(() => service.get("consult-6").status === "timed-out", 2_000);
    expect(service.get("consult-6").failureReason).toBe("timeout");
  });

  it("derives project and model from a source thread for contextual consultation", async () => {
    const { service, store, dispatched } = makeService();
    store.applyShellItem({
      kind: "thread-upserted",
      sequence: 12,
      thread: {
        ...consultationThreadShell("thread-source", "idle"),
        archivedAt: null,
        title: "Bestehende Diskussion",
      } as unknown as OrchestrationThreadShell,
    });
    await service.start({
      consultationId: "consult-7",
      sourceThreadId: "thread-source",
      question: "Wie hängt das mit der bestehenden Diskussion zusammen?",
    });
    expect(dispatched.at(-1)).toMatchObject({
      type: "thread.turn.start",
      bootstrap: { createThread: { projectId: "project-1" } },
    });
    const prompt = (dispatched.at(-1) as { message: { text: string } }).message.text;
    expect(prompt).toContain("thread-source");
  });
});
