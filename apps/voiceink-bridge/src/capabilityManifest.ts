import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeUrl from "node:url";

import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";

import type { BridgeStore } from "./store.ts";
import { BRIDGE_VERSION } from "./types.ts";

/**
 * Semantic version of the v3 capability manifest itself. Clients must compare
 * the major component and fail closed on a mismatch.
 */
export const MANIFEST_SCHEMA_VERSION = "3.0.0";
export const MANIFEST_SCHEMA_MAJOR = 3;

export type CommandRisk = "mutation-low" | "mutation-medium" | "mutation-high";

export interface CanonicalCommandCapability {
  readonly command: string;
  readonly schema: string;
  readonly risk: CommandRisk;
  readonly destructive: boolean;
  readonly idempotent: true;
  readonly requiredScope: "orchestration:operate";
  readonly providerDependency: boolean;
  readonly available: boolean;
}

export interface QueryCapability {
  readonly query: string;
  readonly availability: "supported" | "partial" | "planned";
  readonly transport: "http" | "sse" | "internal";
}

/**
 * Metadata for every member of the canonical `ClientOrchestrationCommand`
 * union. `capabilityManifest.test.ts` parses the contracts source and fails
 * when this table and the union drift apart, so the manifest served to
 * clients is exhaustively parity-tested against the contracts.
 */
const CANONICAL_COMMAND_METADATA: ReadonlyArray<
  Omit<CanonicalCommandCapability, "available" | "idempotent" | "requiredScope">
> = [
  {
    command: "project.create",
    schema: "ProjectCreateCommand",
    risk: "mutation-medium",
    destructive: false,
    providerDependency: false,
  },
  {
    command: "project.meta.update",
    schema: "ProjectMetaUpdateCommand",
    risk: "mutation-medium",
    destructive: false,
    providerDependency: false,
  },
  {
    command: "project.delete",
    schema: "ProjectDeleteCommand",
    risk: "mutation-high",
    destructive: true,
    providerDependency: false,
  },
  {
    command: "thread.create",
    schema: "ThreadCreateCommand",
    risk: "mutation-low",
    destructive: false,
    providerDependency: true,
  },
  {
    command: "thread.delete",
    schema: "ThreadDeleteCommand",
    risk: "mutation-high",
    destructive: true,
    providerDependency: false,
  },
  {
    command: "thread.archive",
    schema: "ThreadArchiveCommand",
    risk: "mutation-low",
    destructive: false,
    providerDependency: false,
  },
  {
    command: "thread.unarchive",
    schema: "ThreadUnarchiveCommand",
    risk: "mutation-low",
    destructive: false,
    providerDependency: false,
  },
  {
    command: "thread.settle",
    schema: "ThreadSettleCommand",
    risk: "mutation-low",
    destructive: false,
    providerDependency: false,
  },
  {
    command: "thread.unsettle",
    schema: "ThreadUnsettleCommand",
    risk: "mutation-low",
    destructive: false,
    providerDependency: false,
  },
  {
    command: "thread.snooze",
    schema: "ThreadSnoozeCommand",
    risk: "mutation-low",
    destructive: false,
    providerDependency: false,
  },
  {
    command: "thread.unsnooze",
    schema: "ThreadUnsnoozeCommand",
    risk: "mutation-low",
    destructive: false,
    providerDependency: false,
  },
  {
    command: "thread.meta.update",
    schema: "ThreadMetaUpdateCommand",
    risk: "mutation-medium",
    destructive: false,
    providerDependency: false,
  },
  {
    command: "thread.runtime-mode.set",
    schema: "ThreadRuntimeModeSetCommand",
    risk: "mutation-medium",
    destructive: false,
    providerDependency: false,
  },
  {
    command: "thread.interaction-mode.set",
    schema: "ThreadInteractionModeSetCommand",
    risk: "mutation-low",
    destructive: false,
    providerDependency: false,
  },
  {
    command: "thread.turn.start",
    schema: "ClientThreadTurnStartCommand",
    risk: "mutation-medium",
    destructive: false,
    providerDependency: true,
  },
  {
    command: "thread.turn.interrupt",
    schema: "ThreadTurnInterruptCommand",
    risk: "mutation-medium",
    destructive: false,
    providerDependency: true,
  },
  {
    command: "thread.approval.respond",
    schema: "ThreadApprovalRespondCommand",
    risk: "mutation-high",
    destructive: false,
    providerDependency: true,
  },
  {
    command: "thread.user-input.respond",
    schema: "ThreadUserInputRespondCommand",
    risk: "mutation-medium",
    destructive: false,
    providerDependency: true,
  },
  {
    command: "thread.checkpoint.revert",
    schema: "ThreadCheckpointRevertCommand",
    risk: "mutation-high",
    destructive: true,
    providerDependency: false,
  },
  {
    command: "thread.session.stop",
    schema: "ThreadSessionStopCommand",
    risk: "mutation-high",
    destructive: false,
    providerDependency: false,
  },
] as const;

