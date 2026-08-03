import * as NodeFs from "node:fs";
import * as NodeUrl from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { buildCapabilityManifest, CANONICAL_COMMAND_TYPES } from "./capabilityManifest.ts";
import { BridgeStore } from "./store.ts";

const contractsSource = (): string =>
  NodeFs.readFileSync(
    NodeUrl.fileURLToPath(
      new URL("../../../packages/contracts/src/orchestration.ts", import.meta.url),
    ),
    "utf8",
  );

/** Union member schema names -> command type literals, parsed from contracts. */
const unionCommandLiterals = (source: string): string[] => {
  const union = source.match(
    /export const ClientOrchestrationCommand = Schema\.Union\(\[([^\]]+)\]\)/m,
  );
  const unionBody = union?.[1];
  expect(unionBody, "ClientOrchestrationCommand union not found").toBeTruthy();
  const members = unionBody!
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  const literals = new Map<string, string>();
  const pattern =
    /(?:export )?const (\w+) = Schema\.Struct\(\{\s*\n\s*type: Schema\.Literal\("([a-z.-]+)"\)/g;
  for (const match of source.matchAll(pattern)) literals.set(match[1]!, match[2]!);
  return members.map((member) => {
    const literal = literals.get(member);
    expect(literal, `cannot resolve type literal for ${member}`).toBeTruthy();
    return literal!;
  });
};

describe("capability manifest", () => {
  it("covers exactly the ClientOrchestrationCommand union", () => {
    const actual = unionCommandLiterals(contractsSource()).toSorted();
    const declared = [...CANONICAL_COMMAND_TYPES].toSorted();
    expect(declared).toEqual(actual);
  });

  it("serves a versioned manifest with risk metadata and availability", () => {
    const store = new BridgeStore();
    const manifest = buildCapabilityManifest(store);
    expect(manifest.manifestSchemaVersion).toBe("3.0.0");
    expect(manifest.apiVersion).toBe(3);
    expect(manifest.contractsDigestSource).toBe("contracts");
    expect(manifest.contractsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.commands).toHaveLength(CANONICAL_COMMAND_TYPES.size);
    for (const command of manifest.commands) {
      expect(command.idempotent).toBe(true);
      expect(command.requiredScope).toBe("orchestration:operate");
      expect(["mutation-low", "mutation-medium", "mutation-high"]).toContain(command.risk);
      // Disconnected store: nothing is available until T3 is live.
      expect(command.available).toBe(false);
    }
    const destructive = manifest.commands
      .filter((command) => command.destructive)
      .map((command) => command.command)
      .toSorted();
    expect(destructive).toEqual(["project.delete", "thread.checkpoint.revert", "thread.delete"]);
    expect(manifest.queries.map((query) => query.query)).toContain("orchestration.dispatchCommand");
  });
});
