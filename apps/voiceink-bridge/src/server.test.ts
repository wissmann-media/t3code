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
      expect(body.bridgeVersion).toBe("0.3.0");
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

  it("keeps v1 managed gating while v2 operates without managed bookkeeping", async () => {
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
      // The universal path never records managed state; managedThreadIds is a
      // quarantined v1 compatibility concern.
      expect(store.isManagedThread("thread-1")).toBe(false);
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

describe("Bridge v3 canonical surface", () => {
  const iso = "2026-08-03T10:00:00Z";
  const model = { instanceId: "codex-default", model: "gpt-test" };

  it("serves the generated capability manifest on /v3/capabilities", async () => {
    await withServer(async ({ baseUrl }) => {
      const response = await authorizedFetch(`${baseUrl}/v3/capabilities`);
      expect(response.status).toBe(200);
      const manifest = (await response.json()) as {
        manifestSchemaVersion: string;
        apiVersion: number;
        commands: Array<{ command: string; available: boolean }>;
        queries: Array<{ query: string }>;
      };
      expect(manifest.manifestSchemaVersion).toBe("3.0.0");
      expect(manifest.apiVersion).toBe(3);
      expect(manifest.commands).toHaveLength(20);
      expect(manifest.commands.every((command) => command.available)).toBe(true);
    });
  });

  it("dispatches every canonical command variant through /v3/commands", async () => {
    await withServer(async ({ baseUrl, dispatched }) => {
      const commands: Array<Record<string, unknown>> = [
        {
          type: "project.create",
          commandId: "c01",
          projectId: "project-new",
          title: "New",
          workspaceRoot: "/tmp/new",
          createdAt: iso,
        },
        { type: "project.meta.update", commandId: "c02", projectId: "project-1", title: "Renamed" },
        { type: "project.delete", commandId: "c03", projectId: "project-1" },
        {
          type: "thread.create",
          commandId: "c04",
          threadId: "thread-new",
          projectId: "project-1",
          title: "T",
          modelSelection: model,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: iso,
        },
        { type: "thread.delete", commandId: "c05", threadId: "thread-1" },
        { type: "thread.archive", commandId: "c06", threadId: "thread-1" },
        { type: "thread.unarchive", commandId: "c07", threadId: "thread-1" },
        { type: "thread.settle", commandId: "c08", threadId: "thread-1" },
        { type: "thread.unsettle", commandId: "c09", threadId: "thread-1", reason: "user" },
        { type: "thread.snooze", commandId: "c10", threadId: "thread-1", snoozedUntil: iso },
        { type: "thread.unsnooze", commandId: "c11", threadId: "thread-1", reason: "user" },
        {
          type: "thread.meta.update",
          commandId: "c12",
          threadId: "thread-1",
          title: "Better title",
          expectedBranch: "main",
        },
        {
          type: "thread.runtime-mode.set",
          commandId: "c13",
          threadId: "thread-1",
          runtimeMode: "full-access",
          createdAt: iso,
        },
        {
          type: "thread.interaction-mode.set",
          commandId: "c14",
          threadId: "thread-1",
          interactionMode: "plan",
          createdAt: iso,
        },
        {
          type: "thread.turn.start",
          commandId: "c15",
          threadId: "thread-1",
          message: { messageId: "m15", role: "user", text: "Weiter bitte.", attachments: [] },
          runtimeMode: "approval-required",
          interactionMode: "default",
          titleSeed: "Weiter",
          createdAt: iso,
        },
        { type: "thread.turn.interrupt", commandId: "c16", threadId: "thread-1", createdAt: iso },
        {
          type: "thread.approval.respond",
          commandId: "c17",
          threadId: "thread-1",
          requestId: "req-1",
          decision: "accept",
          createdAt: iso,
        },
        {
          type: "thread.user-input.respond",
          commandId: "c18",
          threadId: "thread-1",
          requestId: "req-2",
          answers: { choice: "B" },
          createdAt: iso,
        },
        {
          type: "thread.checkpoint.revert",
          commandId: "c19",
          threadId: "thread-1",
          turnCount: 1,
          createdAt: iso,
        },
        { type: "thread.session.stop", commandId: "c20", threadId: "thread-1", createdAt: iso },
      ];
      for (const command of commands) {
        const response = await authorizedFetch(`${baseUrl}/v3/commands`, {
          method: "POST",
          body: JSON.stringify(command),
        });
        expect(response.status, String(command.type)).toBe(202);
        const body = (await response.json()) as {
          receipt: { status: string; commandId: string };
          verification: { state: string };
        };
        expect(body.receipt.status, String(command.type)).toBe("accepted");
        expect(["confirmed", "pending", "not-applicable"]).toContain(body.verification.state);
      }
      expect(dispatched.map((value) => (value as { type: string }).type)).toEqual(
        commands.map((command) => command.type),
      );
    });
  });

  it("starts an atomic bootstrap turn with worktree preparation", async () => {
    await withServer(async ({ baseUrl, dispatched }) => {
      const response = await authorizedFetch(`${baseUrl}/v3/commands`, {
        method: "POST",
        body: JSON.stringify({
          type: "thread.turn.start",
          commandId: "boot-1",
          threadId: "thread-boot",
          message: { messageId: "m-boot", role: "user", text: "Setz das um.", attachments: [] },
          runtimeMode: "approval-required",
          interactionMode: "default",
          bootstrap: {
            createThread: {
              projectId: "project-1",
              title: "Bootstrap session",
              modelSelection: model,
              runtimeMode: "approval-required",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt: iso,
            },
            prepareWorktree: { projectCwd: "/tmp/project", baseBranch: "main" },
            runSetupScript: true,
          },
          createdAt: iso,
        }),
      });
      expect(response.status).toBe(202);
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({
        type: "thread.turn.start",
        threadId: "thread-boot",
        bootstrap: { runSetupScript: true },
      });

      const unknownProject = await authorizedFetch(`${baseUrl}/v3/commands`, {
        method: "POST",
        body: JSON.stringify({
          type: "thread.turn.start",
          commandId: "boot-2",
          threadId: "thread-boot-2",
          message: { messageId: "m-boot-2", role: "user", text: "x", attachments: [] },
          runtimeMode: "approval-required",
          interactionMode: "default",
          bootstrap: {
            createThread: {
              projectId: "project-missing",
              title: "Nope",
              modelSelection: model,
              runtimeMode: "approval-required",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt: iso,
            },
          },
          createdAt: iso,
        }),
      });
      expect(unknownProject.status).toBe(422);
      expect(await unknownProject.json()).toEqual({ error: "invalid_bootstrap" });
    });
  });

  it("replays idempotently and rejects conflicting reuse of a command id", async () => {
    await withServer(async ({ baseUrl, dispatched }) => {
      const command = {
        type: "thread.archive",
        commandId: "replay-1",
        threadId: "thread-1",
      };
      const first = await authorizedFetch(`${baseUrl}/v3/commands`, {
        method: "POST",
        body: JSON.stringify(command),
      });
      expect(first.status).toBe(202);
      const second = await authorizedFetch(`${baseUrl}/v3/commands`, {
        method: "POST",
        body: JSON.stringify(command),
      });
      expect(second.status).toBe(202);
      expect(dispatched).toHaveLength(1);

      const conflicting = await authorizedFetch(`${baseUrl}/v3/commands`, {
        method: "POST",
        body: JSON.stringify({ ...command, type: "thread.settle" }),
      });
      expect(conflicting.status).toBe(409);
      expect(await conflicting.json()).toEqual({ error: "command_conflict" });
    });
  });

  it("refuses server-internal commands, unknown fields, and missing targets", async () => {
    await withServer(async ({ baseUrl, dispatched }) => {
      const internal = await authorizedFetch(`${baseUrl}/v3/commands`, {
        method: "POST",
        body: JSON.stringify({
          type: "thread.session.set",
          commandId: "evil-1",
          threadId: "thread-1",
          session: null,
        }),
      });
      expect(internal.status).toBe(422);

      const excess = await authorizedFetch(`${baseUrl}/v3/commands`, {
        method: "POST",
        body: JSON.stringify({
          type: "thread.archive",
          commandId: "excess-1",
          threadId: "thread-1",
          rpcMethod: "orchestration.anything",
        }),
      });
      expect(excess.status).toBe(422);

      const missing = await authorizedFetch(`${baseUrl}/v3/commands`, {
        method: "POST",
        body: JSON.stringify({
          type: "thread.archive",
          commandId: "missing-1",
          threadId: "thread-unknown",
        }),
      });
      expect(missing.status).toBe(404);
      expect(dispatched).toHaveLength(0);
    });
  });

  it("verifies authoritative post-command state when the projection confirms it", async () => {
    await withServer(async ({ baseUrl }) => {
      // thread-1 is not archived; unarchive is already authoritatively true.
      const confirmed = await authorizedFetch(`${baseUrl}/v3/commands`, {
        method: "POST",
        body: JSON.stringify({
          type: "thread.unarchive",
          commandId: "verify-1",
          threadId: "thread-1",
        }),
      });
      expect(confirmed.status).toBe(202);
      expect(
        ((await confirmed.json()) as { verification: { state: string } }).verification.state,
      ).toBe("confirmed");

      // Archive cannot be confirmed against the static fake projection.
      const pending = await authorizedFetch(`${baseUrl}/v3/commands`, {
        method: "POST",
        body: JSON.stringify({
          type: "thread.archive",
          commandId: "verify-2",
          threadId: "thread-1",
        }),
      });
      expect(pending.status).toBe(202);
      expect(
        ((await pending.json()) as { verification: { state: string } }).verification.state,
      ).toBe("pending");
    });
  });

  it("previews destructive commands with exact target and consequence", async () => {
    await withServer(async ({ baseUrl, dispatched }) => {
      const preview = await authorizedFetch(`${baseUrl}/v3/commands/preview`, {
        method: "POST",
        body: JSON.stringify({
          type: "project.delete",
          commandId: "p-del",
          projectId: "project-1",
          force: true,
        }),
      });
      expect(preview.status).toBe(200);
      const body = (await preview.json()) as {
        destructive: boolean;
        target: { kind: string; id: string; title: string };
        consequence: string;
      };
      expect(body.destructive).toBe(true);
      expect(body.target).toMatchObject({ kind: "project", id: "project-1", title: "Project" });
      expect(body.consequence).toContain("with force");
      expect(dispatched).toHaveLength(0);
    });
  });

  it("fails closed on an incompatible manifest major version", async () => {
    await withServer(async ({ baseUrl, dispatched }) => {
      const response = await authorizedFetch(`${baseUrl}/v3/commands`, {
        method: "POST",
        headers: { "x-manifest-major": "2" },
        body: JSON.stringify({
          type: "thread.archive",
          commandId: "old-major",
          threadId: "thread-1",
        }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "bridge_incompatible" });
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
    commands: new BridgeCommandService(store, t3, { verificationTimeoutMs: 25 }),
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
