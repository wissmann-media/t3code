import type {
  OrchestrationProjectShell,
  OrchestrationThread,
  OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { BridgeCommandService } from "./commands.ts";
import { BridgePairingSession, createBridgeServer } from "./server.ts";
import { BridgeStore } from "./store.ts";
import type { T3Client } from "./t3Client.ts";

const bearerToken = "test-bearer-token";

describe("Bridge HTTP routes", () => {
  it("authenticates v2 and advertises universal thread capabilities", async () => {
    await withServer(async ({ baseUrl }) => {
      const unauthorized = await fetch(`${baseUrl}/v2/capabilities`);
      expect(unauthorized.status).toBe(401);

      const response = await authorizedFetch(`${baseUrl}/v2/capabilities`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        apiVersion: number;
        bridgeVersion: string;
        capabilities: string[];
        requiresProjectForThread: boolean;
        forkModes: string[];
      };
      expect(body.apiVersion).toBe(2);
      expect(body.bridgeVersion).toBe("0.2.0");
      expect(body.capabilities).toContain("thread.turn.start");
      expect(body.capabilities).toContain("thread.fork.contextual");
      expect(body.capabilities).not.toContain("thread.adopt");
      expect(body.requiresProjectForThread).toBe(true);
      expect(body.forkModes).toEqual(["contextual"]);
    });
  });

  it("lists and filters complete v2 thread references without managed state", async () => {
    await withServer(async ({ baseUrl }) => {
      const response = await authorizedFetch(
        `${baseUrl}/v2/threads?projectId=project-1&provider=codex&status=completed`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { threads: Array<Record<string, unknown>> };
      expect(body.threads).toHaveLength(1);
      expect(body.threads[0]).toMatchObject({
        id: "thread-1",
        projectId: "project-1",
        provider: "codex",
        providerInstanceId: "codex-default",
        model: "gpt-test",
        status: "completed",
      });
      expect(body.threads[0]).not.toHaveProperty("managed");
      expect(body.threads[0]?.capabilities).toContain("turn");
    });
  });

  it("paginates large thread catalogs deterministically with full IDs", async () => {
    await withServer(async ({ baseUrl, store }) => {
      const base = threadShell();
      const threads = Array.from({ length: 205 }, (_, index) => ({
        ...base,
        id: `thread-${String(index).padStart(3, "0")}` as OrchestrationThreadShell["id"],
        title: index % 2 === 0 ? "Duplicate title" : `Session ${index}`,
        updatedAt: `2026-07-31T08:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(
          index % 60,
        ).padStart(2, "0")}Z`,
      }));
      store.applyShellItem({
        kind: "snapshot",
        snapshot: {
          snapshotSequence: 2,
          projects: [projectShell()],
          threads,
          updatedAt: "2026-07-31T09:00:00Z",
        },
      });

      const firstResponse = await authorizedFetch(`${baseUrl}/v2/threads?limit=100`);
      const first = (await firstResponse.json()) as {
        threads: Array<{ id: string }>;
        nextCursor: string | null;
      };
      expect(first.threads).toHaveLength(100);
      expect(first.nextCursor).toBe("100");
      expect(new Set(first.threads.map((thread) => thread.id)).size).toBe(100);

      const finalResponse = await authorizedFetch(`${baseUrl}/v2/threads?limit=100&cursor=200`);
      const finalPage = (await finalResponse.json()) as {
        threads: Array<{ id: string }>;
        nextCursor: string | null;
      };
      expect(finalPage.threads).toHaveLength(5);
      expect(finalPage.nextCursor).toBeNull();

      const invalid = await authorizedFetch(`${baseUrl}/v2/threads?limit=201`);
      expect(invalid.status).toBe(400);
    });
  });

  it("keeps v1 managed gating but prepares any live T3 thread transparently in v2", async () => {
    await withServer(async ({ baseUrl, dispatched, store }) => {
      const request = {
        commandId: "turn-command",
        messageId: "message-1",
        text: "Continue the analysis.",
        runtimeMode: "full-access",
        interactionMode: "default",
      };
      const legacy = await authorizedFetch(`${baseUrl}/v1/threads/thread-1/turns`, {
        method: "POST",
        body: JSON.stringify(request),
      });
      expect(legacy.status).toBe(409);

      const response = await authorizedFetch(`${baseUrl}/v2/threads/thread-1/turns`, {
        method: "POST",
        body: JSON.stringify(request),
      });
      expect(response.status).toBe(202);
      expect(store.isManagedThread("thread-1")).toBe(true);
      expect(dispatched).toHaveLength(2);
      expect(dispatched[0]).toMatchObject({
        type: "thread.runtime-mode.set",
        threadId: "thread-1",
        runtimeMode: "full-access",
      });
      expect(dispatched[1]).toMatchObject({
        type: "thread.turn.start",
        threadId: "thread-1",
      });
    });
  });

  it("returns thread activity and rejects unknown thread targets", async () => {
    await withServer(async ({ baseUrl }) => {
      const activity = await authorizedFetch(`${baseUrl}/v2/threads/thread-1/activity`);
      expect(activity.status).toBe(200);
      expect(await activity.json()).toMatchObject({
        threadId: "thread-1",
        projectId: "project-1",
        activity: [],
      });

      const missing = await authorizedFetch(`${baseUrl}/v2/threads/missing/turns`, {
        method: "POST",
        body: JSON.stringify({
          commandId: "missing-command",
          messageId: "message-missing",
          text: "Do not run.",
          runtimeMode: "approval-required",
          interactionMode: "default",
        }),
      });
      expect(missing.status).toBe(404);
    });
  });

  it("serves the complete v2 project and thread read surface", async () => {
    await withServer(async ({ baseUrl }) => {
      const projects = await authorizedFetch(`${baseUrl}/v2/projects`);
      expect(projects.status).toBe(200);
      expect(await projects.json()).toMatchObject({
        projects: [{ id: "project-1", title: "Project" }],
      });

      const project = await authorizedFetch(`${baseUrl}/v2/projects/project-1`);
      expect(project.status).toBe(200);
      expect(await project.json()).toMatchObject({ project: { id: "project-1" } });

      const thread = await authorizedFetch(`${baseUrl}/v2/threads/thread-1`);
      expect(thread.status).toBe(200);
      expect(await thread.json()).toMatchObject({ thread: { id: "thread-1" } });

      const output = await authorizedFetch(`${baseUrl}/v2/threads/thread-1/output`);
      expect(output.status).toBe(200);
      expect(await output.json()).toMatchObject({
        output: { threadId: "thread-1", ownership: "t3code" },
      });

      const diff = await authorizedFetch(`${baseUrl}/v2/threads/thread-1/diff`);
      expect(diff.status).toBe(200);
      expect(await diff.json()).toMatchObject({
        threadId: "thread-1",
        fromTurnCount: 0,
        toTurnCount: 0,
      });
    });
  });

  it("refreshes inactive thread detail from T3 before activity and diff reads", async () => {
    await withServer(async ({ baseUrl, store }) => {
      const inactive = {
        ...threadShell(),
        id: "thread-inactive" as OrchestrationThreadShell["id"],
        latestTurn: null,
        updatedAt: "2026-07-31T07:00:00Z",
      };
      store.applyShellItem({
        kind: "snapshot",
        snapshot: {
          snapshotSequence: 3,
          projects: [projectShell()],
          threads: [inactive],
          updatedAt: "2026-07-31T09:00:00Z",
        },
      });
      expect(store.snapshot().details["thread-inactive"]).toBeUndefined();

      const activity = await authorizedFetch(`${baseUrl}/v2/threads/thread-inactive/activity`);
      expect(activity.status).toBe(200);
      expect(await activity.json()).toMatchObject({
        threadId: "thread-inactive",
        projectId: "project-1",
      });
      expect(store.snapshot().details["thread-inactive"]).toBeDefined();

      const diff = await authorizedFetch(`${baseUrl}/v2/threads/thread-inactive/diff`);
      expect(diff.status).toBe(200);
      expect(await diff.json()).toMatchObject({
        threadId: "thread-inactive",
        fromTurnCount: 0,
        toTurnCount: 0,
      });
    });
  });

  it("routes every v2 mutation without a public adopt step", async () => {
    await withServer(async ({ baseUrl, dispatched }) => {
      const requests: Array<[string, unknown]> = [
        [
          "/v2/projects",
          {
            commandId: "create-project",
            projectId: "project-new",
            title: "New project",
            workspaceRoot: "/tmp/new-project",
            createWorkspaceRootIfMissing: true,
            defaultModelSelection: null,
          },
        ],
        [
          "/v2/threads",
          {
            commandId: "create-thread",
            threadId: "thread-new",
            projectId: "project-1",
            title: "New thread",
            modelSelection: {
              instanceId: "codex-default",
              model: "gpt-test",
              options: [{ id: "reasoningEffort", value: "xhigh" }],
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          },
        ],
        ["/v2/threads/thread-1/interrupt", { commandId: "interrupt-thread" }],
        ["/v2/threads/thread-1/stop", { commandId: "stop-thread" }],
        [
          "/v2/approvals/request-1/respond",
          {
            commandId: "approval-response",
            threadId: "thread-1",
            decision: "accept",
          },
        ],
        [
          "/v2/user-input/request-2/respond",
          {
            commandId: "input-response",
            threadId: "thread-1",
            answers: { answer: "Proceed conservatively." },
          },
        ],
      ];
      for (const [path, body] of requests) {
        const response = await authorizedFetch(`${baseUrl}${path}`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        expect(response.status, path).toBe(202);
      }
      expect(dispatched.map((value) => (value as { type: string }).type)).toEqual([
        "project.create",
        "thread.create",
        "thread.turn.interrupt",
        "thread.session.stop",
        "thread.approval.respond",
        "thread.user-input.respond",
      ]);
      expect(dispatched[1]).toMatchObject({
        type: "thread.create",
        modelSelection: {
          instanceId: "codex-default",
          model: "gpt-test",
          options: [{ id: "reasoningEffort", value: "xhigh" }],
        },
      });
    });
  });

  it("returns a contract error instead of 500 for invalid model options", async () => {
    await withServer(async ({ baseUrl, dispatched }) => {
      const response = await authorizedFetch(`${baseUrl}/v2/threads`, {
        method: "POST",
        body: JSON.stringify({
          commandId: "invalid-options",
          threadId: "thread-invalid",
          projectId: "project-1",
          title: "Invalid options",
          modelSelection: {
            instanceId: "codex-default",
            model: "gpt-test",
            options: [{ id: "reasoningEffort", value: 42 }],
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
        }),
      });

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: "invalid_request" });
      expect(dispatched).toHaveLength(0);
    });
  });

  it("resumes v2 SSE events after the supplied cursor", async () => {
    await withServer(async ({ baseUrl }) => {
      const controller = new AbortController();
      const response = await authorizedFetch(`${baseUrl}/v2/events?after=0`, {
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const first = await reader!.read();
      const text = new TextDecoder().decode(first.value);
      expect(text).toContain("voiceink-t3-bridge");
      controller.abort();

      const invalid = await authorizedFetch(`${baseUrl}/v2/events?after=invalid`);
      expect(invalid.status).toBe(400);
    });
  });

  it("creates a contextual fork with explicit lineage", async () => {
    await withServer(async ({ baseUrl, dispatched, store }) => {
      const response = await authorizedFetch(`${baseUrl}/v2/threads/thread-1/forks`, {
        method: "POST",
        body: JSON.stringify({
          commandId: "fork-command",
          threadId: "thread-fork",
          messageId: "message-fork",
          title: "Independent review",
          text: "Review the recommendation independently.",
        }),
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        externalId: "thread-fork",
        sourceThreadId: "thread-1",
        forkMode: "contextual",
      });
      expect(dispatched).toHaveLength(2);
      expect(dispatched[0]).toMatchObject({
        type: "thread.create",
        threadId: "thread-fork",
        projectId: "project-1",
      });
      expect(dispatched[1]).toMatchObject({
        type: "thread.turn.start",
        threadId: "thread-fork",
      });
      expect(store.snapshot().threadLineage["thread-fork"]).toEqual({
        forkedFromThreadId: "thread-1",
        forkMode: "contextual",
      });
    });
  });

  it("validates media type and request size before mutation dispatch", async () => {
    await withServer(async ({ baseUrl, dispatched }) => {
      const wrongType = await fetch(`${baseUrl}/v2/projects`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearerToken}`, "Content-Type": "text/plain" },
        body: "{}",
      });
      expect(wrongType.status).toBe(415);

      const tooLarge = await authorizedFetch(`${baseUrl}/v2/projects`, {
        method: "POST",
        body: JSON.stringify({ padding: "x".repeat(257 * 1024) }),
      });
      expect(tooLarge.status).toBe(413);
      expect(dispatched).toHaveLength(0);
    });
  });
});

const withServer = async (
  test: (context: { baseUrl: string; store: BridgeStore; dispatched: unknown[] }) => Promise<void>,
): Promise<void> => {
  const store = liveStore();
  const dispatched: unknown[] = [];
  const t3 = fakeT3(dispatched, store);
  const server = createBridgeServer({
    store,
    commands: new BridgeCommandService(store, t3),
    t3,
    bearerToken,
    pairing: new BridgePairingSession(bearerToken),
  });
  const port = await server.listen(0);
  try {
    await test({ baseUrl: `http://127.0.0.1:${port}`, store, dispatched });
  } finally {
    await server.close();
  }
};

const authorizedFetch = (input: string, init: RequestInit = {}): Promise<Response> =>
  fetch(input, {
    ...init,
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });

const liveStore = (): BridgeStore => {
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
        models: [{ slug: "gpt-test", name: "GPT Test", isDefault: true }],
      },
    ],
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
  store.applyThreadItem("thread-1", {
    kind: "snapshot",
    snapshot: {
      snapshotSequence: 1,
      thread: {
        ...threadShell(),
        activities: [],
        checkpoints: [],
      } as unknown as OrchestrationThread,
    },
  });
  return store;
};

const projectShell = (): OrchestrationProjectShell => ({
  id: "project-1" as OrchestrationProjectShell["id"],
  title: "Project",
  workspaceRoot: "/tmp/project",
  repositoryIdentity: null,
  defaultModelSelection: {
    instanceId: "codex-default" as OrchestrationProjectShell["defaultModelSelection"] extends null
      ? never
      : NonNullable<OrchestrationProjectShell["defaultModelSelection"]>["instanceId"],
    model: "gpt-test",
  },
  scripts: [],
  createdAt: "2026-07-31T08:00:00Z",
  updatedAt: "2026-07-31T08:00:00Z",
});

const threadShell = (): OrchestrationThreadShell => ({
  id: "thread-1" as OrchestrationThreadShell["id"],
  projectId: "project-1" as OrchestrationThreadShell["projectId"],
  title: "Existing recommendation",
  modelSelection: {
    instanceId: "codex-default" as OrchestrationThreadShell["modelSelection"]["instanceId"],
    model: "gpt-test",
  },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: "main",
  worktreePath: "/tmp/project",
  latestTurn: {
    turnId: "turn-1" as NonNullable<OrchestrationThreadShell["latestTurn"]>["turnId"],
    state: "completed",
    requestedAt: "2026-07-31T08:00:00Z",
    startedAt: "2026-07-31T08:00:01Z",
    completedAt: "2026-07-31T08:01:00Z",
    assistantMessageId: null,
  },
  createdAt: "2026-07-31T08:00:00Z",
  updatedAt: "2026-07-31T08:01:00Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: "2026-07-31T08:00:00Z",
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const fakeT3 = (dispatched: unknown[], store: BridgeStore): T3Client => ({
  start: () => {},
  stop: async () => {},
  pair: async () => "token",
  dispatch: async (command) => {
    dispatched.push(command);
    return { sequence: dispatched.length };
  },
  fullThreadDiff: async () => ({ diff: "", fromTurnCount: 0, toTurnCount: 1 }),
  threadOutput: async (threadId) => ({
    threadId,
    projectId: "project-1",
    assistantText: "Prefer the provider-neutral adapter.",
    createdAt: "2026-07-31T08:01:00Z",
    truncated: false,
    freshness: "live",
    ownership: "t3code",
  }),
  refreshThread: async (threadId) => {
    const shell = store.snapshot().threads.find((thread) => thread.id === threadId);
    if (shell === undefined) throw new Error("thread_snapshot_unavailable");
    store.applyThreadItem(threadId, {
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 4,
        thread: {
          ...threadShell(),
          ...shell,
          activities: [],
          checkpoints: [],
        } as unknown as OrchestrationThread,
      },
    });
  },
  connected: () => true,
});
