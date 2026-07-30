import * as Schema from "effect/Schema";

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240));
const CommandId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160));
const NonEmptyText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120_000));
const ModelSelection = Schema.Struct({
  instanceId: Identifier,
  model: Identifier,
  options: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
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
  branch: Schema.NullOr(Identifier),
  worktreePath: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
});

export const StartTurnRequest = Schema.Struct({
  ...CommandBase,
  messageId: Identifier,
  text: NonEmptyText,
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.Literals(["approval-required", "auto-accept-edits", "auto", "full-access"]),
  interactionMode: Schema.Literals(["default", "plan"]),
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
