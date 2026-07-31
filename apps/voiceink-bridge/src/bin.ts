import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { BridgeCommandService } from "./commands.ts";
import {
  ensureBridgeApiSecret,
  MacOSKeychainCredentialStore,
  t3BearerAccount,
} from "./credentials.ts";
import { createBridgeServer, BridgePairingSession } from "./server.ts";
import { BridgeStore, resumableShellCursor } from "./store.ts";
import { EffectT3Client } from "./t3Client.ts";
import type { BridgeEnvironment } from "./types.ts";

const run = async (): Promise<void> => {
  const args = parseArguments(process.argv.slice(2));
  const t3Url = normalizeLoopbackUrl(args.t3Url);
  const credentialStore = new MacOSKeychainCredentialStore();
  const bearerAccount = t3BearerAccount(t3Url);

  if (args.command === "pair-t3") {
    const bootstrapCredential = await readSecretFromStandardInput();
    const t3 = new EffectT3Client(t3Url, "", noOpCallbacks);
    const accessToken = await t3.pair(bootstrapCredential);
    await credentialStore.write(bearerAccount, accessToken);
    process.stdout.write("T3 pairing succeeded. The access token is stored in Keychain.\n");
    return;
  }

  const t3Bearer = await credentialStore.read(bearerAccount);
  if (t3Bearer === null) {
    throw new Error(
      "T3 is not paired. Pipe a one-time T3 credential into `voiceink-t3-bridge pair-t3`.",
    );
  }
  const bridgeBearer = await ensureBridgeApiSecret(credentialStore);
  const stateFile = NodePath.join(
    NodeOS.homedir(),
    "Library",
    "Application Support",
    "VoiceInk",
    "T3Bridge",
    "state.json",
  );
  const store = new BridgeStore(stateFile);
  const callbacks = {
    onConnecting: () => store.markConnecting(),
    onConnected: (environment: {
      readonly id: string;
      readonly label: string;
      readonly serverVersion: string;
      readonly providers: BridgeEnvironment["providers"];
    }) => store.markConnected(environment),
    onDisconnected: (reason: string) => store.markDisconnected(reason),
    onShellItem: (item: Parameters<BridgeStore["applyShellItem"]>[0]) => store.applyShellItem(item),
    onThreadItem: (threadId: string, item: Parameters<BridgeStore["applyThreadItem"]>[1]) =>
      store.applyThreadItem(threadId, item),
  };
  const t3 = new EffectT3Client(t3Url, t3Bearer, callbacks);
  const commands = new BridgeCommandService(store, t3);
  const pairing = new BridgePairingSession(bridgeBearer);
  const server = createBridgeServer({
    store,
    commands,
    t3,
    bearerToken: bridgeBearer,
    pairing,
  });

  await server.listen(args.port);
  const initialSnapshot = store.snapshot();
  t3.start(
    resumableShellCursor(initialSnapshot),
    initialSnapshot.threads
      .filter(
        (thread) =>
          thread.status === "starting" ||
          thread.status === "running" ||
          thread.status === "waiting_for_approval" ||
          thread.status === "waiting_for_input",
      )
      .map((thread) => thread.id),
  );
  process.stderr.write(`VoiceInk pairing code: ${pairing.code} (valid for five minutes)\n`);
  process.stdout.write(`VoiceInk T3 Bridge listening on http://127.0.0.1:${args.port}\n`);

  await new Promise<void>((resolve) => {
    const shutdown = () => resolve();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  await t3.stop();
  await server.close();
};

const noOpCallbacks = {
  onConnecting: () => {},
  onConnected: () => {},
  onDisconnected: () => {},
  onShellItem: () => {},
  onThreadItem: () => {},
};

const parseArguments = (
  values: ReadonlyArray<string>,
): { readonly command: "serve" | "pair-t3"; readonly t3Url: string; readonly port: number } => {
  let command: "serve" | "pair-t3" = "serve";
  let t3Url = "http://127.0.0.1:3773";
  let port = 9787;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "serve" || value === "pair-t3") {
      command = value;
    } else if (value === "--t3-url" && values[index + 1] !== undefined) {
      t3Url = values[index + 1]!;
      index += 1;
    } else if (value === "--port" && values[index + 1] !== undefined) {
      port = Number(values[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${value ?? ""}`);
    }
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Bridge port must be between 1 and 65535.");
  }
  return { command, t3Url, port };
};

const normalizeLoopbackUrl = (value: string): string => {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("T3 URL must use HTTP or HTTPS.");
  }
  if (!["127.0.0.1", "::1", "localhost"].includes(url.hostname)) {
    throw new Error("The initial VoiceInk T3 Bridge supports loopback T3 endpoints only.");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = "/";
  return url.toString();
};

const readSecretFromStandardInput = async (): Promise<string> => {
  if (process.stdin.isTTY) {
    process.stderr.write("Paste the one-time T3 pairing credential, then press Return:\n");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > 16 * 1024) throw new Error("Pairing credential is too large.");
    chunks.push(bytes);
  }
  const secret = Buffer.concat(chunks).toString("utf8").trim();
  if (secret.length === 0) throw new Error("No pairing credential was provided.");
  return secret;
};

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "VoiceInk T3 Bridge failed.";
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
