import type {
  OrchestrationProjectShell,
  OrchestrationThread,
  OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { BridgeCommandService } from "./commands.ts";
import { ConsultationService } from "./consultation.ts";
import { WorkspaceService } from "./workspace.ts";
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

describe("Bridge v3 read surface", () => {
  it("reports a disconnected T3 as unavailable instead of an internal error", async () => {
    await withServer(
      async ({ baseUrl }) => {
        const response = await authorizedFetch(`${baseUrl}/v3/search?q=Importer`);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: "t3_unavailable" });
      },
      {
        archivedShellSnapshot: async () => {
          throw new Error("t3_unavailable");
        },
      },
    );
  });

  it("reports a T3-side rejection as an upstream failure, not a bridge defect", async () => {
    await withServer(
      async ({ baseUrl }) => {
        const response = await authorizedFetch(`${baseUrl}/v3/search?q=Importer`);
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({ error: "t3_rpc_failed" });
      },
      {
        // Effect RPC surfaces an unknown or failing T3 method as a raw string;
        // an older T3 build without this method looks exactly like this.
        archivedShellSnapshot: async () => {
          throw "orchestration.getArchivedShellSnapshot";
        },
      },
    );
  });

  it("searches active and archived threads with German folding and merged content matches", async () => {
    await withServer(async ({ baseUrl }) => {
      const archived = await authorizedFetch(`${baseUrl}/v3/search?q=ubersicht`);
      expect(archived.status).toBe(200);
      const archivedBody = (await archived.json()) as {
        results: Array<{ threadId: string; archived: boolean; matchedBy: string[] }>;
      };
      expect(archivedBody.results).toHaveLength(1);
      expect(archivedBody.results[0]).toMatchObject({
        threadId: "thread-archived",
        archived: true,
        matchedBy: ["title"],
      });

      const content = await authorizedFetch(`${baseUrl}/v3/search?q=Importer`);
      expect(content.status).toBe(200);
      const contentBody = (await content.json()) as {
        results: Array<{ threadId: string; snippet?: string; matchedBy: string[] }>;
      };
      const contentRow = contentBody.results.find((row) => row.threadId === "thread-1");
      expect(contentRow).toBeDefined();
      expect(contentRow!.matchedBy).toContain("content:assistant");
      expect(contentRow!.snippet).toContain("[REDACTED]");
      expect(contentRow!.snippet).not.toContain("password=abc");

      const filtered = await authorizedFetch(`${baseUrl}/v3/search?q=ubersicht&scope=active`);
      expect(((await filtered.json()) as { results: unknown[] }).results).toHaveLength(0);

      const invalid = await authorizedFetch(`${baseUrl}/v3/search?q=a`);
      expect(invalid.status).toBe(400);
    });
  });

  it("serves paginated redacted messages with attachment metadata and chunk reads", async () => {
    await withServer(async ({ baseUrl }) => {
      const firstPage = await authorizedFetch(`${baseUrl}/v3/threads/thread-1/messages?limit=2`);
      expect(firstPage.status).toBe(200);
      const body = (await firstPage.json()) as {
        messages: Array<{
          id: string;
          role: string;
          text: string;
          attachments: Array<{ name: string; sizeBytes: number }>;
        }>;
        totalMessages: number;
        nextCursor: string | null;
      };
      expect(body.totalMessages).toBe(3);
      expect(body.messages.map((message) => message.id)).toEqual(["message-1", "message-2"]);
      expect(body.nextCursor).toBe("2");
      const assistant = body.messages[1]!;
      expect(assistant.text).toContain("[REDACTED]");
      expect(assistant.text).not.toContain("super-geheim-123");
      expect(assistant.attachments).toEqual([
        {
          type: "image",
          id: "attachment-1",
          name: "diagramm.png",
          mimeType: "image/png",
          sizeBytes: 2_048,
        },
      ]);

      const secondPage = await authorizedFetch(
        `${baseUrl}/v3/threads/thread-1/messages?limit=2&cursor=2`,
      );
      const second = (await secondPage.json()) as {
        messages: Array<{ id: string }>;
        nextCursor: string | null;
      };
      expect(second.messages.map((message) => message.id)).toEqual(["message-3"]);
      expect(second.nextCursor).toBeNull();

      const chunk = await authorizedFetch(
        `${baseUrl}/v3/threads/thread-1/messages/message-2?offset=10`,
      );
      expect(chunk.status).toBe(200);
      const chunkBody = (await chunk.json()) as {
        offset: number;
        text: string;
        totalLength: number;
        nextOffset: number | null;
      };
      expect(chunkBody.offset).toBe(10);
      expect(chunkBody.totalLength).toBeGreaterThan(1_000);
      expect(chunkBody.nextOffset).toBeNull();

      const missing = await authorizedFetch(`${baseUrl}/v3/threads/thread-unknown/messages`);
      expect(missing.status).toBe(404);
    });
  });

  it("serves paginated activities and pending interactions with exact request IDs", async () => {
    await withServer(async ({ baseUrl }) => {
      const activities = await authorizedFetch(
        `${baseUrl}/v3/threads/thread-1/activities?limit=2&cursor=1`,
      );
      expect(activities.status).toBe(200);
      const body = (await activities.json()) as {
        activities: Array<{ id: string; requestId?: string }>;
        totalActivities: number;
      };
      expect(body.totalActivities).toBe(3);
      expect(body.activities.map((activity) => activity.id)).toEqual(["activity-2", "activity-3"]);
      expect(body.activities[0]!.requestId).toBe("request-1");

      const interactions = await authorizedFetch(`${baseUrl}/v3/threads/thread-1/interactions`);
      expect(interactions.status).toBe(200);
      const interactionBody = (await interactions.json()) as {
        requests: Array<{
          kind: string;
          requestId: string;
          questions?: Array<{ id: string; options: Array<{ label: string }> }>;
        }>;
      };
      expect(interactionBody.requests).toHaveLength(2);
      expect(interactionBody.requests[0]).toMatchObject({
        kind: "user-input",
        requestId: "request-2",
      });
      expect(
        interactionBody.requests[0]!.questions![0]!.options.map((option) => option.label),
      ).toEqual(["Option A", "Option B"]);
      expect(interactionBody.requests[1]).toMatchObject({
        kind: "approval",
        requestId: "request-1",
        requestKind: "command",
      });
    });
  });

  it("serves checkpoints with revert targets and turn diffs with explicit counts", async () => {
    await withServer(async ({ baseUrl }) => {
      const checkpoints = await authorizedFetch(`${baseUrl}/v3/threads/thread-1/checkpoints`);
      expect(checkpoints.status).toBe(200);
      const body = (await checkpoints.json()) as {
        checkpoints: Array<{
          checkpointRef: string;
          revertTarget: { command: string; turnCount: number };
          files: Array<{ path: string }>;
        }>;
      };
      expect(body.checkpoints).toHaveLength(1);
      expect(body.checkpoints[0]!.checkpointRef).toBe("refs/t3/checkpoints/turn-1");
      expect(body.checkpoints[0]!.revertTarget).toEqual({
        command: "thread.checkpoint.revert",
        turnCount: 1,
      });

      const diff = await authorizedFetch(
        `${baseUrl}/v3/threads/thread-1/turn-diff?fromTurnCount=0&toTurnCount=1`,
      );
      expect(diff.status).toBe(200);
      expect(await diff.json()).toMatchObject({
        threadId: "thread-1",
        diff: "diff --git a/src/importer.ts b/src/importer.ts",
        fromTurnCount: 0,
        toTurnCount: 1,
      });

      const invalid = await authorizedFetch(`${baseUrl}/v3/threads/thread-1/turn-diff`);
      expect(invalid.status).toBe(400);
    });
  });

  it("serves redacted proposed plans referencable at turn start", async () => {
    await withServer(async ({ baseUrl }) => {
      const plans = await authorizedFetch(`${baseUrl}/v3/threads/thread-1/plans`);
      expect(plans.status).toBe(200);
      const body = (await plans.json()) as {
        plans: Array<{
          id: string;
          planMarkdown: string;
          sourceReference: { threadId: string; planId: string };
        }>;
      };
      expect(body.plans).toHaveLength(1);
      expect(body.plans[0]!.planMarkdown).toContain("[REDACTED]");
      expect(body.plans[0]!.planMarkdown).not.toContain("hunter2");
      expect(body.plans[0]!.sourceReference).toEqual({ threadId: "thread-1", planId: "plan-1" });

      const missing = await authorizedFetch(
        `${baseUrl}/v3/threads/thread-1/plans?planId=plan-unknown`,
      );
      expect(missing.status).toBe(404);
    });
  });

  it("serves a bounded spoken summary instead of the fixed output contract", async () => {
    await withServer(async ({ baseUrl }) => {
      const summary = await authorizedFetch(`${baseUrl}/v3/threads/thread-1/summary`);
      expect(summary.status).toBe(200);
      const body = (await summary.json()) as {
        spokenSummary: string;
        truncated: boolean;
        latestAssistantMessageId: string;
        totalMessages: number;
      };
      expect(body.truncated).toBe(true);
      expect(body.spokenSummary.length).toBeLessThanOrEqual(1_201);
      expect(body.spokenSummary).toContain("[REDACTED]");
      expect(body.latestAssistantMessageId).toBe("message-2");
      expect(body.totalMessages).toBe(3);
    });
  });

  it("serves the archived shell snapshot and dynamic retention controls", async () => {
    await withServer(async ({ baseUrl }) => {
      const archived = await authorizedFetch(`${baseUrl}/v3/archived`);
      expect(archived.status).toBe(200);
      const body = (await archived.json()) as {
        snapshotSequence: number;
        threads: Array<{ id: string; archivedAt: string | null }>;
      };
      expect(body.snapshotSequence).toBe(9);
      expect(body.threads[0]).toMatchObject({
        id: "thread-archived",
        archivedAt: "2026-07-20T10:00:00Z",
      });
      expect(body.threads[0]).not.toHaveProperty("managed");

      const retain = await authorizedFetch(`${baseUrl}/v3/threads/thread-1/retain`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(retain.status).toBe(200);
      expect(await retain.json()).toMatchObject({
        threadId: "thread-1",
        retained: true,
        retainedThreadIds: ["thread-1"],
      });

      const release = await authorizedFetch(`${baseUrl}/v3/threads/thread-1/retain`, {
        method: "DELETE",
      });
      expect(release.status).toBe(200);
      expect(await release.json()).toMatchObject({ retained: false, retainedThreadIds: [] });
    });
  });
});

