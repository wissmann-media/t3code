import type { OrchestrationProjectShell, OrchestrationThreadShell } from "@t3tools/contracts";

import type { BridgeFreshness, BridgeProject, BridgeThread, BridgeThreadStatus } from "./types.ts";

const providerName = (instanceId: string): string => {
  const normalized = instanceId.toLowerCase();
  for (const provider of ["codex", "claude", "cursor", "grok", "opencode"]) {
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
  updatedAt: project.updatedAt,
  freshness,
});

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
  };
};

export const isAttentionThread = (thread: OrchestrationThreadShell): boolean =>
  thread.hasPendingApprovals ||
  thread.hasPendingUserInput ||
  thread.session?.status === "starting" ||
  thread.session?.status === "running";
