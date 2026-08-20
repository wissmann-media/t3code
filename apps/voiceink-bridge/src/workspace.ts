import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { BridgeCommandService, CanonicalCommandResult } from "./commands.ts";
import { decodeCanonicalCommand } from "./schemas.ts";
import { nowIso } from "./time.ts";
import type { BridgeStore } from "./store.ts";
import type { BridgeSnapshot } from "./types.ts";

/**
 * T3-side operational conversation state (ADR:
 * docs/plans/adrs/0002-operational-conversation-placement.md). The workspace
 * and its task draft are multi-client, revisioned, evented, and resumable.
 * They never contain persona or private memory, and no T3 task session exists
 * until a bound commitment materializes the draft.
 */

export type WorkspaceState =
  | "exploring"
  | "shaping"
  | "ready"
  | "executing"
  | "monitoring"
  | "follow-up"
  | "closed";

const STATE_TRANSITIONS: Readonly<Record<WorkspaceState, ReadonlyArray<WorkspaceState>>> = {
  exploring: ["shaping", "closed"],
  shaping: ["exploring", "ready", "closed"],
  ready: ["shaping", "executing", "closed"],
  executing: ["monitoring", "follow-up", "closed"],
  monitoring: ["follow-up", "executing", "closed"],
  "follow-up": ["executing", "monitoring", "closed"],
  closed: ["exploring"],
};

export interface DraftDecision {
  readonly at: string;
  /** Who contributed: the user's words, Insa's inference, T3 evidence, or an assumption. */
  readonly source: "user" | "insa" | "t3-evidence" | "assumption";
  readonly text: string;
}

export interface TaskDraft {
  readonly draftRevision: number;
  readonly goal: string | null;
  readonly background: string | null;
  readonly scope: ReadonlyArray<string>;
  readonly constraints: ReadonlyArray<string>;
  readonly targetProjectId: string | null;
  readonly sessionStrategy: "reuse" | "fork" | "create" | null;
  readonly targetThreadId: string | null;
  readonly modelSelection: {
    readonly instanceId: string;
    readonly model: string;
    readonly options?:
      | ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
      | undefined;
  } | null;
  readonly runtimeMode: string | null;
  readonly interactionMode: string | null;
  readonly branch: string | null;
  readonly worktreeIntent: string | null;
  readonly acceptanceCriteria: ReadonlyArray<string>;
  readonly unresolvedDecisions: ReadonlyArray<string>;
  readonly riskFlags: ReadonlyArray<string>;
  /** Concise provider-ready prompt; never the verbatim orchestration wording. */
  readonly providerPrompt: string | null;
  readonly decisionLog: ReadonlyArray<DraftDecision>;
}

export interface EvidenceRef {
  readonly kind: string;
  readonly threadId?: string;
  readonly itemId?: string;
  readonly cursor?: string;
  readonly retrievedAt: string;
}

export interface LinkedExecution {
  readonly threadId: string;
  readonly commandId: string;
  readonly draftRevision: number;
  readonly mode: "create" | "reuse" | "fork";
  readonly materializedAt: string;
}

/**
 * A safe handle for a terminal execution result that has not been spoken yet.
 * After a reconnect the client presents it exactly once; intermediate speech
 * is never replayed.
 */
export interface PendingExecutionResult {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly kind: "final" | "failure";
  readonly createdAt: string;
  readonly deliveredAt: string | null;
}