export const CANONICAL_COMMAND_TYPES: ReadonlySet<string> = new Set(
  CANONICAL_COMMAND_METADATA.map((entry) => entry.command),
);

export const DESTRUCTIVE_COMMAND_TYPES: ReadonlySet<string> = new Set(
  CANONICAL_COMMAND_METADATA.filter((entry) => entry.destructive).map((entry) => entry.command),
);

const QUERY_METADATA: ReadonlyArray<QueryCapability> = [
  { query: ORCHESTRATION_WS_METHODS.dispatchCommand, availability: "supported", transport: "http" },
  {
    query: ORCHESTRATION_WS_METHODS.getFullThreadDiff,
    availability: "supported",
    transport: "http",
  },
  { query: ORCHESTRATION_WS_METHODS.getTurnDiff, availability: "supported", transport: "http" },
  { query: ORCHESTRATION_WS_METHODS.searchThreads, availability: "supported", transport: "http" },
  {
    query: ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
    availability: "supported",
    transport: "http",
  },
  { query: ORCHESTRATION_WS_METHODS.subscribeShell, availability: "partial", transport: "sse" },
  { query: ORCHESTRATION_WS_METHODS.subscribeThread, availability: "partial", transport: "sse" },
  { query: "ws.subscribeServerConfig", availability: "partial", transport: "sse" },
];

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

const sha256 = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

/**
 * Digest of the canonical contracts source. The Bridge always runs inside the
 * pinned T3 fork (ADR: docs/decisions/0001-bridge-placement.md), so the source
 * is normally readable; when it is not, the digest falls back to the metadata
 * table so it stays stable rather than failing open.
 */
const computeContractsDigest = (): { readonly digest: string; readonly source: string } => {
  try {
    const contractsPath = NodeUrl.fileURLToPath(
      new URL("../../../packages/contracts/src/orchestration.ts", import.meta.url),
    );
    return { digest: sha256(NodeFs.readFileSync(contractsPath, "utf8")), source: "contracts" };
  } catch {
    return { digest: sha256(stableStringify(CANONICAL_COMMAND_METADATA)), source: "table" };
  }
};

const contractsDigest = computeContractsDigest();

export interface ClientCapabilityManifest {
  readonly manifestSchemaVersion: string;
  readonly apiVersion: 3;
  readonly bridgeVersion: string;
  readonly contractsDigest: string;
  readonly contractsDigestSource: string;
  readonly commands: ReadonlyArray<CanonicalCommandCapability>;
  readonly queries: ReadonlyArray<QueryCapability>;
  readonly environment: {
    readonly id: string | null;
    readonly connection: string;
    readonly freshness: string;
  };
  readonly providers: ReadonlyArray<unknown>;
}

export const buildCapabilityManifest = (store: BridgeStore): ClientCapabilityManifest => {
  const snapshot = store.snapshot();
  const connected = snapshot.environment?.connection === "live";
  return {
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    apiVersion: 3,
    bridgeVersion: BRIDGE_VERSION,
    contractsDigest: contractsDigest.digest,
    contractsDigestSource: contractsDigest.source,
    commands: CANONICAL_COMMAND_METADATA.map((entry) => ({
      ...entry,
      idempotent: true,
      requiredScope: "orchestration:operate",
      available: connected,
    })),
    queries: QUERY_METADATA,
    environment: {
      id: snapshot.environment?.id ?? null,
      connection: snapshot.environment?.connection ?? "offline",
      freshness: snapshot.environment?.freshness ?? "offline",
    },
    providers: snapshot.environment?.providers ?? [],
  };
};
