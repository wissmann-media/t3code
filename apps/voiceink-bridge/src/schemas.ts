import { ClientOrchestrationCommand, ProviderOptionSelections } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240));
const CommandId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160));
const NonEmptyText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120_000));
const ModelSelection = Schema.Struct({
  instanceId: Identifier,
  model: Identifier,
  options: Schema.optional(ProviderOptionSelections),
});

const CommandBase = {
  commandId: CommandId,
} as const;

export const CreateProjectRequest = Schema.Struct({
  ...CommandBase,
  projectId: Identifier,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  workspaceRoot: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  createWorkspaceRootIfMissing: Schema.optional(Schema.Boolean),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
});

export const CreateThreadRequest = Schema.Struct({
  ...CommandBase,
  threadId: Identifier,
  projectId: Identifier,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  modelSelection: ModelSelection,
  runtimeMode: Schema.Literals(["approval-required", "auto-accept-edits", "auto", "full-access"]),
  interactionMode: Schema.Literals(["default", "plan"]),
  branch: Schema.optional(Schema.NullOr(Identifier)),
  worktreePath: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
  ),
});

export const StartTurnRequest = Schema.Struct({
  ...CommandBase,
  messageId: Identifier,
  text: NonEmptyText,
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.Literals(["approval-required", "auto-accept-edits", "auto", "full-access"]),
  interactionMode: Schema.Literals(["default", "plan"]),
});

export const ForkThreadRequest = Schema.Struct({
  ...CommandBase,
  threadId: Identifier,
  messageId: Identifier,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  text: NonEmptyText,
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(
    Schema.Literals(["approval-required", "auto-accept-edits", "auto", "full-access"]),
  ),
  interactionMode: Schema.optional(Schema.Literals(["default", "plan"])),
});

export const ThreadCommandRequest = Schema.Struct(CommandBase);

export const ApprovalResponseRequest = Schema.Struct({
  ...CommandBase,
  threadId: Identifier,
  decision: Schema.Literals(["accept", "acceptForSession", "decline", "cancel"]),
});

export const UserInputResponseRequest = Schema.Struct({
  ...CommandBase,
  threadId: Identifier,
  answers: Schema.Record(Schema.String, Schema.Unknown),
});

export const PairingRequest = Schema.Struct({
  code: Schema.String.check(Schema.isPattern(/^[0-9]{8}$/)),
});

export type CreateProjectRequest = typeof CreateProjectRequest.Type;
export type CreateThreadRequest = typeof CreateThreadRequest.Type;
export type StartTurnRequest = typeof StartTurnRequest.Type;
export type ForkThreadRequest = typeof ForkThreadRequest.Type;
export type ThreadCommandRequest = typeof ThreadCommandRequest.Type;
export type ApprovalResponseRequest = typeof ApprovalResponseRequest.Type;
export type UserInputResponseRequest = typeof UserInputResponseRequest.Type;

export const decodeCreateProject = Schema.decodeUnknownPromise(CreateProjectRequest, {
  onExcessProperty: "error",
});
export const decodeCreateThread = Schema.decodeUnknownPromise(CreateThreadRequest, {
  onExcessProperty: "error",
});
export const decodeStartTurn = Schema.decodeUnknownPromise(StartTurnRequest, {
  onExcessProperty: "error",
});
export const decodeForkThread = Schema.decodeUnknownPromise(ForkThreadRequest, {
  onExcessProperty: "error",
});
export const decodeThreadCommand = Schema.decodeUnknownPromise(ThreadCommandRequest, {
  onExcessProperty: "error",
});
export const decodeApprovalResponse = Schema.decodeUnknownPromise(ApprovalResponseRequest, {
  onExcessProperty: "error",
});
export const decodeUserInputResponse = Schema.decodeUnknownPromise(UserInputResponseRequest, {
  onExcessProperty: "error",
});
export const decodePairing = Schema.decodeUnknownPromise(PairingRequest, {
  onExcessProperty: "error",
});

/**
 * The complete canonical client command union, decoded strictly. Anything
 * outside the union — including server-internal commands — fails decoding and
 * never reaches dispatch.
 */
export const decodeCanonicalCommand = Schema.decodeUnknownPromise(ClientOrchestrationCommand, {
  onExcessProperty: "error",
});
export type CanonicalCommand = ClientOrchestrationCommand;

// Conversation workspace contracts (plan phase 4).

const BoundedText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000));
const BoundedTextArray = Schema.Array(BoundedText).check(Schema.isMaxLength(32));
const WorkspaceStateLiteral = Schema.Literals([
  "exploring",
  "shaping",
  "ready",
  "executing",
  "monitoring",
  "follow-up",
  "closed",
]);

export const WorkspaceCreateRequest = Schema.Struct({
  workspaceId: Identifier,
  clientId: Identifier,
});