export interface ConversationWorkspace {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly revision: number;
  readonly clients: ReadonlyArray<string>;
  readonly state: WorkspaceState;
  readonly activeProjectId: string | null;
  readonly activeThreadId: string | null;
  readonly referencedThreadIds: ReadonlyArray<string>;
  readonly evidenceRefs: ReadonlyArray<EvidenceRef>;
  readonly pendingQuestions: ReadonlyArray<string>;
  readonly linkedExecutions: ReadonlyArray<LinkedExecution>;
  readonly draft: TaskDraft;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type MaterializationPlan =
  | {
      readonly kind: "canonical";
      readonly command: Record<string, unknown>;
    }
  | {
      readonly kind: "fork";
      readonly sourceThreadId: string;
      readonly request: {
        readonly commandId: string;
        readonly threadId: string;
        readonly messageId: string;
        readonly title: string;
        readonly text: string;
        readonly modelSelection?: TaskDraft["modelSelection"] extends infer Selection
          ? Exclude<Selection, null>
          : never;
        readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
        readonly interactionMode?: "default" | "plan";
      };
    };

type DraftPatchFields = {
  readonly [Key in keyof Omit<TaskDraft, "draftRevision" | "decisionLog">]?:
    | Omit<TaskDraft, "draftRevision" | "decisionLog">[Key]
    | undefined;
};

export interface WorkspacePatch {
  readonly resetDraft?: boolean;
  readonly activeProjectId?: string | null;
  readonly activeThreadId?: string | null;
  readonly referencedThreadIds?: ReadonlyArray<string>;
  readonly evidenceRefs?: ReadonlyArray<EvidenceRef>;
  readonly pendingQuestions?: ReadonlyArray<string>;
  readonly draft?: DraftPatchFields;
  readonly decision?: DraftDecision;
}

export class WorkspaceError extends Error {
  readonly code:
    | "authorization_stale"
    | "already_materialized"
    | "draft_incomplete"
    | "invalid_transition"
    | "not_found"
    | "operation_conflict"
    | "stale_revision";

  constructor(code: WorkspaceError["code"]) {
    super(code);
    this.code = code;
  }
}

interface PersistedWorkspaces {
  readonly schemaVersion: 1;
  readonly workspaces: ReadonlyArray<ConversationWorkspace>;
  /** operationId -> resulting revision, for idempotent replay. */
  readonly operations: ReadonlyArray<readonly [string, string, number]>;
  /** Consumed one-time authorizations: workspaceId:draftRevision:digest. */
  readonly consumedAuthorizations: ReadonlyArray<string>;
  readonly pendingResults?: ReadonlyArray<PendingExecutionResult>;
}

const MAX_WORKSPACES = 200;
const MAX_OPERATIONS = 2_000;

const emptyDraft = (): TaskDraft => ({
  draftRevision: 0,
  goal: null,
  background: null,
  scope: [],
  constraints: [],
  targetProjectId: null,
  sessionStrategy: null,
  targetThreadId: null,
  modelSelection: null,
  runtimeMode: null,
  interactionMode: null,
  branch: null,
  worktreeIntent: null,
  acceptanceCriteria: [],
  unresolvedDecisions: [],
  riskFlags: [],
  providerPrompt: null,
  decisionLog: [],
});

export class WorkspaceService {
  private state: PersistedWorkspaces;
  private readonly filePath: string | null;
  private readonly store: BridgeStore;
  private readonly commands: BridgeCommandService;

  constructor(store: BridgeStore, commands: BridgeCommandService, filePath: string | null = null) {
    this.store = store;
    this.commands = commands;
    this.filePath = filePath;
    this.state = this.load();
    // The workspace follows every linked execution: thread events are
    // correlated back to workspace, draft revision, and command so one T3
    // turn yields exactly one substantive result.
    this.store.subscribe((event) => this.onExecutionEvent(event));
  }

  list(): ReadonlyArray<ConversationWorkspace> {
    return this.state.workspaces;
  }

  get(workspaceId: string): ConversationWorkspace {
    const workspace = this.state.workspaces.find(
      (candidate) => candidate.workspaceId === workspaceId,
    );
    if (workspace === undefined) throw new WorkspaceError("not_found");
    return workspace;
  }

