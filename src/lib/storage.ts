import { PBKDF2_ITERATIONS } from "../chain";

const KEY = "hemi-btc-vault-v1";

export type VaultBlob = {
  v: 1;
  salt: string;
  iv: string;
  ct: string;
};

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToBytes(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(password: string, salt: Uint8Array, usage: "encrypt" | "decrypt") {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

export function hasVault(): boolean {
  return localStorage.getItem(KEY) != null;
}

export async function saveMnemonic(password: string, mnemonic: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, "encrypt");
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(mnemonic),
  );
  const blob: VaultBlob = {
    v: 1,
    salt: bytesToB64(salt),
    iv: bytesToB64(iv),
    ct: bytesToB64(new Uint8Array(ct)),
  };
  localStorage.setItem(KEY, JSON.stringify(blob));
}

export async function loadMnemonic(password: string): Promise<string> {
  const raw = localStorage.getItem(KEY);
  if (!raw) throw new Error("No wallet is saved on this device.");
  const blob = JSON.parse(raw) as VaultBlob;
  const key = await deriveKey(password, b64ToBytes(blob.salt), "decrypt");
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64ToBytes(blob.iv) as BufferSource },
      key,
      b64ToBytes(blob.ct) as BufferSource,
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error("Wrong password.");
  }
}

export function forgetVault(): void {
  localStorage.removeItem(KEY);
}

const HISTORY_KEY = "hemi-btc-tunnel-history-v1";

export type TunnelDirection = "to-hemi" | "to-bitcoin";

export type TunnelRecord = {
  id: string;
  direction: TunnelDirection;
  createdAt: number;
  grossSats: string;
  vaultFeeSats: string;
  netSats: string;
  btcAddress: string;
  hemiAddress: string;
  txHash: string;
  outputIndex?: number;
  status: "broadcast" | "minted";
};

export function readTunnels(): TunnelRecord[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as TunnelRecord[]) : [];
  } catch {
    return [];
  }
}

export function pushTunnel(record: TunnelRecord): TunnelRecord[] {
  const next = [record, ...readTunnels()].slice(0, 40);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  return next;
}

export function markTunnel(id: string, status: TunnelRecord["status"]): TunnelRecord[] {
  const next = readTunnels().map((row) => (row.id === id ? { ...row, status } : row));
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  return next;
}
