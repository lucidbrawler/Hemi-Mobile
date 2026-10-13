import { Capacitor, registerPlugin } from "@capacitor/core";
import type { PasskeyBlock } from "./passkey";

type DevicePasskeyApi = {
  canAuthenticate(): Promise<{ available: boolean }>;
  protect(options: { name: string; plaintext: string }): Promise<{ alias: string; iv: string; ciphertext: string }>;
  reveal(options: { alias: string; iv: string; ciphertext: string }): Promise<{
    plaintext: string;
    legacy?: boolean;
    upgradedAlias?: string;
    upgradedIv?: string;
    upgradedCiphertext?: string;
  }>;
  remove(options: { alias: string }): Promise<{ ok: boolean }>;
};

export type NativeReveal = {
  plaintext: string;
  upgraded: PasskeyBlock | null;
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

function nativeBlock(sealed: { alias: string; iv: string; ciphertext: string }): PasskeyBlock {
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

export async function encryptWithNativePasskey(name: string, mnemonic: string): Promise<PasskeyBlock> {
  const sealed = await plugin.protect({ name, plaintext: mnemonic });
  return nativeBlock(sealed);
}

export async function revealNativePasskey(block: PasskeyBlock): Promise<NativeReveal> {
  if (!block.credentialId || !block.iv || !block.ciphertext) throw new Error("This wallet has no passkey.");
  try {
    const opened = await plugin.reveal({
      alias: block.credentialId,
      iv: block.iv,
      ciphertext: block.ciphertext,
    });
    const upgraded = opened.upgradedAlias && opened.upgradedIv && opened.upgradedCiphertext
      ? nativeBlock({ alias: opened.upgradedAlias, iv: opened.upgradedIv, ciphertext: opened.upgradedCiphertext })
      : null;
    return { plaintext: opened.plaintext, upgraded };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Passkey unlock cancelled.";
    throw new Error(message || "Passkey unlock cancelled.");
  }
}

export async function decryptNativePasskey(block: PasskeyBlock): Promise<string> {
  const opened = await revealNativePasskey(block);
  return opened.plaintext;
}

export async function deleteNativePasskey(alias: string): Promise<void> {
  if (!nativeShell() || !alias) return;
  try {
    await plugin.remove({ alias });
  } catch {
    // The on-device record is removed even if the keystore entry is already gone.
  }
}