  create(workspaceId: string, clientId: string): ConversationWorkspace {
    const existing = this.state.workspaces.find(
      (candidate) => candidate.workspaceId === workspaceId,
    );
    if (existing !== undefined) {
      // Idempotent create; a new client joins the participant list as a
      // revisioned, evented change so every other client observes it.
      if (existing.clients.includes(clientId)) return existing;
      const joined = {
        ...existing,
        revision: existing.revision + 1,
        clients: [...existing.clients, clientId],
        updatedAt: nowIso(),
      };
      this.replaceWorkspace(joined);
      this.emit(joined, "workspace.updated");
      return joined;
    }
    const timestamp = nowIso();
    const workspace: ConversationWorkspace = {
      schemaVersion: 1,
      workspaceId,
      revision: 1,
      clients: [clientId],
      state: "exploring",
      activeProjectId: null,
      activeThreadId: null,
      referencedThreadIds: [],
      evidenceRefs: [],
      pendingQuestions: [],
      linkedExecutions: [],
      draft: emptyDraft(),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.state = {
      ...this.state,
      workspaces: [...this.state.workspaces, workspace].slice(-MAX_WORKSPACES),
    };
    this.persist();
    this.emit(workspace, "workspace.created");
    return workspace;
  }

  /**
   * Deterministic patching with optimistic concurrency and idempotent replay.
   * Distinguished decision sources keep user statements, Insa inferences, T3
   * evidence, and assumptions separable in the decision log.
   */
  patch(
    workspaceId: string,
    expectedRevision: number,
    operationId: string,
    patch: WorkspacePatch,
  ): ConversationWorkspace {
    const replayed = this.replay(workspaceId, operationId);
    if (replayed !== null) return replayed;
    const workspace = this.get(workspaceId);
    if (workspace.revision !== expectedRevision) throw new WorkspaceError("stale_revision");

    const resetsDraft = patch.resetDraft === true;
    const draftChanged = resetsDraft || patch.draft !== undefined || patch.decision !== undefined;
    // Absent (undefined) patch fields never clobber existing draft values;
    // explicit null clears a field.
    const providedDraftFields = Object.fromEntries(
      Object.entries(patch.draft ?? {}).filter(([, value]) => value !== undefined),
    );
    const baseDraft = resetsDraft ? emptyDraft() : workspace.draft;
    const draft: TaskDraft = {
      ...baseDraft,
      ...providedDraftFields,
      draftRevision: draftChanged
        ? workspace.draft.draftRevision + 1
        : workspace.draft.draftRevision,
      decisionLog:
        patch.decision === undefined
          ? baseDraft.decisionLog
          : [...baseDraft.decisionLog, patch.decision].slice(-100),
    };
    const next: ConversationWorkspace = {
      ...workspace,
      revision: workspace.revision + 1,
      activeProjectId:
        patch.activeProjectId === undefined ? workspace.activeProjectId : patch.activeProjectId,
      activeThreadId:
        patch.activeThreadId === undefined ? workspace.activeThreadId : patch.activeThreadId,
      referencedThreadIds: patch.referencedThreadIds ?? workspace.referencedThreadIds,
      evidenceRefs: (patch.evidenceRefs ?? workspace.evidenceRefs).slice(-64),
      pendingQuestions: patch.pendingQuestions ?? workspace.pendingQuestions,
      draft,
      updatedAt: nowIso(),
    };
    this.commitOperation(operationId, next);
    return next;
  }

  /** Explicit state transitions; a transition never creates a T3 task. */
  transition(
    workspaceId: string,
    expectedRevision: number,
    operationId: string,
    target: WorkspaceState,
  ): ConversationWorkspace {
    const replayed = this.replay(workspaceId, operationId);
    if (replayed !== null) return replayed;
    const workspace = this.get(workspaceId);
    if (workspace.revision !== expectedRevision) throw new WorkspaceError("stale_revision");
    if (!STATE_TRANSITIONS[workspace.state].includes(target)) {
      throw new WorkspaceError("invalid_transition");
    }
    const next: ConversationWorkspace = {
      ...workspace,
      revision: workspace.revision + 1,
      state: target,
      updatedAt: nowIso(),
    };
    this.commitOperation(operationId, next);
    return next;
  }

  /**
   * Default session strategy: prefer the validated active thread; fork for
   * independent investigation; create only without suitable context or on an
   * explicit clean-session request.
   */
  decideSessionStrategy(
    workspace: ConversationWorkspace,
    options: {
      readonly independentInvestigation?: boolean;
      readonly cleanSessionRequested?: boolean;
    } = {},
  ): "reuse" | "fork" | "create" {
    if (options.cleanSessionRequested === true) return "create";
    const active = this.activeThread(workspace);
    if (active === undefined) return "create";
    if (options.independentInvestigation === true) return "fork";
    return "reuse";
  }

  /**
   * Materialize the approved draft into exactly one T3 execution. The natural
   * authorization is single-use and bound to the workspace, draft revision,
   * and action digest; a materially changed draft can never ride on an old
   * commitment.
   */
  async materialize(
    workspaceId: string,
    expectedRevision: number,
    operationId: string,
    authorization: {
      readonly utterance: string;
      readonly draftRevision: number;
    },
    execution: {
      readonly mode: "create" | "reuse" | "fork";
      readonly commandId: string;
      readonly threadId: string;
      readonly messageId: string;
    },
  ): Promise<{
    readonly workspace: ConversationWorkspace;
    readonly result: CanonicalCommandResult;
  }> {
    const workspace = this.get(workspaceId);
    // Crash-safe replay: an already applied materialize operation returns the
    // current state and never dispatches again.
    if (
      this.state.operations.some(([id, target]) => id === operationId && target === workspaceId)
    ) {
      const receipt = this.receiptForMaterialization(execution);
      if (receipt !== undefined) {
        return {
          workspace,
          result: { receipt, verification: { state: "not-applicable" }, thread: null },
        };
      }
      throw new WorkspaceError("already_materialized");
    }
    if (workspace.revision !== expectedRevision) throw new WorkspaceError("stale_revision");
    const draft = workspace.draft;
    if (authorization.draftRevision !== draft.draftRevision) {
      throw new WorkspaceError("authorization_stale");
    }
    if (workspace.linkedExecutions.some((linked) => linked.draftRevision === draft.draftRevision)) {
      throw new WorkspaceError("already_materialized");
    }
    const plan = this.buildMaterializationPlan(workspace, execution);
    const digest = sha256(stableStringify({ plan, workspaceId }));
    const authorizationKey = `${workspaceId}:${String(draft.draftRevision)}:${digest}`;
    if (this.state.consumedAuthorizations.includes(authorizationKey)) {
      throw new WorkspaceError("already_materialized");
    }

    const result: CanonicalCommandResult =
      plan.kind === "fork"
        ? {
            receipt: await this.commands.forkThread(plan.sourceThreadId, plan.request),
            verification: { state: "not-applicable" },
            thread: null,
          }
        : await this.commands.canonical(await decodeCanonicalCommand(plan.command), {
            operationId,
            workspaceId,
            draftRevision: draft.draftRevision,
          });
    if (result.receipt.status !== "accepted" && result.receipt.status !== "completed") {
      // Partial failure: the commitment stays unconsumed, no execution is
      // linked, the draft remains ready, and nothing is left half-created
      // (creates go through the atomic bootstrap).
      return { workspace, result };
    }
    this.state = {
      ...this.state,
      consumedAuthorizations: [...this.state.consumedAuthorizations, authorizationKey].slice(
        -MAX_OPERATIONS,
      ),
    };
    const linked: LinkedExecution = {
      threadId: execution.threadId,
      commandId: execution.commandId,
      draftRevision: draft.draftRevision,
      mode: execution.mode,
      materializedAt: nowIso(),
    };
    const next: ConversationWorkspace = {
      ...workspace,
      revision: workspace.revision + 1,
      state: "executing",
      activeProjectId: workspace.activeProjectId ?? draft.targetProjectId,
      activeThreadId: execution.threadId,
      draft: {
        ...draft,
        // After the atomic first turn succeeds, the new thread is the
        // conversation's authoritative continuation target. Leaving the
        // pre-execution `create` strategy behind would make the next spoken
        // follow-up create another thread instead of continuing this one.
        targetThreadId: execution.threadId,
        sessionStrategy: "reuse",
      },
      linkedExecutions: [...workspace.linkedExecutions, linked],
      updatedAt: nowIso(),
    };
    this.commitOperation(operationId, next);
    return { workspace: next, result };
  }

  pendingResults(workspaceId: string): ReadonlyArray<PendingExecutionResult> {
    this.get(workspaceId);
    return (this.state.pendingResults ?? []).filter((result) => result.workspaceId === workspaceId);
  }

  /** Deliver a pending result exactly once. */
  acknowledgeResult(workspaceId: string, threadId: string): PendingExecutionResult {
    const pending = (this.state.pendingResults ?? []).find(
      (result) =>
        result.workspaceId === workspaceId &&
        result.threadId === threadId &&
        result.deliveredAt === null,
    );
    if (pending === undefined) throw new WorkspaceError("not_found");
    const delivered: PendingExecutionResult = { ...pending, deliveredAt: nowIso() };
    this.state = {
      ...this.state,
      pendingResults: (this.state.pendingResults ?? []).map((result) =>
        result === pending ? delivered : result,
      ),
    };
    this.persist();
    return delivered;
  }

  /**
   * Continue work in the validated active session. Model, options, and modes
   * come from the thread's authoritative current state unless the user
   * explicitly changes them — follow-ups never drift to another provider.
   */
  async followUp(
    workspaceId: string,
    expectedRevision: number,
    operationId: string,
    request: {
      readonly commandId: string;
      readonly messageId: string;
      readonly text: string;
      readonly modelSelection?: { readonly instanceId: string; readonly model: string } | undefined;
      readonly runtimeMode?: string | undefined;
      readonly interactionMode?: string | undefined;
    },
  ): Promise<{
    readonly workspace: ConversationWorkspace;
    readonly result: CanonicalCommandResult;
  }> {
    const workspace = this.get(workspaceId);
    if (
      this.state.operations.some(([id, target]) => id === operationId && target === workspaceId)
    ) {
      const receipt = this.commands.receiptFor(request.commandId);
      if (receipt !== undefined) {
        return {
          workspace,
          result: { receipt, verification: { state: "not-applicable" }, thread: null },
        };
      }
    }
    if (workspace.revision !== expectedRevision) throw new WorkspaceError("stale_revision");
    const threadId = workspace.activeThreadId;
    if (threadId === null) throw new WorkspaceError("draft_incomplete");
    const thread = this.snapshotThreads().find(
      (candidate) => candidate.id === threadId && candidate.freshness === "live",
    );
    if (thread === undefined) throw new WorkspaceError("draft_incomplete");
    const command = await decodeCanonicalCommand({
      type: "thread.turn.start",
      commandId: request.commandId,
      threadId,
      message: {
        messageId: request.messageId,
        role: "user",
        text: request.text,
        attachments: [],
      },
      modelSelection: request.modelSelection ?? {
        instanceId: thread.providerInstanceId,
        model: thread.model,
      },
      runtimeMode: request.runtimeMode ?? thread.runtimeMode,
      interactionMode: request.interactionMode ?? thread.interactionMode,
      createdAt: nowIso(),
    });
    const result = await this.commands.canonical(command, { operationId, workspaceId });
    if (result.receipt.status !== "accepted" && result.receipt.status !== "completed") {
      return { workspace, result };
    }
    const linked: LinkedExecution = {
      threadId,
      commandId: request.commandId,
      draftRevision: workspace.draft.draftRevision,
      mode: "reuse",
      materializedAt: nowIso(),
    };
    const next: ConversationWorkspace = {
      ...workspace,
      revision: workspace.revision + 1,
      state: workspace.state === "closed" ? workspace.state : "executing",
      linkedExecutions: [...workspace.linkedExecutions, linked].slice(-32),
      updatedAt: nowIso(),
    };
    this.commitOperation(operationId, next);
    return { workspace: next, result };
  }

  private onExecutionEvent(event: {
    readonly type: string;
    readonly sequence: number;
    readonly threadId?: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }): void {
    const threadId = event.threadId;
    if (threadId === undefined) return;
    if (event.type.startsWith("workspace.")) return;
    for (const workspace of this.state.workspaces) {
      const linked = workspace.linkedExecutions.find(
        (execution) => execution.threadId === threadId,
      );
      if (linked === undefined) continue;
      const status = (event.payload as { readonly status?: string }).status;
      const kind =
        status === "completed"
          ? "final"
          : status === "failed"
            ? "failure"
            : status === "waiting_for_approval" || status === "waiting_for_input"
              ? "interaction"
              : "activity";
      this.store.emitExternalEvent(
        "workspace.execution",
        `workspace-execution:${workspace.workspaceId}:${threadId}:${String(event.sequence)}`,
        {
          threadId,
          freshness: "live",
          payload: {
            workspaceId: workspace.workspaceId,
            threadId,
            commandId: linked.commandId,
            draftRevision: linked.draftRevision,
            kind,
            ...(status === undefined ? {} : { status }),
          },
        },
      );
      if (kind === "final" || kind === "failure") {
        this.recordPendingResult(workspace.workspaceId, threadId, kind);
        this.noteExecutionSettled(workspace.workspaceId);
      }
    }
  }

  private recordPendingResult(
    workspaceId: string,
    threadId: string,
    kind: "final" | "failure",
  ): void {
    const pending = this.state.pendingResults ?? [];
    // Duplicate terminal events for the same undelivered result are dropped:
    // one T3 turn produces one substantive spoken result.
    const existing = pending.find(
      (result) =>
        result.workspaceId === workspaceId &&
        result.threadId === threadId &&
        result.deliveredAt === null,
    );
    if (existing !== undefined) return;
    this.state = {
      ...this.state,
      pendingResults: [
        ...pending,
        { workspaceId, threadId, kind, createdAt: nowIso(), deliveredAt: null },
      ].slice(-64),
    };
    this.persist();
  }

  private noteExecutionSettled(workspaceId: string): void {
    const workspace = this.state.workspaces.find(
      (candidate) => candidate.workspaceId === workspaceId,
    );
    if (workspace === undefined || workspace.state !== "executing") return;
    const next: ConversationWorkspace = {
      ...workspace,
      revision: workspace.revision + 1,
      state: "monitoring",
      updatedAt: nowIso(),
    };
    this.replaceWorkspace(next);
    this.emit(next, "workspace.updated");
  }

  private buildMaterializationPlan(
    workspace: ConversationWorkspace,
    execution: {
      readonly mode: "create" | "reuse" | "fork";
      readonly commandId: string;
      readonly threadId: string;
      readonly messageId: string;
    },
  ): MaterializationPlan {
    const draft = workspace.draft;
    const prompt = compileProviderPrompt(draft);
    const runtimeMode = draft.runtimeMode ?? "approval-required";
    const interactionMode = draft.interactionMode ?? "default";
    if (execution.mode === "fork") {
      const targetThreadId = draft.targetThreadId ?? workspace.activeThreadId;
      if (targetThreadId === null || targetThreadId === execution.threadId) {
        throw new WorkspaceError("draft_incomplete");
      }
      const request = {
        commandId: execution.commandId,
        threadId: execution.threadId,
        messageId: execution.messageId,
        title: (draft.goal ?? "Independent investigation").slice(0, 300),
        text: prompt,
        ...(draft.modelSelection === null ? {} : { modelSelection: draft.modelSelection }),
        runtimeMode: asRuntimeMode(runtimeMode),
        interactionMode: asInteractionMode(interactionMode),
      };
      return { kind: "fork", sourceThreadId: targetThreadId, request };
    }
    if (execution.mode === "reuse") {
      const targetThreadId = draft.targetThreadId ?? workspace.activeThreadId;
      if (targetThreadId === null || targetThreadId !== execution.threadId) {
        throw new WorkspaceError("draft_incomplete");
      }
      return {
        kind: "canonical",
        command: {
          type: "thread.turn.start",
          commandId: execution.commandId,
          threadId: execution.threadId,
          message: {
            messageId: execution.messageId,
            role: "user",
            text: prompt,
            attachments: [],
          },
          ...(draft.modelSelection === null ? {} : { modelSelection: draft.modelSelection }),
          runtimeMode,
          interactionMode,
          createdAt: nowIso(),
        },
      };
    }
    if (draft.targetProjectId === null || draft.modelSelection === null) {
      throw new WorkspaceError("draft_incomplete");
    }
    // Atomic bootstrap: thread plus first turn in one canonical command; a
    // failed first turn never leaves an empty session behind.
    return {
      kind: "canonical",
      command: {
        type: "thread.turn.start",
        commandId: execution.commandId,
        threadId: execution.threadId,
        message: {
          messageId: execution.messageId,
          role: "user",
          text: prompt,
          attachments: [],
        },
        modelSelection: draft.modelSelection,
        runtimeMode,
        interactionMode,
        ...(draft.goal === null ? {} : { titleSeed: draft.goal.slice(0, 120) }),
        bootstrap: {
          createThread: {
            projectId: draft.targetProjectId,
            title: draft.goal?.slice(0, 200) ?? "Conversation task",
            modelSelection: draft.modelSelection,
            runtimeMode,
            interactionMode,
            branch: draft.branch,
            // A conversational worktree intent is not a filesystem path. Only
            // an explicit absolute path may enter the canonical command; other
            // intents remain part of the provider prompt for T3 to resolve.
            worktreePath:
              draft.worktreeIntent?.startsWith("/") === true ? draft.worktreeIntent : null,
            createdAt: nowIso(),
          },
        },
        createdAt: nowIso(),
      },
    };
  }

  private receiptForMaterialization(execution: {
    readonly mode: "create" | "reuse" | "fork";
    readonly commandId: string;
  }) {
    if (execution.mode !== "fork") return this.commands.receiptFor(execution.commandId);
    return this.commands.receiptFor(childCommandId(execution.commandId, "turn"));
  }

  private activeThread(workspace: ConversationWorkspace) {
    const threadId = workspace.draft.targetThreadId ?? workspace.activeThreadId;
    if (threadId === null) return undefined;
    return this.snapshotThreads().find(
      (thread) => thread.id === threadId && thread.freshness === "live",
    );
  }

  private snapshotThreads(): BridgeSnapshot["threads"] {
    return this.store.snapshot().threads;
  }

  private replay(workspaceId: string, operationId: string): ConversationWorkspace | null {
    const record = this.state.operations.find(
      ([id, workspace]) => id === operationId && workspace === workspaceId,
    );
    if (record === undefined) return null;
    const workspace = this.get(workspaceId);
    // The operation already applied; serve the current state idempotently.
    return workspace;
  }

  private commitOperation(operationId: string, workspace: ConversationWorkspace): void {
    if (
      this.state.operations.some(
        ([id, target]) => id === operationId && target !== workspace.workspaceId,
      )
    ) {
      throw new WorkspaceError("operation_conflict");
    }
    this.state = {
      ...this.state,
      operations: [
        ...this.state.operations,
        [operationId, workspace.workspaceId, workspace.revision] as const,
      ].slice(-MAX_OPERATIONS),
    };
    this.replaceWorkspace(workspace);
    this.emit(workspace, "workspace.updated");
  }

  private replaceWorkspace(workspace: ConversationWorkspace): void {
    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map((candidate) =>
        candidate.workspaceId === workspace.workspaceId ? workspace : candidate,
      ),
    };
    this.persist();
  }

