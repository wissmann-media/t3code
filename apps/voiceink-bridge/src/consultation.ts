import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { BridgeCommandService } from "./commands.ts";
import { decodeCanonicalCommand } from "./schemas.ts";
import { isoFromEpochMillis, nowEpochMillis, nowIso } from "./time.ts";
import type { BridgeStore } from "./store.ts";
import type { T3Client } from "./t3Client.ts";

/**
 * A first-class repository-aware consultation (plan phase 6): provider-backed
 * analysis grounded in a real project or thread context that never appears as
 * a task session and never mutates the repository.
 *
 * Mechanism: the consultation thread is created through the atomic bootstrap
 * turn in interaction mode "plan" (the provider's non-mutating posture) and
 * archived in the same breath, so it exists only as an archived, hidden T3
 * thread. Its answer is returned as bounded evidence with stable references.
 */

export type ConsultationStatus = "running" | "completed" | "failed" | "cancelled" | "timed-out";

export interface ConsultationEvidence {
  readonly kind: "message" | "plan";
  readonly threadId: string;
  readonly itemId: string;
  readonly retrievedAt: string;
}

export interface ConsultationRun {
  readonly schemaVersion: 1;
  readonly consultationId: string;
  readonly workspaceId: string | null;
  readonly projectId: string;
  readonly sourceThreadId: string | null;
  readonly threadId: string;
  readonly question: string;
  readonly modelSelection: { readonly instanceId: string; readonly model: string };
  readonly status: ConsultationStatus;
  readonly answer: string | null;
  readonly evidence: ReadonlyArray<ConsultationEvidence>;
  readonly failureReason: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly expiresAt: string;
}

export class ConsultationError extends Error {
  readonly code:
    | "not_found"
    | "project_not_found"
    | "provider_cannot_guarantee_non_mutation"
    | "provider_unavailable"
    | "source_thread_not_found";

  constructor(code: ConsultationError["code"]) {
    super(code);
    this.code = code;
  }
}

interface PersistedConsultations {
  readonly schemaVersion: 1;
  readonly runs: ReadonlyArray<ConsultationRun>;
}

const MAX_RUNS = 100;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const ANSWER_BOUND = 8_000;
const EXPIRY_MS = 24 * 60 * 60 * 1_000;

export class ConsultationService {
  private state: PersistedConsultations;
  private readonly filePath: string | null;
  private readonly store: BridgeStore;
  private readonly commands: BridgeCommandService;
  private readonly t3: T3Client;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly unsubscribers = new Map<string, () => void>();
  /** Consultations whose hide-archive must retry once the shell catches up. */
  private readonly archivePending = new Set<string>();

  constructor(
    store: BridgeStore,
    commands: BridgeCommandService,
    t3: T3Client,
    filePath: string | null = null,
  ) {
    this.store = store;
    this.commands = commands;
    this.t3 = t3;
    this.filePath = filePath;
    this.state = this.load();
  }

  list(): ReadonlyArray<ConsultationRun> {
    return this.state.runs;
  }

  get(consultationId: string): ConsultationRun {
    const run = this.state.runs.find((candidate) => candidate.consultationId === consultationId);
    if (run === undefined) throw new ConsultationError("not_found");
    return run;
  }