const withServer = async (
  test: (context: { baseUrl: string; store: BridgeStore; dispatched: unknown[] }) => Promise<void>,
  overrides: Partial<T3Client> = {},
): Promise<void> => {
  const store = liveStore();
  const dispatched: unknown[] = [];
  const t3 = { ...fakeT3(dispatched, store), ...overrides } as T3Client;
  const commands = new BridgeCommandService(store, t3, { verificationTimeoutMs: 25 });
  const server = createBridgeServer({
    store,
    commands,
    workspaces: new WorkspaceService(store, commands),
    consultations: new ConsultationService(store, commands, t3),
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

const fullThreadFixture = (threadId: string): OrchestrationThread =>
  ({
    ...threadShell(),
    id: threadId as OrchestrationThreadShell["id"],
    deletedAt: null,
    messages: [
      {
        id: "message-1",
        role: "user",
        text: "Bitte analysiere den Importer.",
        turnId: "turn-1",
        streaming: false,
        createdAt: "2026-07-31T08:00:00Z",
        updatedAt: "2026-07-31T08:00:00Z",
      },
      {
        id: "message-2",
        role: "assistant",
        text: `Empfehlung: Option B. api_key=super-geheim-123 ${"x".repeat(2_000)}`,
        turnId: "turn-1",
        streaming: false,
        createdAt: "2026-07-31T08:01:00Z",
        updatedAt: "2026-07-31T08:01:00Z",
        attachments: [
          {
            type: "image",
            id: "attachment-1",
            name: "diagramm.png",
            mimeType: "image/png",
            sizeBytes: 2_048,
          },
        ],
      },
      {
        id: "message-3",
        role: "user",
        text: "Und die Risiken?",
        turnId: "turn-2",
        streaming: false,
        createdAt: "2026-07-31T08:02:00Z",
        updatedAt: "2026-07-31T08:02:00Z",
      },
    ],
    proposedPlans: [
      {
        id: "plan-1",
        turnId: "turn-1",
        planMarkdown: "# Plan\n1. Refactor importer\n2. password=hunter2 entfernen",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: "2026-07-31T08:01:30Z",
        updatedAt: "2026-07-31T08:01:30Z",
      },
    ],
    activities: [
      {
        id: "activity-1",
        tone: "tool",
        kind: "tool.completed",
        payload: {},
        createdAt: "2026-07-31T08:00:30Z",
      },
      {
        id: "activity-2",
        tone: "approval",
        kind: "approval.requested",
        payload: { requestId: "request-1", requestKind: "command", requestType: "shell" },
        createdAt: "2026-07-31T08:00:45Z",
      },
      {
        id: "activity-3",
        tone: "info",
        kind: "user-input.requested",
        payload: {
          requestId: "request-2",
          questions: [
            {
              id: "q1",
              header: "Ansatz",
              question: "Welche Option soll umgesetzt werden?",
              options: [
                { label: "Option A", description: "Konservativ" },
                { label: "Option B", description: "Vollständig" },
              ],
              multiSelect: false,
            },
          ],
        },
        createdAt: "2026-07-31T08:01:15Z",
      },
    ],
    checkpoints: [
      {
        turnId: "turn-1",
        checkpointTurnCount: 1,
        checkpointRef: "refs/t3/checkpoints/turn-1",
        status: "ready",
        files: [{ path: "src/importer.ts", kind: "modified", additions: 12, deletions: 3 }],
        assistantMessageId: "message-2",
        completedAt: "2026-07-31T08:01:00Z",
      },
    ],
  }) as unknown as OrchestrationThread;

const fakeT3 = (dispatched: unknown[], store: BridgeStore): T3Client => {
  const retained = new Set<string>();
  return {
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
    threadDetail: async (threadId) => {
      if (threadId === "thread-unknown") throw new Error("thread_snapshot_unavailable");
      return fullThreadFixture(threadId);
    },
    searchThreads: async (query) =>
      query.toLowerCase().includes("importer")
        ? [
            {
              threadId: "thread-1",
              projectId: "project-1",
              source: "assistant",
              snippet: "Empfehlung: Option B für den Importer. password=abc",
              messageCreatedAt: "2026-07-31T08:01:00Z",
            } as unknown as Awaited<ReturnType<T3Client["searchThreads"]>>[number],
          ]
        : [],
    turnDiff: async (_threadId, fromTurnCount, toTurnCount) => ({
      diff: "diff --git a/src/importer.ts b/src/importer.ts",
      fromTurnCount,
      toTurnCount,
    }),
    archivedShellSnapshot: async () =>
      ({
        snapshotSequence: 9,
        projects: [projectShell()],
        threads: [
          {
            ...threadShell(),
            id: "thread-archived" as OrchestrationThreadShell["id"],
            title: "Übersicht Altprojekt",
            archivedAt: "2026-07-20T10:00:00Z",
            updatedAt: "2026-07-20T10:00:00Z",
          },
        ],
        updatedAt: "2026-07-31T09:00:00Z",
      }) as unknown as Awaited<ReturnType<T3Client["archivedShellSnapshot"]>>,
    retainThread: (threadId) => retained.add(threadId),
    releaseThread: (threadId) => retained.delete(threadId),
    retainedThreadIds: () => [...retained],
    connected: () => true,
  };
};