  private emit(workspace: ConversationWorkspace, type: string): void {
    this.store.emitExternalEvent(type, `${type}:${workspace.workspaceId}:${workspace.revision}`, {
      freshness: "live",
      payload: {
        workspaceId: workspace.workspaceId,
        revision: workspace.revision,
        state: workspace.state,
        draftRevision: workspace.draft.draftRevision,
        linkedExecutionCount: workspace.linkedExecutions.length,
      },
    });
  }

  private load(): PersistedWorkspaces {
    const empty: PersistedWorkspaces = {
      schemaVersion: 1,
      workspaces: [],
      operations: [],
      consumedAuthorizations: [],
    };
    if (this.filePath === null || !NodeFS.existsSync(this.filePath)) return empty;
    try {
      const parsed: unknown = JSON.parse(NodeFS.readFileSync(this.filePath, "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "schemaVersion" in parsed &&
        parsed.schemaVersion === 1
      ) {
        return parsed as PersistedWorkspaces;
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

const compileProviderPrompt = (draft: TaskDraft): string => {
  const primary = draft.providerPrompt?.trim() || draft.goal?.trim();
  if (primary === undefined || primary.length === 0) throw new WorkspaceError("draft_incomplete");

  // providerPrompt is the already compiled, standalone instruction. It is a
  // strict trust boundary: internal workspace history, evidence locators and
  // decision-log entries must never be appended to a fresh T3 session.
  if (draft.providerPrompt?.trim()) return primary.slice(0, 20_000);

  const sections: string[] = [`Auftrag:\n${primary}`];
  const addText = (heading: string, value: string | null): void => {
    const normalized = value?.trim();
    if (normalized !== undefined && normalized.length > 0) {
      sections.push(`${heading}:\n${normalized}`);
    }
  };
  const addList = (heading: string, values: ReadonlyArray<string>): void => {
    const normalized = values.map((value) => value.trim()).filter((value) => value.length > 0);
    if (normalized.length > 0)
      sections.push(`${heading}:\n${normalized.map((v) => `- ${v}`).join("\n")}`);
  };

  if (draft.providerPrompt !== null && draft.goal !== null && draft.goal.trim() !== primary) {
    addText("Ziel", draft.goal);
  }
  addText("Hintergrund", draft.background);
  addList("Umfang", draft.scope);
  addList("Randbedingungen", draft.constraints);
  addList("Akzeptanzkriterien", draft.acceptanceCriteria);
  addList("Noch offene Entscheidungen", draft.unresolvedDecisions);
  addList("Bekannte Risiken", draft.riskFlags);
  addText("Branch-Wunsch", draft.branch);
  if (draft.worktreeIntent?.startsWith("/") !== true) {
    addText("Worktree-Wunsch", draft.worktreeIntent);
  }

  return sections.join("\n\n").slice(0, 20_000);
};

const asRuntimeMode = (
  value: string,
): "approval-required" | "auto-accept-edits" | "auto" | "full-access" => {
  if (
    value === "approval-required" ||
    value === "auto-accept-edits" ||
    value === "auto" ||
    value === "full-access"
  ) {
    return value;
  }
  throw new WorkspaceError("draft_incomplete");
};

const asInteractionMode = (value: string): "default" | "plan" => {
  if (value === "default" || value === "plan") return value;
  throw new WorkspaceError("draft_incomplete");
};

const childCommandId = (commandId: string, suffix: string): string =>
  `${commandId.slice(0, Math.max(1, 159 - suffix.length))}:${suffix}`;

const sha256 = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};
