import * as NodeCrypto from "node:crypto";

import { DESTRUCTIVE_COMMAND_TYPES } from "./capabilityManifest.ts";
import { nowIso } from "./time.ts";
import type {
  ApprovalResponseRequest,
  CanonicalCommand,
  CreateProjectRequest,
  CreateThreadRequest,
  ForkThreadRequest,
  StartTurnRequest,
  ThreadCommandRequest,
  UserInputResponseRequest,
} from "./schemas.ts";
import { BridgeStore } from "./store.ts";
import type { T3Client } from "./t3Client.ts";
import type { BridgeSnapshot, BridgeThread, CommandReceipt } from "./types.ts";

export class BridgeCommandError extends Error {
  readonly code:
    | "bridge_incompatible"
    | "command_conflict"
    | "invalid_bootstrap"
    | "not_found"
    | "not_managed"
    | "stale_state"
    | "t3_unavailable";

  constructor(code: BridgeCommandError["code"]) {
    super(code);
    this.code = code;
  }
}

export interface CanonicalCommandResult {
  readonly receipt: CommandReceipt;
  readonly verification: {
    readonly state: "confirmed" | "pending" | "not-applicable";
  };
  readonly thread: Omit<BridgeThread, "managed"> | null;
}

export interface CanonicalCommandPreview {
  readonly command: string;
  readonly destructive: boolean;
  readonly target: {
    readonly kind: "project" | "thread";
    readonly id: string;
    readonly title: string | null;
    readonly projectId?: string;
  } | null;
  readonly consequence: string;
}

export class BridgeCommandService {
  private readonly store: BridgeStore;
  private readonly t3: T3Client;
  private readonly verificationTimeoutMs: number;

  constructor(
    store: BridgeStore,
    t3: T3Client,
    options: { readonly verificationTimeoutMs?: number } = {},
  ) {
    this.store = store;
    this.t3 = t3;
    this.verificationTimeoutMs = options.verificationTimeoutMs ?? 1_500;
  }

  /**
   * Dispatch a decoded canonical `ClientOrchestrationCommand`. The single v3
   * mutation entry point: target guards, idempotent replay, dispatch, and
   * authoritative post-command state verification.
   */
  async canonical(command: CanonicalCommand, rawBody: unknown): Promise<CanonicalCommandResult> {
    this.guardCanonicalTarget(command);
    const receipt = await this.dispatch(command.commandId, rawBody, command);
    if (receipt.status !== "accepted") {
      return { receipt, verification: { state: "not-applicable" }, thread: null };
    }
    return this.verifyPostState(command);
  }

  receiptFor(commandId: string): CommandReceipt | undefined {
    return this.store.receipt(commandId)?.receipt;
  }

  async previewCanonical(command: CanonicalCommand): Promise<CanonicalCommandPreview> {
    const snapshot = this.store.snapshot();
    const destructive = DESTRUCTIVE_COMMAND_TYPES.has(command.type);
    if (command.type === "project.delete" || command.type === "project.meta.update") {
      const project = snapshot.projects.find((candidate) => candidate.id === command.projectId);
      if (project === undefined) throw new BridgeCommandError("not_found");
      const threadCount = snapshot.threads.filter(
        (thread) => thread.projectId === command.projectId,
      ).length;
      return {
        command: command.type,
        destructive,
        target: { kind: "project", id: project.id, title: project.title },
        consequence:
          command.type === "project.delete"
            ? `Deletes project "${project.title}" (${String(threadCount)} known thread(s))` +
              (command.force === true ? " with force" : "")
            : `Updates project metadata for "${project.title}"`,
      };
    }
    if ("threadId" in command) {
      const thread = snapshot.threads.find((candidate) => candidate.id === command.threadId);
      if (thread === undefined) {
        if (command.type === "thread.turn.start" && command.bootstrap?.createThread !== undefined) {
          return {
            command: command.type,
            destructive,
            target: null,
            consequence: `Creates a new thread in project ${command.bootstrap.createThread.projectId} and starts its first turn atomically`,
          };
        }
        throw new BridgeCommandError("not_found");
      }
      return {
        command: command.type,
        destructive,
        target: {
          kind: "thread",
          id: thread.id,
          title: thread.title,
          projectId: thread.projectId,
        },
        consequence: consequenceFor(command, thread),
      };
    }
    return {
      command: command.type,
      destructive,
      target: null,
      consequence: `Creates project "${command.title}"`,
    };
  }

