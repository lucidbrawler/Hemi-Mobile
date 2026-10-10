/**
 * Passkey unlock for the Hemi wallet.
 *
 * The phrase is encrypted with a key from the WebAuthn PRF extension when the
 * authenticator returns one. Otherwise a non-extractable AES key is kept in
 * IndexedDB and the passkey prompt is the user check (this browser only).
 */

import { decryptNativePasskey } from "./devicePasskey";

const IDB_NAME = "hemi-btc-passkey-v1";
const IDB_STORE = "device-aes-keys";
const PRF_INFO = new TextEncoder().encode("hemi-btc-wallet-passkey-aes-v1");

export type PasskeyBlock = {
  credentialId: string;
  rpId: string;
  mode: "prf" | "device" | "native";
  prfSalt: string | null;
  iv: string;
  ciphertext: string;
  transports: string[];
};

type PrfResults = {
  prf?: {
    enabled?: boolean;
    results?: { first?: ArrayBuffer };
  };
};

function ipHost(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

/** Why a passkey cannot be created here, or null when the browser can prompt. */
export function passkeyBlockReason(): string | null {
  try {
    if (typeof window === "undefined" || !window.isSecureContext) {
      return "Passkey unlock needs HTTPS or localhost.";
    }
    if (ipHost(location.hostname)) {
      return "Open http://localhost:5173 for the passkey. Browsers will not create a passkey on an IP address.";
    }
    if (typeof PublicKeyCredential === "undefined" || !navigator.credentials?.create || !navigator.credentials?.get) {
      return "This browser cannot create a passkey.";
    }
    return null;
  } catch {
    return "This browser cannot create a passkey.";
  }
}

export function passkeySupported(): boolean {
  return passkeyBlockReason() == null;
}

function rpId(): string {
  return location.hostname || "localhost";
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const str = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const bin = atob(str + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function cancelled(err: unknown): boolean {
  const name = err instanceof DOMException ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  return /NotAllowedError|AbortError|timed out|cancel|abort/i.test(`${name} ${msg}`);
}

function fail(err: unknown, fallback: string): Error {
  if (cancelled(err)) return new Error(fallback);
  const msg = err instanceof Error ? err.message : "";
  return new Error(msg || fallback);
}

function prfBytes(cred: PublicKeyCredential): Uint8Array | null {
  const ext = cred.getClientExtensionResults() as PrfResults;
  const first = ext.prf?.results?.first;
  if (!first) return null;
  const bytes = new Uint8Array(first);
  return bytes.length >= 32 ? bytes : null;
}

function prfEnabled(cred: PublicKeyCredential): boolean {
  const ext = cred.getClientExtensionResults() as PrfResults;
  return Boolean(ext.prf?.enabled || ext.prf?.results?.first);
}

async function deriveAes(prfFirst: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", prfFirst as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: PRF_INFO },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function aesEncrypt(key: CryptoKey, mnemonic: string): Promise<{ iv: string; ciphertext: string }> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(JSON.stringify({ mnemonic })),
  );
  return { iv: bytesToBase64Url(iv), ciphertext: bytesToBase64Url(new Uint8Array(ct)) };
}

async function aesDecrypt(key: CryptoKey, iv: string, ciphertext: string): Promise<string> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(iv) as BufferSource },
      key,
      base64UrlToBytes(ciphertext) as BufferSource,
    );
    const parsed = JSON.parse(new TextDecoder().decode(plain)) as { mnemonic?: string };
    if (!parsed.mnemonic) throw new Error("empty");
    return parsed.mnemonic;
  } catch {
    throw new Error("Passkey unlock failed. Use the same passkey that saved this wallet.");
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onerror = () => reject(req.error || new Error("Could not open passkey storage."));
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
  });
}

async function idbPut(id: string, key: CryptoKey): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error("Could not store the passkey key."));
    };
    tx.objectStore(IDB_STORE).put(key, id);
  });
}

async function idbGet(id: string): Promise<CryptoKey | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(id);
    req.onsuccess = () => {
      db.close();
      resolve((req.result as CryptoKey | undefined) ?? null);
    };
    req.onerror = () => {
      db.close();
      reject(req.error || new Error("Could not read the passkey key."));
    };
  });
}

export async function deleteDeviceKey(credentialId: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
      tx.objectStore(IDB_STORE).delete(credentialId);
    });
  } catch {
    /* The credential is already gone. */
  }
}

