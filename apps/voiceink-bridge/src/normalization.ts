import type {
  OrchestrationProjectShell,
  OrchestrationThread,
  OrchestrationThreadShell,
} from "@t3tools/contracts";

import type {
  BridgeFreshness,
  BridgeProject,
  BridgeThread,
  BridgeThreadOutput,
  BridgeThreadStatus,
} from "./types.ts";

export const providerName = (instanceId: string): string => {
  const normalized = instanceId.toLowerCase();
  for (const provider of ["codex", "claude", "cursor", "gemini", "grok", "opencode"]) {
    if (normalized.includes(provider)) return provider;
  }
  return "unknown";
};

const statusFor = (thread: OrchestrationThreadShell): BridgeThreadStatus => {
  if (thread.hasPendingApprovals) return "waiting_for_approval";
  if (thread.hasPendingUserInput) return "waiting_for_input";
  const session = thread.session;
  if (session === null) {
    if (thread.latestTurn?.state === "completed") return "completed";
    if (thread.latestTurn?.state === "interrupted") return "interrupted";
    if (thread.latestTurn?.state === "error") return "failed";
    return "idle";
  }
  switch (session.status) {
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "stopped";
    case "error":
      return "failed";
    case "ready":
    case "idle":
      return thread.latestTurn?.state === "completed" ? "completed" : "idle";
  }
};

export const normalizeProject = (
  project: OrchestrationProjectShell,
  freshness: BridgeFreshness,
): BridgeProject => ({
  id: project.id,
  title: project.title,
  workspaceRoot: project.workspaceRoot,
  defaultProvider:
    project.defaultModelSelection === null
      ? null
      : providerName(project.defaultModelSelection.instanceId),
  updatedAt: project.updatedAt,
  freshness,
});

const MAX_ASSISTANT_OUTPUT_CHARS = 4_000;
const SECRET_PATTERNS = [
  /\b(?:sk|ghp|github_pat|glpat|xox[baprs])[-_A-Za-z0-9]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
] as const;

const redactOutput = (value: string): string => {
  let redacted = Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint === 9 ||
        codePoint === 10 ||
        codePoint === 13 ||
        (codePoint >= 32 && codePoint !== 127)
      );
    })
    .join("");
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted.trim();
};

export const normalizeThreadOutput = (thread: OrchestrationThread): BridgeThreadOutput => {
  const message = thread.messages
    .toReversed()
    .find((candidate) => candidate.role === "assistant" && candidate.text.trim().length > 0);
  if (message === undefined) {
    return {
      threadId: thread.id,
      projectId: thread.projectId,
      assistantText: null,
      createdAt: null,
      truncated: false,
      freshness: "live",
      ownership: "t3code",
    };
  }
  const safe = redactOutput(message.text);
  const truncated = safe.length > MAX_ASSISTANT_OUTPUT_CHARS;
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    assistantText: truncated ? `${safe.slice(0, MAX_ASSISTANT_OUTPUT_CHARS)}…` : safe,
    createdAt: message.createdAt,
    truncated,
    freshness: "live",
    ownership: "t3code",
  };
};

export const normalizeThread = (
  thread: OrchestrationThreadShell,
  freshness: BridgeFreshness,
  managed: boolean,
): BridgeThread => {
  const status = statusFor(thread);
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    provider: providerName(thread.modelSelection.instanceId),
    providerInstanceId: thread.modelSelection.instanceId,
    model: thread.modelSelection.model,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    status,
    attention:
      status === "waiting_for_approval"
        ? "approval"
        : status === "waiting_for_input"
          ? "input"
          : status === "failed"
            ? "failure"
            : "none",
    outcome:
      status === "completed"
        ? "success"
        : status === "failed"
          ? "failure"
          : status === "interrupted" || status === "stopped"
            ? "cancelled"
            : "unknown",
    updatedAt: thread.updatedAt,
    freshness,
    ownership: "t3code",
    managed,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    archivedAt: thread.archivedAt,
    settledOverride: thread.settledOverride,
    snoozedUntil: thread.snoozedUntil ?? null,
    hasActionableProposedPlan: thread.hasActionableProposedPlan,
    capabilities: [
      "read",
      "output",
      "diff",
      "turn",
      "interrupt",
      "stop",
      "approval",
      "input",
      "fork-contextual",
    ],
  };
};

export const isAttentionThread = (thread: OrchestrationThreadShell): boolean =>
  thread.hasPendingApprovals ||
  thread.hasPendingUserInput ||
  thread.session?.status === "starting" ||
  thread.session?.status === "running";
