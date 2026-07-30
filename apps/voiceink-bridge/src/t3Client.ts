import {
  bootstrapRemoteBearerSession,
  resolveRemoteWebSocketConnectionUrl,
} from "@t3tools/client-runtime/authorization";
import {
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import {
  remoteHttpClientLayer,
  type RpcSession,
  RpcSessionFactory,
  rpcSessionFactoryLayer,
} from "@t3tools/client-runtime/rpc";
import {
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";

import { isAttentionThread } from "./normalization.ts";
import type { T3BridgeCallbacks, T3ShellItem } from "./types.ts";

const httpLayer = remoteHttpClientLayer((input, init) => globalThis.fetch(input, init));
const rpcLayer = rpcSessionFactoryLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
const runtime = ManagedRuntime.make(Layer.merge(httpLayer, rpcLayer));
const decodeCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand, {
  onExcessProperty: "error",
});

export interface T3Client {
  readonly start: (afterSequence: number) => void;
  readonly stop: () => Promise<void>;
  readonly pair: (bootstrapCredential: string) => Promise<string>;
  readonly dispatch: (command: unknown) => Promise<{ readonly sequence: number }>;
  readonly fullThreadDiff: (
    threadId: string,
    toTurnCount: number,
  ) => Promise<{
    readonly diff: string;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
  }>;
  readonly connected: () => boolean;
}

export class EffectT3Client implements T3Client {
  private fiber: Fiber.Fiber<void, object> | null = null;
  private activeClient: RpcSession["client"] | null = null;
  private readonly httpBaseUrl: string;
  private readonly bearerToken: string;
  private readonly callbacks: T3BridgeCallbacks;

  constructor(httpBaseUrl: string, bearerToken: string, callbacks: T3BridgeCallbacks) {
    this.httpBaseUrl = httpBaseUrl;
    this.bearerToken = bearerToken;
    this.callbacks = callbacks;
  }

  start(afterSequence: number): void {
    if (this.fiber !== null) return;
    const bridge = this;
    let resumeSequence = afterSequence;

    const runOnce = Effect.scoped(
      Effect.gen(function* () {
        bridge.callbacks.onConnecting();
        const descriptor = yield* fetchRemoteEnvironmentDescriptor({
          httpBaseUrl: bridge.httpBaseUrl,
        });
        const wsBaseUrl = new URL(bridge.httpBaseUrl);
        wsBaseUrl.protocol = wsBaseUrl.protocol === "https:" ? "wss:" : "ws:";
        const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
          wsBaseUrl: wsBaseUrl.toString(),
          httpBaseUrl: bridge.httpBaseUrl,
          bearerToken: bridge.bearerToken,
        });
        const target = new PrimaryConnectionTarget({
          environmentId: descriptor.environmentId,
          label: descriptor.label,
          httpBaseUrl: bridge.httpBaseUrl,
          wsBaseUrl: wsBaseUrl.toString(),
        });
        const prepared: PreparedConnection = {
          environmentId: descriptor.environmentId,
          label: descriptor.label,
          httpBaseUrl: bridge.httpBaseUrl,
          socketUrl,
          httpAuthorization: { _tag: "Bearer", token: bridge.bearerToken },
          target,
        };
        const factory = yield* RpcSessionFactory;
        const session = yield* factory.connect(prepared);
        yield* session.ready;
        bridge.activeClient = session.client;
        bridge.callbacks.onConnected({
          id: descriptor.environmentId,
          label: descriptor.label,
          serverVersion: descriptor.serverVersion,
        });

        const watched = new Set<string>();
        const watchThread = Effect.fn("VoiceInkBridge.watchThread")(function* (
          thread: OrchestrationThreadShell,
        ) {
          if (!isAttentionThread(thread) || watched.has(thread.id)) return;
          watched.add(thread.id);
          yield* session.client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: thread.id,
            requestCompletionMarker: true,
          }).pipe(
            Stream.runForEach((item) =>
              Effect.sync(() => bridge.callbacks.onThreadItem(thread.id, item)),
            ),
            Effect.ensuring(Effect.sync(() => watched.delete(thread.id))),
            Effect.forkScoped,
          );
        });

        const handleShell = Effect.fn("VoiceInkBridge.handleShell")(function* (item: T3ShellItem) {
          bridge.callbacks.onShellItem(item);
          if (item.kind === "snapshot") {
            resumeSequence = item.snapshot.snapshotSequence;
            for (const thread of item.snapshot.threads) yield* watchThread(thread);
          } else if (
            item.kind === "project-upserted" ||
            item.kind === "project-removed" ||
            item.kind === "thread-removed"
          ) {
            resumeSequence = item.sequence;
          } else if (item.kind === "thread-upserted") {
            resumeSequence = item.sequence;
            yield* watchThread(item.thread);
          }
        });

        yield* session.client[ORCHESTRATION_WS_METHODS.subscribeShell]({
          ...(resumeSequence > 0 ? { afterSequence: resumeSequence } : {}),
          requestCompletionMarker: true,
        }).pipe(Stream.runForEach(handleShell));
      }),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          bridge.activeClient = null;
        }),
      ),
      Effect.tapError((error) =>
        Effect.sync(() => {
          bridge.callbacks.onDisconnected(connectionReason(error));
          resumeSequence = 0;
        }),
      ),
    );

    const reconnecting = runOnce.pipe(
      Effect.retry(Schedule.exponential("250 millis").pipe(Schedule.jittered)),
    );
    this.fiber = runtime.runFork(reconnecting);
  }

  async stop(): Promise<void> {
    const fiber = this.fiber;
    this.fiber = null;
    this.activeClient = null;
    if (fiber !== null) await runtime.runPromise(Fiber.interrupt(fiber));
  }

  async pair(bootstrapCredential: string): Promise<string> {
    const result = await runtime.runPromise(
      bootstrapRemoteBearerSession({
        httpBaseUrl: this.httpBaseUrl,
        credential: bootstrapCredential,
        scopes: ["orchestration:read", "orchestration:operate"],
        clientMetadata: {
          label: "VoiceInk T3 Bridge",
          deviceType: "bot",
          os: "macOS",
        },
      }),
    );
    return result.access_token;
  }

  async dispatch(command: unknown): Promise<{ readonly sequence: number }> {
    const active = this.activeClient;
    if (active === null) throw new Error("t3_unavailable");
    const decoded = await Effect.runPromise(decodeCommand(command));
    return runtime.runPromise(active[ORCHESTRATION_WS_METHODS.dispatchCommand](decoded));
  }

  async fullThreadDiff(
    threadId: string,
    toTurnCount: number,
  ): Promise<{
    readonly diff: string;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
  }> {
    const active = this.activeClient;
    if (active === null) throw new Error("t3_unavailable");
    return runtime.runPromise(
      active[ORCHESTRATION_WS_METHODS.getFullThreadDiff]({
        threadId: ThreadId.make(threadId),
        toTurnCount,
      }),
    );
  }

  connected(): boolean {
    return this.activeClient !== null;
  }
}

const connectionReason = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = error._tag;
    if (typeof tag === "string" && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(tag)) {
      return tag;
    }
  }
  return "connection_lost";
};
