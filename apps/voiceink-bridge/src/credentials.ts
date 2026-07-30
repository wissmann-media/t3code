import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";

const KEYCHAIN_SERVICE = "com.wissmannmedia.VoiceInk.T3Bridge";

export interface CredentialStore {
  readonly read: (account: string) => Promise<string | null>;
  readonly write: (account: string, value: string) => Promise<void>;
  readonly remove: (account: string) => Promise<void>;
}

export class MacOSKeychainCredentialStore implements CredentialStore {
  async read(account: string): Promise<string | null> {
    const result = NodeChildProcess.spawnSync(
      "/usr/bin/security",
      ["find-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8", maxBuffer: 64 * 1024 },
    );
    if (result.status === 44) return null;
    if (result.status !== 0) {
      throw new Error("Could not read the T3 Bridge credential from the login keychain.");
    }
    return result.stdout.trim();
  }

  async write(account: string, value: string): Promise<void> {
    const result = NodeChildProcess.spawnSync(
      "/usr/bin/security",
      [
        "add-generic-password",
        "-U",
        "-a",
        account,
        "-s",
        KEYCHAIN_SERVICE,
        "-l",
        "VoiceInk T3 Bridge",
        "-w",
      ],
      { input: `${value}\n`, encoding: "utf8", maxBuffer: 64 * 1024 },
    );
    if (result.status !== 0) {
      throw new Error("Could not store the T3 Bridge credential in the login keychain.");
    }
  }

  async remove(account: string): Promise<void> {
    const result = NodeChildProcess.spawnSync(
      "/usr/bin/security",
      ["delete-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE],
      { encoding: "utf8", maxBuffer: 64 * 1024 },
    );
    if (result.status !== 0 && result.status !== 44) {
      throw new Error("Could not remove the T3 Bridge credential from the login keychain.");
    }
  }
}

export class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, string>();

  async read(account: string): Promise<string | null> {
    return this.values.get(account) ?? null;
  }

  async write(account: string, value: string): Promise<void> {
    this.values.set(account, value);
  }

  async remove(account: string): Promise<void> {
    this.values.delete(account);
  }
}

export const bridgeApiAccount = "bridge-api-bearer";

export const t3BearerAccount = (httpBaseUrl: string): string =>
  `t3-bearer-${NodeCrypto.createHash("sha256").update(httpBaseUrl).digest("hex").slice(0, 24)}`;

export const ensureBridgeApiSecret = async (store: CredentialStore): Promise<string> => {
  const existing = await store.read(bridgeApiAccount);
  if (existing !== null && existing.length >= 32) return existing;
  const secret = NodeCrypto.randomBytes(32).toString("base64url");
  await store.write(bridgeApiAccount, secret);
  return secret;
};