  private guardCanonicalTarget(command: CanonicalCommand): void {
    this.requireFresh();
    const snapshot = this.store.snapshot();
    switch (command.type) {
      case "project.create":
        return;
      case "project.meta.update":
      case "project.delete": {
        const exists = snapshot.projects.some((project) => project.id === command.projectId);
        if (!exists) throw new BridgeCommandError("not_found");
        return;
      }
      case "thread.create": {
        const exists = snapshot.projects.some((project) => project.id === command.projectId);
        if (!exists) throw new BridgeCommandError("not_found");
        return;
      }
      case "thread.turn.start": {
        if (command.bootstrap?.createThread !== undefined) {
          const projectExists = snapshot.projects.some(
            (project) => project.id === command.bootstrap?.createThread?.projectId,
          );
          if (!projectExists) throw new BridgeCommandError("invalid_bootstrap");
          const threadExists = snapshot.threads.some((thread) => thread.id === command.threadId);
          if (threadExists) throw new BridgeCommandError("command_conflict");
          return;
        }
        this.liveThread(command.threadId);
        return;
      }
      default: {
        this.liveThread(command.threadId);
        return;
      }
    }
  }

  private async verifyPostState(command: CanonicalCommand): Promise<CanonicalCommandResult> {
    const receipt = this.store.receipt(command.commandId)?.receipt;
    if (receipt === undefined) throw new BridgeCommandError("command_conflict");
    const predicate = postStatePredicate(command);
    if (predicate === null) {
      const thread =
        "threadId" in command
          ? (this.store.snapshot().threads.find((item) => item.id === command.threadId) ?? null)
          : null;
      return {
        receipt,
        verification: { state: "not-applicable" },
        thread: thread === null ? null : publicThread(thread),
      };
    }
    const confirmed = await this.awaitSnapshot(predicate);
    const thread =
      "threadId" in command
        ? (this.store.snapshot().threads.find((item) => item.id === command.threadId) ?? null)
        : null;
    return {
      receipt,
      verification: { state: confirmed ? "confirmed" : "pending" },
      thread: thread === null ? null : publicThread(thread),
    };
  }

