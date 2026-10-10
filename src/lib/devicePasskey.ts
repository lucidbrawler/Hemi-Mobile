import { Capacitor, registerPlugin } from "@capacitor/core";
import type { PasskeyBlock } from "./passkey";

type DevicePasskeyApi = {
  canAuthenticate(): Promise<{ available: boolean }>;
  protect(options: { name: string; plaintext: string }): Promise<{ alias: string; iv: string; ciphertext: string }>;
  reveal(options: { alias: string; iv: string; ciphertext: string }): Promise<{ plaintext: string }>;
  remove(options: { alias: string }): Promise<{ ok: boolean }>;
};

const plugin = registerPlugin<DevicePasskeyApi>("DevicePasskey");

/** True inside the Android app. The browser keeps using WebAuthn. */
export function nativeShell(): boolean {
  return Capacitor.isNativePlatform();
}

export async function nativePasskeyAvailable(): Promise<boolean> {
  if (!nativeShell()) return false;
  try {
    const result = await plugin.canAuthenticate();
    return result.available;
  } catch {
    return false;
  }
}

export async function encryptWithNativePasskey(name: string, mnemonic: string): Promise<PasskeyBlock> {
  const sealed = await plugin.protect({ name, plaintext: mnemonic });
  return {
    credentialId: sealed.alias,
    rpId: "android",
    mode: "native",
    prfSalt: null,
    iv: sealed.iv,
    ciphertext: sealed.ciphertext,
    transports: ["internal"],
  };
}

export async function decryptNativePasskey(block: PasskeyBlock): Promise<string> {
  if (!block.credentialId || !block.iv || !block.ciphertext) throw new Error("This wallet has no passkey.");
  try {
    const opened = await plugin.reveal({
      alias: block.credentialId,
      iv: block.iv,
      ciphertext: block.ciphertext,
    });
    return opened.plaintext;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Passkey unlock cancelled.";
    throw new Error(message || "Passkey unlock cancelled.");
  }
}

export async function deleteNativePasskey(alias: string): Promise<void> {
  if (!nativeShell() || !alias) return;
  try {
    await plugin.remove({ alias });
  } catch {
    // The on-device record is removed even if the keystore entry is already gone.
  }
}
