import NodeCrypto from "node:crypto";
import NodeOS from "node:os";
import NodePath from "node:path";
import {
  BridgeCommandService,
  BridgeStore,
  EffectT3Client,
  MacOSKeychainCredentialStore,
  resumableShellCursor,
  t3BearerAccount,
  type BridgeEnvironment,
  type CredentialStore,
} from "@t3tools/bridge-client";

import { createInsaBridgeServer } from "./server.ts";

/**
 * Insa-T3-Bridge: eigener Prozess, eigener Port (9788), eigener
 * Zustandsspiegel — teilt sich mit der VoiceInk-Bridge nur die erprobte
 * Client-/Command-Schicht und das T3-Bearer-Credential (gleiche Keychain,
 * gleicher T3-Server). Das API-Token des Insa-Daemons liegt unter einem
 * eigenen Account und wird beim ersten Start erzeugt.
 */
const INSA_API_ACCOUNT = "insa-bridge-api-bearer";

/** Identisch zur VoiceInk-Bridge — der Keychain-Account hängt am Hash der normalisierten URL. */
const normalizeLoopbackUrl = (value: string): string => {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("T3 URL must use HTTP or HTTPS.");
  }
  if (!["127.0.0.1", "::1", "localhost"].includes(url.hostname)) {
    throw new Error("Die Insa-T3-Bridge unterstützt nur Loopback-Endpoints.");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = "/";
  return url.toString();
};

const ensureInsaApiSecret = async (store: CredentialStore): Promise<string> => {
  const existing = await store.read(INSA_API_ACCOUNT);
  if (existing !== null && existing.length >= 32) return existing;
  const secret = NodeCrypto.randomBytes(32).toString("base64url");
  await store.write(INSA_API_ACCOUNT, secret);
  return secret;
};

const main = async (): Promise<void> => {
  const portArg = process.argv.indexOf("--port");
  const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 9788;
  const t3Url = normalizeLoopbackUrl(process.env.INSA_T3_URL ?? "http://127.0.0.1:3773");

  const credentialStore = new MacOSKeychainCredentialStore();
  const t3Bearer = await credentialStore.read(t3BearerAccount(t3Url));
  if (t3Bearer === null) {
    throw new Error(
      "T3 ist nicht gepairt. Das T3-Bearer-Credential fehlt in der Keychain (Pairing lief bisher über die VoiceInk-Bridge).",
    );
  }
  const apiBearer = await ensureInsaApiSecret(credentialStore);

  const stateFile = NodePath.join(
    NodeOS.homedir(),
    "Library",
    "Application Support",
    "Insa",
    "T3Bridge",
    "state.json",
  );
  const store = new BridgeStore(stateFile);
  const t3 = new EffectT3Client(t3Url, t3Bearer, {
    onConnecting: () => store.markConnecting(),
    onConnected: (environment: {
      readonly id: string;
      readonly label: string;
      readonly serverVersion: string;
      readonly providers: BridgeEnvironment["providers"];
    }) => store.markConnected(environment),
    onProviderStatuses: (providers: BridgeEnvironment["providers"]) =>
      store.updateProviders(providers),
    onDisconnected: (reason: string) => store.markDisconnected(reason),
    onShellItem: (item: Parameters<BridgeStore["applyShellItem"]>[0]) => store.applyShellItem(item),
    onThreadItem: (threadId: string, item: Parameters<BridgeStore["applyThreadItem"]>[1]) =>
      store.applyThreadItem(threadId, item),
  });
  const commands = new BridgeCommandService(store, t3);
  const server = createInsaBridgeServer({ store, commands, t3, bearerToken: apiBearer });

  await server.listen(port);
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
  process.stdout.write(`Insa T3 Bridge listening on http://127.0.0.1:${port}\n`);

  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await t3.stop();
  await server.close();
};

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