async function createCredential(prfSalt: Uint8Array, displayName: string): Promise<{
  credentialId: string;
  transports: string[];
  prfFirst: Uint8Array | null;
  prfOn: boolean;
}> {
  if (!passkeySupported()) {
    throw new Error("Passkey unlock needs a secure page (this site, or HTTPS) and a browser that can create passkeys.");
  }
  const name = displayName.slice(0, 64) || "hemi BTC";
  let platform = false;
  try {
    platform = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    platform = false;
  }

  const selection = (attached: boolean): AuthenticatorSelectionCriteria => ({
    residentKey: "required",
    requireResidentKey: true,
    userVerification: "required",
    ...(attached ? { authenticatorAttachment: "platform" } : {}),
  });

  const options = (attached: boolean): PublicKeyCredentialCreationOptions => ({
    challenge: randomBytes(32) as BufferSource,
    rp: { id: rpId(), name: "Hemi BTC" },
    user: {
      id: randomBytes(16) as BufferSource,
      name: "hemi BTC",
      displayName: name,
    },
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
    ],
    authenticatorSelection: selection(attached),
    timeout: 120_000,
    attestation: "none",
    extensions: {
      prf: { eval: { first: prfSalt as BufferSource } },
    } as AuthenticationExtensionsClientInputs,
  });

  let created: Credential | null = null;
  try {
    created = await navigator.credentials.create({ publicKey: options(platform) });
  } catch (err) {
    if (cancelled(err)) throw new Error("Passkey setup cancelled");
    if (platform) {
      try {
        created = await navigator.credentials.create({ publicKey: options(false) });
      } catch (err2) {
        throw fail(err2, "Passkey setup cancelled");
      }
    } else {
      throw fail(err, "Could not create a passkey.");
    }
  }
  if (!(created instanceof PublicKeyCredential)) throw new Error("Passkey setup did not return a credential.");
  const attestation = created.response;
  const transports =
    attestation instanceof AuthenticatorAttestationResponse && typeof attestation.getTransports === "function"
      ? attestation.getTransports()
      : [];
  return {
    credentialId: bytesToBase64Url(new Uint8Array(created.rawId)),
    transports,
    prfFirst: prfBytes(created),
    prfOn: prfEnabled(created),
  };
}

async function assertCredential(block: Pick<PasskeyBlock, "credentialId" | "transports" | "prfSalt">): Promise<Uint8Array | null> {
  if (!passkeySupported()) throw new Error("Passkey unlock is not available in this browser.");
  const allow: PublicKeyCredentialDescriptor = {
    type: "public-key",
    id: base64UrlToBytes(block.credentialId) as BufferSource,
    transports: block.transports as AuthenticatorTransport[],
  };
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: randomBytes(32) as BufferSource,
    rpId: rpId(),
    allowCredentials: [allow],
    userVerification: "required",
    timeout: 120_000,
  };
  if (block.prfSalt) {
    publicKey.extensions = {
      prf: { eval: { first: base64UrlToBytes(block.prfSalt) as BufferSource } },
    } as AuthenticationExtensionsClientInputs;
  }
  let assertion: Credential | null;
  try {
    assertion = await navigator.credentials.get({ publicKey });
  } catch (err) {
    throw fail(err, "Passkey unlock cancelled");
  }
  if (!(assertion instanceof PublicKeyCredential)) throw new Error("Passkey unlock failed.");
  return prfBytes(assertion);
}

export async function encryptMnemonicWithNewPasskey(mnemonic: string, displayName: string): Promise<PasskeyBlock> {
  const prfSalt = randomBytes(32);
  const created = await createCredential(prfSalt, displayName);
  let secret = created.prfFirst;
  if ((!secret || secret.length < 32) && created.prfOn) {
    try {
      secret = await assertCredential({
        credentialId: created.credentialId,
        transports: created.transports,
        prfSalt: bytesToBase64Url(prfSalt),
      });
    } catch (err) {
      if (err instanceof Error && /cancelled/i.test(err.message)) throw err;
    }
  }

  let mode: PasskeyBlock["mode"] = "device";
  let key: CryptoKey;
  let salt: string | null = null;
  if (secret && secret.length >= 32) {
    key = await deriveAes(secret);
    mode = "prf";
    salt = bytesToBase64Url(prfSalt);
  } else {
    key = await crypto.subtle.importKey("raw", randomBytes(32) as BufferSource, { name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    await idbPut(created.credentialId, key);
  }
  const sealed = await aesEncrypt(key, mnemonic);
  return {
    credentialId: created.credentialId,
    rpId: rpId(),
    mode,
    prfSalt: salt,
    iv: sealed.iv,
    ciphertext: sealed.ciphertext,
    transports: created.transports,
  };
}

export async function decryptMnemonicWithPasskey(block: PasskeyBlock): Promise<string> {
  if (!block.credentialId || !block.ciphertext) throw new Error("This wallet has no passkey.");
  if (block.mode === "native") return decryptNativePasskey(block);
  if (block.mode === "prf") {
    if (!block.prfSalt) throw new Error("Passkey data is incomplete. Enable the passkey again.");
    const secret = await assertCredential(block);
    if (!secret || secret.length < 32) {
      throw new Error("This passkey did not return an encryption secret. Enable the passkey again in Chrome or Edge.");
    }
    return aesDecrypt(await deriveAes(secret), block.iv, block.ciphertext);
  }
  await assertCredential({ ...block, prfSalt: null });
  const key = await idbGet(block.credentialId);
  if (!key) {
    throw new Error("The passkey key for this browser is missing. Unlock another way, or import the phrase and enable the passkey again.");
  }
  return aesDecrypt(key, block.iv, block.ciphertext);
}
