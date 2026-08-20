import NodeFs from "node:fs";
import NodeOS from "node:os";
import NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { BridgeCommandService, BridgeStore, type T3Client } from "@t3tools/bridge-client";
import { createInsaBridgeServer } from "./server.ts";

const TOKEN = "test-bearer-token-0123456789abcdef";

const offlineT3 = (): T3Client =>
  ({
    connected: () => false,
    threadOutput: () => Promise.reject(new Error("offline")),
    fullThreadDiff: () => Promise.reject(new Error("offline")),
  }) as unknown as T3Client;

async function startServer(t3: T3Client = offlineT3()) {
  const stateFile = NodePath.join(
    NodeFs.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "insa-bridge-")),
    "state.json",
  );
  const store = new BridgeStore(stateFile);
  const commands = new BridgeCommandService(store, t3);
  const server = createInsaBridgeServer({ store, commands, t3, bearerToken: TOKEN });
  const port = await server.listen(0);
  const call = (path: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${TOKEN}`, ...init?.headers },
    });
  return { server, store, call, port };
}

describe("insa-bridge server", () => {
  it("rejects requests without the bearer token", async () => {
    const { server, port } = await startServer();
    const response = await fetch(`http://127.0.0.1:${port}/v1/health`);
    expect(response.status).toBe(401);
    await server.close();
  });

  it("serves health and the cached mirror while T3 is offline", async () => {
    const { server, call } = await startServer();
    const health = await call("/v1/health");
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as { status: string; t3Connection: string };
    expect(healthBody.status).toBe("degraded");
    expect(healthBody.t3Connection).toBe("offline");

    const projects = await call("/v1/projects");
    expect(projects.status).toBe(200);
    expect(((await projects.json()) as { projects: unknown[] }).projects).toEqual([]);

    const threads = await call("/v1/threads?projectId=x");
    expect(threads.status).toBe(200);
    await server.close();
  });

  it("fails live routes and commands closed when T3 is offline", async () => {
    const { server, call } = await startServer();
    expect((await call("/v1/threads/t1/output")).status).toBe(503);
    const command = await call("/v1/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "thread.settle", threadId: "t1" }),
    });
    expect(command.status).toBe(503);
    await server.close();
  });

  it("rejects malformed commands with 422 when T3 is online", async () => {
    const onlineT3 = { ...offlineT3(), connected: () => true } as unknown as T3Client;
    const { server, call } = await startServer(onlineT3);
    const response = await call("/v1/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "definitely.not.a.command" }),
    });
    expect(response.status).toBe(422);
    await server.close();
  });
});
