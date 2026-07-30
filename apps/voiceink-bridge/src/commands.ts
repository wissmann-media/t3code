import * as NodeCrypto from "node:crypto";

import { nowIso } from "./time.ts";
import type {
  ApprovalResponseRequest,
  CreateProjectRequest,
  CreateThreadRequest,
  StartTurnRequest,
  ThreadCommandRequest,
  UserInputResponseRequest,
} from "./schemas.ts";
import { BridgeStore } from "./store.ts";
import type { T3Client } from "./t3Client.ts";
import type { CommandReceipt } from "./types.ts";

export class BridgeCommandError extends Error {
  readonly code:
    | "bridge_incompatible"
    | "command_conflict"
    | "not_found"
    | "not_managed"
    | "stale_state"
    | "t3_unavailable";

  constructor(code: BridgeCommandError["code"]) {
    super(code);
    this.code = code;
  }
}

export class BridgeCommandService {
  private readonly store: BridgeStore;
  private readonly t3: T3Client;

  constructor(store: BridgeStore, t3: T3Client) {
    this.store = store;
    this.t3 = t3;
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

  async createThread(request: CreateThreadRequest): Promise<CommandReceipt> {
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
    this.store.manageThread(request.threadId);
    return receipt;
  }

  async startTurn(threadId: string, request: StartTurnRequest): Promise<CommandReceipt> {
    this.requireManaged(threadId);
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

  async interrupt(threadId: string, request: ThreadCommandRequest): Promise<CommandReceipt> {
    this.requireManaged(threadId);
    return this.dispatch(request.commandId, request, {
      type: "thread.turn.interrupt",
      commandId: request.commandId,
      threadId,
      createdAt: nowIso(),
    });
  }

  async stop(threadId: string, request: ThreadCommandRequest): Promise<CommandReceipt> {
    this.requireManaged(threadId);
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
  ): Promise<CommandReceipt> {
    this.requireManaged(threadId);
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
  ): Promise<CommandReceipt> {
    this.requireManaged(threadId);
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
    this.requireFresh();
    if (!this.store.adoptThread(threadId)) throw new BridgeCommandError("not_found");
  }

  private requireManaged(threadId: string): void {
    this.requireFresh();
    if (!this.store.isManagedThread(threadId)) throw new BridgeCommandError("not_managed");
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