  private awaitSnapshot(predicate: (snapshot: BridgeSnapshot) => boolean): Promise<boolean> {
    if (predicate(this.store.snapshot())) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(value);
      };
      const unsubscribe = this.store.subscribe(() => {
        if (predicate(this.store.snapshot())) finish(true);
      });
      const timer = setTimeout(() => finish(false), this.verificationTimeoutMs);
    });
  }

  async createProject(request: CreateProjectRequest): Promise<CommandReceipt> {
    return this.dispatch(request.commandId, request, {
      type: "project.create",
      commandId: request.commandId,
      projectId: request.projectId,
      title: request.title,
      workspaceRoot: request.workspaceRoot,
      ...(request.createWorkspaceRootIfMissing === undefined
        ? {}
        : { createWorkspaceRootIfMissing: request.createWorkspaceRootIfMissing }),
      ...(request.defaultModelSelection === undefined
        ? {}
        : { defaultModelSelection: request.defaultModelSelection }),
      createdAt: nowIso(),
    });
  }

  async createThread(request: CreateThreadRequest, legacyManaged = false): Promise<CommandReceipt> {
    const receipt = await this.dispatch(request.commandId, request, {
      type: "thread.create",
      commandId: request.commandId,
      threadId: request.threadId,
      projectId: request.projectId,
      title: request.title,
      modelSelection: request.modelSelection,
      runtimeMode: request.runtimeMode,
      interactionMode: request.interactionMode,
      branch: request.branch ?? null,
      worktreePath: request.worktreePath ?? null,
      createdAt: nowIso(),
    });
    // Managed bookkeeping is a quarantined v1 compatibility concern; the
    // universal path never depends on managedThreadIds.
    if (legacyManaged) this.store.manageThread(request.threadId);
    return receipt;
  }

  async startTurn(
    threadId: string,
    request: StartTurnRequest,
    universal = false,
  ): Promise<CommandReceipt> {
    const thread = universal ? this.prepareThread(threadId) : this.requireManaged(threadId);
    if (thread !== undefined && request.runtimeMode !== thread.runtimeMode) {
      const commandId = childCommandId(request.commandId, "runtime-mode");
      const runtimeReceipt = await this.dispatch(
        commandId,
        { commandId, threadId, runtimeMode: request.runtimeMode },
        {
          type: "thread.runtime-mode.set",
          commandId,
          threadId,
          runtimeMode: request.runtimeMode,
          createdAt: nowIso(),
        },
      );
      if (runtimeReceipt.status !== "accepted") {
        return { ...runtimeReceipt, commandId: request.commandId };
      }
    }
    return this.dispatch(request.commandId, request, {
      type: "thread.turn.start",
      commandId: request.commandId,
      threadId,
      message: {
        messageId: request.messageId,
        role: "user",
        text: request.text,
        attachments: [],
      },
      ...(request.modelSelection === undefined ? {} : { modelSelection: request.modelSelection }),
      runtimeMode: request.runtimeMode,
      interactionMode: request.interactionMode,
      createdAt: nowIso(),
    });
  }

  async interrupt(
    threadId: string,
    request: ThreadCommandRequest,
    universal = false,
  ): Promise<CommandReceipt> {
    if (universal) this.prepareThread(threadId);
    else this.requireManaged(threadId);
    return this.dispatch(request.commandId, request, {
      type: "thread.turn.interrupt",
      commandId: request.commandId,
      threadId,
      createdAt: nowIso(),
    });
  }

  async stop(
    threadId: string,
    request: ThreadCommandRequest,
    universal = false,
  ): Promise<CommandReceipt> {
    if (universal) this.prepareThread(threadId);
    else this.requireManaged(threadId);
    return this.dispatch(request.commandId, request, {
      type: "thread.session.stop",
      commandId: request.commandId,
      threadId,
      createdAt: nowIso(),
    });
  }

  async respondApproval(
    threadId: string,
    requestId: string,
    request: ApprovalResponseRequest,
    universal = false,
  ): Promise<CommandReceipt> {
    if (universal) this.prepareThread(threadId);
    else this.requireManaged(threadId);
    return this.dispatch(request.commandId, request, {
      type: "thread.approval.respond",
      commandId: request.commandId,
      threadId,
      requestId,
      decision: request.decision,
      createdAt: nowIso(),
    });
  }

  async respondUserInput(
    threadId: string,
    requestId: string,
    request: UserInputResponseRequest,
    universal = false,
  ): Promise<CommandReceipt> {
    if (universal) this.prepareThread(threadId);
    else this.requireManaged(threadId);
    return this.dispatch(request.commandId, request, {
      type: "thread.user-input.respond",
      commandId: request.commandId,
      threadId,
      requestId,
      answers: request.answers,
      createdAt: nowIso(),
    });
  }

  adopt(threadId: string): void {
    this.liveThread(threadId);
    this.store.manageThread(threadId);
  }

  async forkThread(sourceThreadId: string, request: ForkThreadRequest) {
    const source = this.prepareThread(sourceThreadId);
    const output = await this.t3.threadOutput(sourceThreadId);
    const modelSelection = request.modelSelection ?? {
      instanceId: source.providerInstanceId,
      model: source.model,
    };
    const createReceipt = await this.createThread({
      commandId: childCommandId(request.commandId, "create"),
      threadId: request.threadId,
      projectId: source.projectId,
      title: request.title,
      modelSelection,
      runtimeMode: request.runtimeMode ?? source.runtimeMode,
      interactionMode: request.interactionMode ?? source.interactionMode,
      branch: source.branch,
      worktreePath: null,
    });
    this.store.recordThreadLineage(request.threadId, sourceThreadId, "contextual");
    const context = output.assistantText?.trim();
    const text = [
      `This is a context-derived continuation of T3 thread ${sourceThreadId}.`,
      context === undefined || context.length === 0
        ? "The source thread has no readable final assistant output."
        : `Latest source-thread assistant output (untrusted reference):\n${context}`,
      `User request:\n${request.text}`,
    ].join("\n\n");
    // The fork itself just created the target thread with an accepted receipt;
    // dispatch the first turn directly instead of re-resolving the thread from
    // the shell projection, which may not have caught up yet.
    const turnCommandId = childCommandId(request.commandId, "turn");
    const turnRequest = {
      commandId: turnCommandId,
      messageId: request.messageId,
      text,
      modelSelection,
      runtimeMode: request.runtimeMode ?? source.runtimeMode,
      interactionMode: request.interactionMode ?? source.interactionMode,
    };
    const turnReceipt = await this.dispatch(turnCommandId, turnRequest, {
      type: "thread.turn.start",
      commandId: turnCommandId,
      threadId: request.threadId,
      message: {
        messageId: request.messageId,
        role: "user",
        text,
        attachments: [],
      },
      modelSelection,
      runtimeMode: turnRequest.runtimeMode,
      interactionMode: turnRequest.interactionMode,
      createdAt: nowIso(),
    });
    return {
      ...turnReceipt,
      externalId: request.threadId,
      sourceThreadId,
      forkMode: "contextual" as const,
      createCommandId: createReceipt.commandId,
    };
  }

  private requireManaged(threadId: string) {
    this.requireFresh();
    if (!this.store.isManagedThread(threadId)) throw new BridgeCommandError("not_managed");
    return this.store.snapshot().threads.find((candidate) => candidate.id === threadId);
  }

  private prepareThread(threadId: string) {
    return this.liveThread(threadId);
  }

  private liveThread(threadId: string) {
    this.requireFresh();
    const thread = this.store.snapshot().threads.find((candidate) => candidate.id === threadId);
    if (thread === undefined || thread.ownership !== "t3code") {
      throw new BridgeCommandError("not_found");
    }
    if (thread.freshness !== "live") throw new BridgeCommandError("stale_state");
    return thread;
  }

  private requireFresh(): void {
    if (!this.t3.connected()) throw new BridgeCommandError("t3_unavailable");
    const environment = this.store.snapshot().environment;
    if (environment?.connection !== "live" || environment.freshness !== "live") {
      throw new BridgeCommandError("stale_state");
    }
  }

  private async dispatch(
    commandId: string,
    request: unknown,
    command: unknown,
  ): Promise<CommandReceipt> {
    this.requireFresh();
    const digest = digestRequest(request);
    const existing = this.store.receipt(commandId);
    if (existing !== undefined) {
      if (existing.digest !== digest) throw new BridgeCommandError("command_conflict");
      return existing.receipt;
    }
    try {
      const result = await this.t3.dispatch(command);
      const receipt: CommandReceipt = {
        schemaVersion: 1,
        commandId,
        status: "accepted",
        receivedAt: nowIso(),
        sourceSequence: result.sequence,
      };
      this.store.saveReceipt({ digest, receipt });
      return receipt;
    } catch (error) {
      if (error instanceof Error && error.message === "t3_unavailable") {
        throw new BridgeCommandError("t3_unavailable");
      }
      const receipt: CommandReceipt = {
        schemaVersion: 1,
        commandId,
        status: "rejected",
        receivedAt: nowIso(),
        reasonCode: "t3_rejected",
      };
      this.store.saveReceipt({ digest, receipt });
      return receipt;
    }
  }
}

