/**
 * Geteilter Zugriff auf die erprobten Bridge-Bausteine der VoiceInk-
 * T3-Bridge — bewusst ein Re-Export-Shim statt einer Code-Verschiebung,
 * damit die laufende VoiceInk-Bridge unangetastet bleibt. Konsumenten:
 * apps/insa-bridge. Wandert der Code später physisch hierher, ändert
 * sich für Konsumenten nichts.
 */
export { EffectT3Client, type T3Client } from "../../../apps/voiceink-bridge/src/t3Client.ts";
export { BridgeStore, resumableShellCursor } from "../../../apps/voiceink-bridge/src/store.ts";
export {
  BridgeCommandService,
  type CanonicalCommandResult,
} from "../../../apps/voiceink-bridge/src/commands.ts";
export {
  decodeCanonicalCommand,
  type CanonicalCommand,
} from "../../../apps/voiceink-bridge/src/schemas.ts";
export {
  MacOSKeychainCredentialStore,
  MemoryCredentialStore,
  t3BearerAccount,
  type CredentialStore,
} from "../../../apps/voiceink-bridge/src/credentials.ts";
export type {
  BridgeEnvironment,
  BridgeProject,
  BridgeSnapshot,
  BridgeStatusEvent,
  BridgeThread,
  BridgeThreadOutput,
} from "../../../apps/voiceink-bridge/src/types.ts";