const WorkspaceDraftPatch = Schema.Struct({
  goal: Schema.optional(Schema.NullOr(BoundedText)),
  background: Schema.optional(Schema.NullOr(BoundedText)),
  scope: Schema.optional(BoundedTextArray),
  constraints: Schema.optional(BoundedTextArray),
  targetProjectId: Schema.optional(Schema.NullOr(Identifier)),
  sessionStrategy: Schema.optional(Schema.NullOr(Schema.Literals(["reuse", "fork", "create"]))),
  targetThreadId: Schema.optional(Schema.NullOr(Identifier)),
  modelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  runtimeMode: Schema.optional(
    Schema.NullOr(
      Schema.Literals(["approval-required", "auto-accept-edits", "auto", "full-access"]),
    ),
  ),
  interactionMode: Schema.optional(Schema.NullOr(Schema.Literals(["default", "plan"]))),
  branch: Schema.optional(Schema.NullOr(Identifier)),
  worktreeIntent: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
  ),
  acceptanceCriteria: Schema.optional(BoundedTextArray),
  unresolvedDecisions: Schema.optional(BoundedTextArray),
  riskFlags: Schema.optional(BoundedTextArray),
  providerPrompt: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000))),
  ),
});

export const WorkspacePatchRequest = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  operationId: CommandId,
  activeProjectId: Schema.optional(Schema.NullOr(Identifier)),
  activeThreadId: Schema.optional(Schema.NullOr(Identifier)),
  referencedThreadIds: Schema.optional(Schema.Array(Identifier).check(Schema.isMaxLength(32))),
  pendingQuestions: Schema.optional(BoundedTextArray),
  draft: Schema.optional(WorkspaceDraftPatch),
  decision: Schema.optional(
    Schema.Struct({
      source: Schema.Literals(["user", "insa", "t3-evidence", "assumption"]),
      text: BoundedText,
    }),
  ),
});

export const WorkspaceTransitionRequest = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  operationId: CommandId,
  state: WorkspaceStateLiteral,
});

export const WorkspaceMaterializeRequest = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  operationId: CommandId,
  authorization: Schema.Struct({
    utterance: BoundedText,
    draftRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  execution: Schema.Struct({
    mode: Schema.Literals(["create", "reuse", "fork"]),
    commandId: CommandId,
    threadId: Identifier,
    messageId: Identifier,
  }),
});

export type WorkspaceCreateRequest = typeof WorkspaceCreateRequest.Type;
export type WorkspacePatchRequest = typeof WorkspacePatchRequest.Type;
export type WorkspaceTransitionRequest = typeof WorkspaceTransitionRequest.Type;
export type WorkspaceMaterializeRequest = typeof WorkspaceMaterializeRequest.Type;

export const decodeWorkspaceCreate = Schema.decodeUnknownPromise(WorkspaceCreateRequest, {
  onExcessProperty: "error",
});
export const decodeWorkspacePatch = Schema.decodeUnknownPromise(WorkspacePatchRequest, {
  onExcessProperty: "error",
});
export const decodeWorkspaceTransition = Schema.decodeUnknownPromise(WorkspaceTransitionRequest, {
  onExcessProperty: "error",
});
export const decodeWorkspaceMaterialize = Schema.decodeUnknownPromise(WorkspaceMaterializeRequest, {
  onExcessProperty: "error",
});

export const WorkspaceFollowUpRequest = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  operationId: CommandId,
  commandId: CommandId,
  messageId: Identifier,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120_000)),
  modelSelection: Schema.optional(Schema.Struct({ instanceId: Identifier, model: Identifier })),
  runtimeMode: Schema.optional(
    Schema.Literals(["approval-required", "auto-accept-edits", "auto", "full-access"]),
  ),
  interactionMode: Schema.optional(Schema.Literals(["default", "plan"])),
});
export type WorkspaceFollowUpRequest = typeof WorkspaceFollowUpRequest.Type;

export const decodeWorkspaceFollowUp = Schema.decodeUnknownPromise(WorkspaceFollowUpRequest, {
  onExcessProperty: "error",
});

// Consultation contracts (plan phase 6).

export const ConsultationStartRequest = Schema.Struct({
  consultationId: CommandId,
  workspaceId: Schema.optional(Identifier),
  projectId: Schema.optional(Identifier),
  sourceThreadId: Schema.optional(Identifier),
  question: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)),
  modelSelection: Schema.optional(Schema.Struct({ instanceId: Identifier, model: Identifier })),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 3_600_000 })),
  ),
});
export type ConsultationStartRequest = typeof ConsultationStartRequest.Type;

export const decodeConsultationStart = Schema.decodeUnknownPromise(ConsultationStartRequest, {
  onExcessProperty: "error",
});
