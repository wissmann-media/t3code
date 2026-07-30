import type {
  OrchestrationProjectShell,
  OrchestrationThread,
  OrchestrationThreadShell,
} from "@t3tools/contracts";

export const BRIDGE_API_VERSION = 1;
export const BRIDGE_VERSION = "0.1.0";
export const STATUS_SCHEMA_VERSION = 1;

export type BridgeFreshness = "live" | "recent" | "stale" | "offline";
export type BridgeConnectionState = "connecting" | "live" | "stale" | "offline" | "error";

export interface BridgeProvider {
  readonly instanceId: string;
  readonly driver: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly state: "ready" | "warning" | "error" | "disabled";
  readonly authStatus: "authenticated" | "unauthenticated" | "unknown";
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly name: string;
    readonly isDefault: boolean;
  }>;
}

export interface BridgeEnvironment {
  readonly id: string;
  readonly label: string;
  readonly serverVersion: string;
  readonly connection: BridgeConnectionState;
  readonly freshness: BridgeFreshness;
  readonly lastConnectedAt: string | null;
  readonly lastSnapshotAt: string | null;
  readonly errorCode: string | null;
  readonly providers: ReadonlyArray<BridgeProvider>;
}

export interface BridgeProject {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly updatedAt: string;
  readonly freshness: BridgeFreshness;
}

export type BridgeThreadStatus =
  | "idle"
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "interrupted"
  | "stopped";

export interface BridgeThread {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly provider: string;
  readonly status: BridgeThreadStatus;
  readonly attention: "none" | "approval" | "input" | "failure";
  readonly outcome: "unknown" | "success" | "failure" | "cancelled";
  readonly updatedAt: string;
  readonly freshness: BridgeFreshness;
  readonly ownership: "t3code";
  readonly managed: boolean;
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

export interface BridgeThreadDetail {
  readonly threadId: string;
  readonly snapshotSequence: number;
  readonly checkpointCount: number;
  readonly latestAssistantText: string | null;
  readonly recentActivity: ReadonlyArray<{
    readonly id: string;
    readonly tone: "info" | "tool" | "approval" | "error";
    readonly kind: string;
    readonly summary: string;
    readonly createdAt: string;
    readonly requestId?: string;
  }>;
}

export interface BridgeSnapshot {
  readonly sourceCursor: number;
  readonly environment: BridgeEnvironment | null;
  readonly projects: ReadonlyArray<BridgeProject>;
  readonly threads: ReadonlyArray<BridgeThread>;
  readonly details: Readonly<Record<string, BridgeThreadDetail>>;
  readonly managedThreadIds: ReadonlyArray<string>;
}

export interface BridgeStatusEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly sequence: number;
  readonly environmentId: string;
  readonly projectId?: string;
  readonly threadId?: string;
  readonly provider?: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly freshness: BridgeFreshness;
  readonly source: {
    readonly system: "t3code";
    readonly authoritative: true;
    readonly ownership: "t3code";
  };
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface PersistedBridgeState {
  readonly schemaVersion: 1;
  readonly snapshot: BridgeSnapshot;
  readonly events: ReadonlyArray<BridgeStatusEvent>;
  readonly dedupeKeys: ReadonlyArray<readonly [string, number]>;
  readonly commandReceipts: ReadonlyArray<CommandReceiptRecord>;
}

export interface CommandReceipt {
  readonly schemaVersion: 1;
  readonly commandId: string;
  readonly status: "accepted" | "completed" | "rejected" | "unknown";
  readonly receivedAt: string;
  readonly externalId?: string;
  readonly reasonCode?: string;
  readonly sourceSequence?: number;
}

export interface CommandReceiptRecord {
  readonly digest: string;
  readonly receipt: CommandReceipt;
}

export interface T3BridgeCallbacks {
  readonly onConnecting: () => void;
  readonly onConnected: (environment: {
    readonly id: string;
    readonly label: string;
    readonly serverVersion: string;
    readonly providers: ReadonlyArray<BridgeProvider>;
  }) => void;
  readonly onDisconnected: (reason: string) => void;
  readonly onShellItem: (item: T3ShellItem) => void;
  readonly onThreadItem: (threadId: string, item: T3ThreadItem) => void;
}

export type T3ShellItem =
  | { readonly kind: "synchronized" }
  | {
      readonly kind: "snapshot";
      readonly snapshot: {
        readonly snapshotSequence: number;
        readonly projects: ReadonlyArray<OrchestrationProjectShell>;
        readonly threads: ReadonlyArray<OrchestrationThreadShell>;
        readonly updatedAt: string;
      };
    }
  | {
      readonly kind: "project-upserted";
      readonly sequence: number;
      readonly project: OrchestrationProjectShell;
    }
  | { readonly kind: "project-removed"; readonly sequence: number; readonly projectId: string }
  | {
      readonly kind: "thread-upserted";
      readonly sequence: number;
      readonly thread: OrchestrationThreadShell;
    }
  | { readonly kind: "thread-removed"; readonly sequence: number; readonly threadId: string };

export type T3ThreadItem =
  | { readonly kind: "synchronized" }
  | {
      readonly kind: "snapshot";
      readonly snapshot: {
        readonly snapshotSequence: number;
        readonly thread: OrchestrationThread;
      };
    }
  | {
      readonly kind: "event";
      readonly event: { readonly sequence: number; readonly type: string };
    };