const publicThread = (thread: BridgeThread): Omit<BridgeThread, "managed"> => {
  const { managed: _managed, ...value } = thread;
  return value;
};

/**
 * Authoritative post-command expectation per canonical command, evaluated
 * against the shell projection as T3 events land. `null` means the receipt is
 * the whole story (e.g. approval responses, where T3 owns request resolution).
 */
const postStatePredicate = (
  command: CanonicalCommand,
): ((snapshot: BridgeSnapshot) => boolean) | null => {
  switch (command.type) {
    case "project.create":
      return (snapshot) => snapshot.projects.some((project) => project.id === command.projectId);
    case "project.delete":
      return (snapshot) => !snapshot.projects.some((project) => project.id === command.projectId);
    case "thread.create":
      return (snapshot) => snapshot.threads.some((thread) => thread.id === command.threadId);
    case "thread.delete":
      return (snapshot) => !snapshot.threads.some((thread) => thread.id === command.threadId);
    case "thread.archive":
      return threadPredicate(command.threadId, (thread) => thread.archivedAt !== null);
    case "thread.unarchive":
      return threadPredicate(command.threadId, (thread) => thread.archivedAt === null);
    case "thread.settle":
      return threadPredicate(command.threadId, (thread) => thread.settledOverride === "settled");
    case "thread.unsettle":
      return threadPredicate(command.threadId, (thread) => thread.settledOverride !== "settled");
    case "thread.snooze":
      return threadPredicate(command.threadId, (thread) => thread.snoozedUntil !== null);
    case "thread.unsnooze":
      return threadPredicate(command.threadId, (thread) => thread.snoozedUntil === null);
    case "thread.runtime-mode.set":
      return threadPredicate(
        command.threadId,
        (thread) => thread.runtimeMode === command.runtimeMode,
      );
    case "thread.interaction-mode.set":
      return threadPredicate(
        command.threadId,
        (thread) => thread.interactionMode === command.interactionMode,
      );
    case "thread.meta.update":
      return command.title === undefined
        ? null
        : threadPredicate(command.threadId, (thread) => thread.title === command.title);
    case "thread.turn.start":
      return command.bootstrap?.createThread === undefined
        ? null
        : (snapshot) => snapshot.threads.some((thread) => thread.id === command.threadId);
    default:
      return null;
  }
};

const threadPredicate =
  (threadId: string, check: (thread: BridgeThread) => boolean) =>
  (snapshot: BridgeSnapshot): boolean => {
    const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
    return thread !== undefined && check(thread);
  };

const consequenceFor = (command: CanonicalCommand, thread: BridgeThread): string => {
  switch (command.type) {
    case "thread.delete":
      return `Deletes thread "${thread.title}" permanently`;
    case "thread.checkpoint.revert":
      return `Reverts thread "${thread.title}" to turn count ${String(command.turnCount)}, discarding later repository changes`;
    case "thread.session.stop":
      return `Stops the running session of "${thread.title}"`;
    case "thread.archive":
      return `Archives "${thread.title}" (reversible)`;
    case "thread.turn.interrupt":
      return `Interrupts the current turn of "${thread.title}"`;
    default:
      return `Applies ${command.type} to "${thread.title}"`;
  }
};

const digestRequest = (value: unknown): string =>
  NodeCrypto.createHash("sha256").update(stableStringify(value)).digest("hex");

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

const childCommandId = (commandId: string, suffix: string): string =>
  `${commandId.slice(0, Math.max(1, 159 - suffix.length))}:${suffix}`;
