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
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type OrchestrationThreadSearchMatch,
  type OrchestrationThreadShell,
  type ServerProvider,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";

import { isAttentionThread } from "./normalization.ts";
import { normalizeThreadOutput } from "./normalization.ts";
import type {
  BridgeProvider,
  BridgeThreadOutput,
  T3BridgeCallbacks,
  T3ShellItem,
} from "./types.ts";

const httpLayer = remoteHttpClientLayer((input, init) => globalThis.fetch(input, init));
const rpcLayer = rpcSessionFactoryLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
const runtime = ManagedRuntime.make(Layer.merge(httpLayer, rpcLayer));
const decodeCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand, {
  onExcessProperty: "error",
});

const normalizeProviders = (
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<BridgeProvider> =>
  providers.map((provider) => ({
    instanceId: provider.instanceId,
    driver: provider.driver,
    ...(provider.displayName === undefined ? {} : { displayName: provider.displayName }),
    version: provider.version,
    ...(provider.availability === undefined ? {} : { availability: provider.availability }),
    ...(provider.unavailableReason === undefined
      ? {}
      : { unavailableReason: provider.unavailableReason }),
    ...(provider.showInteractionModeToggle === undefined
      ? {}
      : { showInteractionModeToggle: provider.showInteractionModeToggle }),
    ...(provider.requiresNewThreadForModelChange === undefined
      ? {}
      : { requiresNewThreadForModelChange: provider.requiresNewThreadForModelChange }),
    enabled: provider.enabled,
    installed: provider.installed,
    state: provider.status,
    authStatus: provider.auth.status,
    models: provider.models.map((model) => ({
      slug: model.slug,
      name: model.name,
      ...(model.shortName === undefined ? {} : { shortName: model.shortName }),
      isCustom: model.isCustom,
      isDefault: model.isDefault === true,
      ...(model.capabilities === null ? {} : { capabilities: model.capabilities }),
    })),
  }));

export interface T3Client {
  readonly start: (afterSequence: number, attentionThreadIds?: ReadonlyArray<string>) => void;
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
  readonly threadOutput: (threadId: string) => Promise<BridgeThreadOutput>;
  readonly refreshThread: (threadId: string) => Promise<void>;
  /** Authoritative full thread detail, fetched on demand and never persisted. */
  readonly threadDetail: (threadId: string) => Promise<OrchestrationThread>;
  readonly searchThreads: (
    query: string,
    limit?: number,
  ) => Promise<ReadonlyArray<OrchestrationThreadSearchMatch>>;
  readonly turnDiff: (
    threadId: string,
    fromTurnCount: number,
    toTurnCount: number,
    ignoreWhitespace?: boolean,
  ) => Promise<{
    readonly diff: string;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
  }>;
  readonly archivedShellSnapshot: () => Promise<OrchestrationShellSnapshot>;
  /** Dynamically retain a full thread event stream beyond attention threads. */
  readonly retainThread: (threadId: string) => void;
  readonly releaseThread: (threadId: string) => void;
  readonly retainedThreadIds: () => ReadonlyArray<string>;
  readonly connected: () => boolean;
}

export class EffectT3Client implements T3Client {
  private fiber: Fiber.Fiber<void, object> | null = null;
  private activeClient: RpcSession["client"] | null = null;
  private readonly httpBaseUrl: string;
  private readonly bearerToken: string;
  private readonly callbacks: T3BridgeCallbacks;
  /** Thread IDs with a live detail subscription (attention or retained). */
  private readonly watched = new Set<string>();
  /** Conversation-relevant thread IDs to keep subscribed across reconnects. */
  private readonly retained = new Set<string>();
  private readonly dynamicFibers = new Map<string, Fiber.Fiber<unknown, unknown>>();

  constructor(httpBaseUrl: string, bearerToken: string, callbacks: T3BridgeCallbacks) {
    this.httpBaseUrl = httpBaseUrl;
    this.bearerToken = bearerToken;
    this.callbacks = callbacks;
  }

  start(afterSequence: number, attentionThreadIds: ReadonlyArray<string> = []): void {
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
        const config = yield* session.initialConfig;
        bridge.activeClient = session.client;
        bridge.callbacks.onConnected({
          id: descriptor.environmentId,
          label: descriptor.label,
          serverVersion: descriptor.serverVersion,
          providers: normalizeProviders(config.providers),
        });

        yield* session.client[WS_METHODS.subscribeServerConfig]({}).pipe(
          Stream.runForEach((event) => {
            if (event.type === "snapshot") {
              return Effect.sync(() =>
                bridge.callbacks.onProviderStatuses(normalizeProviders(event.config.providers)),
              );
            }
            if (event.type === "providerStatuses") {
              return Effect.sync(() =>
                bridge.callbacks.onProviderStatuses(normalizeProviders(event.payload.providers)),
              );
            }
            return Effect.void;
          }),
          Effect.forkScoped,
        );

        const watched = bridge.watched;
        watched.clear();
        const watchThreadId = Effect.fn("VoiceInkBridge.watchThreadId")(function* (
          threadId: string,
        ) {
          if (watched.has(threadId)) return;
          watched.add(threadId);
          yield* session.client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: ThreadId.make(threadId),
            requestCompletionMarker: true,
          }).pipe(
            Stream.runForEach((item) =>
              Effect.sync(() => bridge.callbacks.onThreadItem(threadId, item)),
            ),
            Effect.ensuring(Effect.sync(() => watched.delete(threadId))),
            Effect.forkScoped,
          );
        });
        const watchThread = Effect.fn("VoiceInkBridge.watchThread")(function* (
          thread: OrchestrationThreadShell,
        ) {
          if (!isAttentionThread(thread) && !bridge.retained.has(thread.id)) return;
          yield* watchThreadId(thread.id);
        });

        for (const threadId of [...attentionThreadIds, ...bridge.retained]) {
          yield* watchThreadId(threadId);
        }

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
          bridge.watched.clear();
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

  async threadOutput(threadId: string): Promise<BridgeThreadOutput> {
    const item = await this.fetchThreadSnapshot(threadId);
    if (item.kind !== "snapshot") throw new Error("thread_snapshot_unavailable");
    this.callbacks.onThreadItem(threadId, item);
    return normalizeThreadOutput(item.snapshot.thread);
  }

  async threadDetail(threadId: string): Promise<OrchestrationThread> {
    const item = await this.fetchThreadSnapshot(threadId);
    if (item.kind !== "snapshot") throw new Error("thread_snapshot_unavailable");
    this.callbacks.onThreadItem(threadId, item);
    return item.snapshot.thread;
  }

  async searchThreads(
    query: string,
    limit?: number,
  ): Promise<ReadonlyArray<OrchestrationThreadSearchMatch>> {
    const active = this.activeClient;
    if (active === null) throw new Error("t3_unavailable");
    const result = await runtime.runPromise(
      active[ORCHESTRATION_WS_METHODS.searchThreads]({
        query,
        ...(limit === undefined ? {} : { limit }),
      }),
    );
    return result.matches;
  }

  async turnDiff(
    threadId: string,
    fromTurnCount: number,
    toTurnCount: number,
    ignoreWhitespace?: boolean,
  ): Promise<{
    readonly diff: string;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
  }> {
    const active = this.activeClient;
    if (active === null) throw new Error("t3_unavailable");
    return runtime.runPromise(
      active[ORCHESTRATION_WS_METHODS.getTurnDiff]({
        threadId: ThreadId.make(threadId),
        fromTurnCount,
        toTurnCount,
        ...(ignoreWhitespace === undefined ? {} : { ignoreWhitespace }),
      }),
    );
  }

  async archivedShellSnapshot(): Promise<OrchestrationShellSnapshot> {
    const active = this.activeClient;
    if (active === null) throw new Error("t3_unavailable");
    return runtime.runPromise(active[ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]({}));
  }

  retainThread(threadId: string): void {
    this.retained.add(threadId);
    const active = this.activeClient;
    if (active === null || this.watched.has(threadId)) return;
    this.watched.add(threadId);
    const bridge = this;
    const fiber = runtime.runFork(
      active[ORCHESTRATION_WS_METHODS.subscribeThread]({
        threadId: ThreadId.make(threadId),
        requestCompletionMarker: true,
      }).pipe(
        Stream.runForEach((item) =>
          Effect.sync(() => bridge.callbacks.onThreadItem(threadId, item)),
        ),
        Effect.catch(() => Effect.void),
        Effect.ensuring(
          Effect.sync(() => {
            bridge.watched.delete(threadId);
            bridge.dynamicFibers.delete(threadId);
          }),
        ),
      ),
    );
    this.dynamicFibers.set(threadId, fiber);
  }

  releaseThread(threadId: string): void {
    this.retained.delete(threadId);
    const fiber = this.dynamicFibers.get(threadId);
    if (fiber !== undefined) {
      this.dynamicFibers.delete(threadId);
      runtime.runFork(Fiber.interrupt(fiber));
    }
  }

  retainedThreadIds(): ReadonlyArray<string> {
    return [...this.retained];
  }

  async refreshThread(threadId: string): Promise<void> {
    const item = await this.fetchThreadSnapshot(threadId);
    if (item.kind !== "snapshot") throw new Error("thread_snapshot_unavailable");
    this.callbacks.onThreadItem(threadId, item);
  }

  private async fetchThreadSnapshot(threadId: string) {
    const active = this.activeClient;
    if (active === null) throw new Error("t3_unavailable");
    return runtime.runPromise(
      active[ORCHESTRATION_WS_METHODS.subscribeThread]({
        threadId: ThreadId.make(threadId),
        requestCompletionMarker: false,
      }).pipe(
        Stream.filter((candidate) => candidate.kind === "snapshot"),
        Stream.runHead,
        Effect.timeout("6 seconds"),
        Effect.map(Option.getOrThrow),
      ),
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