  /**
   * Start (or deduplicate) a consultation. Retrying with the same
   * consultationId returns the existing run and never dispatches twice.
   */
  async start(request: {
    readonly consultationId: string;
    readonly workspaceId?: string | undefined;
    readonly projectId?: string | undefined;
    readonly sourceThreadId?: string | undefined;
    readonly question: string;
    readonly modelSelection?: { readonly instanceId: string; readonly model: string } | undefined;
    readonly timeoutMs?: number | undefined;
  }): Promise<ConsultationRun> {
    const existing = this.state.runs.find(
      (candidate) => candidate.consultationId === request.consultationId,
    );
    if (existing !== undefined) return existing;

    const snapshot = this.store.snapshot();
    const sourceThread =
      request.sourceThreadId === undefined
        ? undefined
        : snapshot.threads.find((thread) => thread.id === request.sourceThreadId);
    if (request.sourceThreadId !== undefined && sourceThread === undefined) {
      throw new ConsultationError("source_thread_not_found");
    }
    const projectId = request.projectId ?? sourceThread?.projectId;
    const project = snapshot.projects.find((candidate) => candidate.id === projectId);
    if (projectId === undefined || project === undefined) {
      throw new ConsultationError("project_not_found");
    }

    const modelSelection = request.modelSelection ?? this.defaultModel(sourceThread);
    if (modelSelection === undefined) throw new ConsultationError("provider_unavailable");
    // Non-mutating posture is a hard requirement: when the provider cannot
    // guarantee it (no plan/interaction-mode support), fail closed and let
    // the caller create an explicit, visible task instead.
    const provider = snapshot.environment?.providers.find(
      (candidate) => candidate.instanceId === modelSelection.instanceId,
    );
    if (provider === undefined) throw new ConsultationError("provider_unavailable");
    if (provider.showInteractionModeToggle === false) {
      throw new ConsultationError("provider_cannot_guarantee_non_mutation");
    }

    const threadId = `consultation-${request.consultationId}`;
    const startedAt = nowIso();
    const prompt = this.consultationPrompt(request.question, sourceThread?.id ?? null);

    // Atomic bootstrap in plan mode, then archive in the same breath so the
    // consultation never appears in the active session list.
    const turnCommand = await decodeCanonicalCommand({
      type: "thread.turn.start",
      commandId: `${request.consultationId}:turn`,
      threadId,
      message: {
        messageId: `${request.consultationId}:question`,
        role: "user",
        text: prompt,
        attachments: [],
      },
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      titleSeed: `Consultation: ${request.question.slice(0, 80)}`,
      bootstrap: {
        createThread: {
          projectId,
          title: `Consultation: ${request.question.slice(0, 160)}`,
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "plan",
          branch: null,
          worktreePath: null,
          createdAt: startedAt,
        },
      },
      createdAt: startedAt,
    });
    const turnResult = await this.commands.canonical(turnCommand, {
      consultationId: request.consultationId,
      stage: "turn",
    });
    if (turnResult.receipt.status !== "accepted") {
      const failed = this.record({
        schemaVersion: 1,
        consultationId: request.consultationId,
        workspaceId: request.workspaceId ?? null,
        projectId,
        sourceThreadId: sourceThread?.id ?? null,
        threadId,
        question: request.question,
        modelSelection,
        status: "failed",
        answer: null,
        evidence: [],
        failureReason: turnResult.receipt.reasonCode ?? "dispatch_rejected",
        startedAt,
        completedAt: nowIso(),
        expiresAt: isoFromEpochMillis(nowEpochMillis() + EXPIRY_MS),
      });
      return failed;
    }

    const archiveCommand = await decodeCanonicalCommand({
      type: "thread.archive",
      commandId: `${request.consultationId}:archive`,
      threadId,
    });
    // Archive failures are tolerated (the consultation still works, merely
    // visible) and retried once the shell projection catches up.
    await this.commands
      .canonical(archiveCommand, { consultationId: request.consultationId, stage: "archive" })
      .catch(() => {
        this.archivePending.add(request.consultationId);
      });

    const run = this.record({
      schemaVersion: 1,
      consultationId: request.consultationId,
      workspaceId: request.workspaceId ?? null,
      projectId,
      sourceThreadId: sourceThread?.id ?? null,
      threadId,
      question: request.question,
      modelSelection,
      status: "running",
      answer: null,
      evidence: [],
      failureReason: null,
      startedAt,
      completedAt: null,
      expiresAt: isoFromEpochMillis(nowEpochMillis() + EXPIRY_MS),
    });
    this.t3.retainThread(threadId);
    this.watchForCompletion(run, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return run;
  }

  /** Cancel a running consultation; late provider results are suppressed. */
  async cancel(consultationId: string): Promise<ConsultationRun> {
    const run = this.get(consultationId);
    if (run.status !== "running") return run;
    const interrupt = await decodeCanonicalCommand({
      type: "thread.turn.interrupt",
      commandId: `${consultationId}:interrupt`,
      threadId: run.threadId,
      createdAt: nowIso(),
    });
    await this.commands
      .canonical(interrupt, { consultationId, stage: "interrupt" })
      .catch(() => undefined);
    return this.finish(consultationId, {
      status: "cancelled",
      answer: null,
      evidence: [],
      failureReason: null,
    });
  }

  private watchForCompletion(run: ConsultationRun, timeoutMs: number): void {
    const timer = setTimeout(() => {
      void this.finishSafely(run.consultationId, {
        status: "timed-out",
        answer: null,
        evidence: [],
        failureReason: "timeout",
      });
    }, timeoutMs);
    this.timers.set(run.consultationId, timer);
    const unsubscribe = this.store.subscribe((event) => {
      if (event.threadId !== run.threadId) return;
      if (this.archivePending.has(run.consultationId)) {
        this.archivePending.delete(run.consultationId);
        void this.retryArchive(run);
      }
      const status = (event.payload as { readonly status?: string }).status;
      if (status === "completed") {
        void this.completeFromThread(run.consultationId, run.threadId);
      } else if (status === "failed") {
        void this.finishSafely(run.consultationId, {
          status: "failed",
          answer: null,
          evidence: [],
          failureReason: "provider_failed",
        });
      }
    });
    this.unsubscribers.set(run.consultationId, unsubscribe);
  }

  private async retryArchive(run: ConsultationRun): Promise<void> {
    try {
      const archive = await decodeCanonicalCommand({
        type: "thread.archive",
        commandId: `${run.consultationId}:archive-retry`,
        threadId: run.threadId,
      });
      await this.commands.canonical(archive, {
        consultationId: run.consultationId,
        stage: "archive-retry",
      });
    } catch {
      this.archivePending.add(run.consultationId);
    }
  }

  private async completeFromThread(consultationId: string, threadId: string): Promise<void> {
    try {
      const thread = await this.t3.threadDetail(threadId);
      const retrievedAt = nowIso();
      const evidence: ConsultationEvidence[] = [];
      let answer: string | null = null;
      const plan = thread.proposedPlans.at(-1);
      if (plan !== undefined) {
        answer = plan.planMarkdown;
        evidence.push({ kind: "plan", threadId, itemId: plan.id, retrievedAt });
      }
      const lastAssistant = [...thread.messages]
        .reverse()
        .find((message) => message.role === "assistant" && message.text.trim().length > 0);
      if (lastAssistant !== undefined) {
        if (answer === null) answer = lastAssistant.text;
        evidence.push({
          kind: "message",
          threadId,
          itemId: lastAssistant.id,
          retrievedAt,
        });
      }
      await this.finishSafely(consultationId, {
        status: "completed",
        answer: answer === null ? null : answer.slice(0, ANSWER_BOUND),
        evidence,
        failureReason: null,
      });
    } catch {
      await this.finishSafely(consultationId, {
        status: "failed",
        answer: null,
        evidence: [],
        failureReason: "answer_retrieval_failed",
      });
    }
  }

  private async finishSafely(
    consultationId: string,
    outcome: {
      readonly status: ConsultationStatus;
      readonly answer: string | null;
      readonly evidence: ReadonlyArray<ConsultationEvidence>;
      readonly failureReason: string | null;
    },
  ): Promise<void> {
    try {
      this.finish(consultationId, outcome);
    } catch {
      // The run may already be terminal (late-result suppression).
    }
  }

  private finish(
    consultationId: string,
    outcome: {
      readonly status: ConsultationStatus;
      readonly answer: string | null;
      readonly evidence: ReadonlyArray<ConsultationEvidence>;
      readonly failureReason: string | null;
    },
  ): ConsultationRun {
    const run = this.get(consultationId);
    // Terminal states never change again: a late provider result cannot
    // overwrite a cancellation or timeout.
    if (run.status !== "running") return run;
    const timer = this.timers.get(consultationId);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(consultationId);
    const unsubscribe = this.unsubscribers.get(consultationId);
    if (unsubscribe !== undefined) unsubscribe();
    this.unsubscribers.delete(consultationId);
    this.t3.releaseThread(run.threadId);
    const finished: ConsultationRun = {
      ...run,
      status: outcome.status,
      answer: outcome.answer,
      evidence: outcome.evidence,
      failureReason: outcome.failureReason,
      completedAt: nowIso(),
    };
    this.replace(finished);
    this.store.emitExternalEvent(
      "consultation.finished",
      `consultation:${consultationId}:${outcome.status}`,
      {
        threadId: run.threadId,
        freshness: "live",
        payload: {
          consultationId,
          status: outcome.status,
          evidenceCount: outcome.evidence.length,
        },
      },
    );
    return finished;
  }

  private consultationPrompt(question: string, sourceThreadId: string | null): string {
    return [
      "This is a read-only consultation. Analyze and answer; do not modify the",
      "repository, do not create files, do not run mutating commands.",
      sourceThreadId === null
        ? null
        : `Context: this consultation continues the discussion context of thread ${sourceThreadId}.`,
      `Question:\n${question}`,
    ]
      .filter((line): line is string => line !== null)
      .join("\n\n");
  }

  private defaultModel(
    sourceThread: { readonly providerInstanceId: string; readonly model: string } | undefined,
  ): { readonly instanceId: string; readonly model: string } | undefined {
    if (sourceThread !== undefined) {
      return { instanceId: sourceThread.providerInstanceId, model: sourceThread.model };
    }
    const providers = this.store.snapshot().environment?.providers ?? [];
    for (const provider of providers) {
      if (!provider.enabled || provider.state !== "ready") continue;
      const model = provider.models.find((candidate) => candidate.isDefault);
      if (model !== undefined) {
        return { instanceId: provider.instanceId, model: model.slug };
      }
    }
    return undefined;
  }

  private record(run: ConsultationRun): ConsultationRun {
    this.state = {
      ...this.state,
      runs: [...this.state.runs, run].slice(-MAX_RUNS),
    };
    this.persist();
    return run;
  }

  private replace(run: ConsultationRun): void {
    this.state = {
      ...this.state,
      runs: this.state.runs.map((candidate) =>
        candidate.consultationId === run.consultationId ? run : candidate,
      ),
    };
    this.persist();
  }

  private load(): PersistedConsultations {
    const empty: PersistedConsultations = { schemaVersion: 1, runs: [] };
    if (this.filePath === null || !NodeFS.existsSync(this.filePath)) return empty;
    try {
      const parsed: unknown = JSON.parse(NodeFS.readFileSync(this.filePath, "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "schemaVersion" in parsed &&
        parsed.schemaVersion === 1
      ) {
        // Runs that were running when the process died are unknowable now.
        const state = parsed as PersistedConsultations;
        return {
          ...state,
          runs: state.runs.map((run) =>
            run.status === "running"
              ? { ...run, status: "failed", failureReason: "bridge_restarted" }
              : run,
          ),
        };
      }
    } catch {
      return empty;
    }
    return empty;
  }

  private persist(): void {
    if (this.filePath === null) return;
    NodeFS.mkdirSync(NodePath.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.tmp`;
    NodeFS.writeFileSync(tempPath, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
    NodeFS.renameSync(tempPath, this.filePath);
  }
}
