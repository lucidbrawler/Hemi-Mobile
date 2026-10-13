import { PBKDF2_ITERATIONS } from "../chain";
import { deleteNativePasskey, encryptWithNativePasskey, nativeShell, revealNativePasskey } from "./devicePasskey";
import { vaultDelete, vaultList, vaultSet } from "./deviceVault";
import { assertNativePassword } from "./password";
import {
  decryptMnemonicWithPasskey,
  deleteDeviceKey,
  encryptMnemonicWithNewPasskey,
  type PasskeyBlock,
} from "./passkey";

export const LEGACY_KEY = "hemi-btc-vault-v1";
const NAMES_KEY = "hemi-btc-wallet-names-v1";
const KIND = "hemi-btc-wallet-v1";

/**
 * On the phone, wallet envelopes live in EncryptedSharedPreferences. The
 * in-memory cache is filled by hydrateVault() before the UI reads them.
 * The browser keeps using localStorage.
 */
const secretCache = new Map<string, string>();
let nativeVault = false;

function isSecretKey(key: string): boolean {
  return key === LEGACY_KEY || key === NAMES_KEY || key.startsWith(`${KIND}:`);
}

/** Local wallet rows that still need to be copied into the phone vault. */
export function planSecretImport(
  storedKeys: ReadonlySet<string>,
  local: { key: string; value: string | null }[],
): { key: string; value: string }[] {
  const writes: { key: string; value: string }[] = [];
  for (const row of local) {
    if (!row.key || row.value == null || !isSecretKey(row.key)) continue;
    if (storedKeys.has(row.key)) continue;
    writes.push({ key: row.key, value: row.value });
  }
  return writes;
}

/**
 * The original single-wallet save has no name. Move it to "Main" once.
 * `dropLegacy` means the old key should be removed either way.
 */
export function planLegacyMigration(
  has: (key: string) => boolean,
  read: (key: string) => string | null,
): { dropLegacy: boolean; mainValue: string | null; namesJson: string | null } {
  const raw = read(LEGACY_KEY);
  if (!raw) return { dropLegacy: false, mainValue: null, namesJson: null };
  const names = parseNames(read(NAMES_KEY));
  const main = slot("Main");
  if (!names.some((name) => name.toLowerCase() === "main") && !has(main)) {
    return { dropLegacy: true, mainValue: raw, namesJson: JSON.stringify([...names, "Main"]) };
  }
  return { dropLegacy: true, mainValue: null, namesJson: null };
}

function readSecret(key: string): string | null {
  if (nativeVault) return secretCache.get(key) ?? null;
  return localStorage.getItem(key);
}

async function putSecret(key: string, value: string): Promise<void> {
  if (nativeVault) {
    secretCache.set(key, value);
    await vaultSet(key, value);
    return;
  }
  localStorage.setItem(key, value);
}

async function dropSecret(key: string): Promise<void> {
  if (nativeVault) {
    secretCache.delete(key);
    await vaultDelete(key);
    return;
  }
  localStorage.removeItem(key);
}

function checkPassword(password: string) {
  if (nativeShell()) assertNativePassword(password);
  else if (password.length < 8) throw new Error("Password must be at least 8 characters.");
}

/** Copy any wallet envelopes out of WebView localStorage into the keystore vault. */
export async function hydrateVault(): Promise<void> {
  if (!nativeShell() || nativeVault) return;
  const entries = await vaultList();
  secretCache.clear();
  for (const entry of entries) {
    if (isSecretKey(entry.key)) secretCache.set(entry.key, entry.value);
  }
  const local: { key: string; value: string | null }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && isSecretKey(key)) local.push({ key, value: localStorage.getItem(key) });
  }
  for (const row of planSecretImport(new Set(secretCache.keys()), local)) {
    await vaultSet(row.key, row.value);
    secretCache.set(row.key, row.value);
  }
  for (const row of local) localStorage.removeItem(row.key);
  await migrateLegacyNative();
  nativeVault = true;
}

async function migrateLegacyNative(): Promise<void> {
  const plan = planLegacyMigration(
    (key) => secretCache.has(key),
    (key) => secretCache.get(key) ?? null,
  );
  if (!plan.dropLegacy) return;
  if (plan.mainValue && plan.namesJson) {
    const main = slot("Main");
    secretCache.set(main, plan.mainValue);
    await vaultSet(main, plan.mainValue);
    secretCache.set(NAMES_KEY, plan.namesJson);
    await vaultSet(NAMES_KEY, plan.namesJson);
  }
  secretCache.delete(LEGACY_KEY);
  await vaultDelete(LEGACY_KEY);
}

export type PasswordCipher = {
  salt: string;
  iv: string;
  ct: string;
};

export type VaultEnvelope = {
  v: 2;
  kind: typeof KIND;
  addressHint: string;
  require2fa: boolean;
  password: PasswordCipher | null;
  passkey: PasskeyBlock | null;
};

export type VaultAuth = {
  saved: boolean;
  hasPassword: boolean;
  hasPasskey: boolean;
  require2fa: boolean;
};

export type SavedWallet = {
  name: string;
  addressHint: string;
  hasPassword: boolean;
  hasPasskey: boolean;
  require2fa: boolean;
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

function emptyAuth(): VaultAuth {
  return { saved: false, hasPassword: false, hasPasskey: false, require2fa: false };
}

export function normalizeWalletName(name: string): string {
  const text = name.trim().replace(/\s+/g, " ");
  if (!text) throw new Error("Enter a wallet name.");
  if (text.length > 40) throw new Error("Wallet name must be 40 characters or less.");
  return text;
}

function slot(name: string): string {
  return `hemi-btc-wallet-v1:${encodeURIComponent(normalizeWalletName(name))}`;
}

function parseNames(raw: string | null): string[] {
  try {
    const names = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
  } catch {
    return [];
  }
}

function readNames(): string[] {
  return parseNames(readSecret(NAMES_KEY));
}

async function writeNames(names: string[]): Promise<void> {
  await putSecret(NAMES_KEY, JSON.stringify(names));
}

async function remember(name: string): Promise<void> {
  const names = readNames();
  if (!names.some((row) => row.toLowerCase() === name.toLowerCase())) await writeNames([...names, name]);
}

/** Move the original single-wallet save into the list as "Main". */
function migrateLegacy() {
  if (nativeVault) return;
  const plan = planLegacyMigration(
    (key) => localStorage.getItem(key) != null,
    (key) => localStorage.getItem(key),
  );
  if (!plan.dropLegacy) return;
  if (plan.mainValue && plan.namesJson) {
    localStorage.setItem(slot("Main"), plan.mainValue);
    localStorage.setItem(NAMES_KEY, plan.namesJson);
  }
  localStorage.removeItem(LEGACY_KEY);
}

function readRaw(name: string): string | null {
  if (!nativeVault) migrateLegacy();
  return readSecret(slot(name));
}

function parseEnvelope(raw: string | null): VaultEnvelope | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Partial<VaultEnvelope>;
    if (obj.kind === KIND && obj.v === 2) return obj as VaultEnvelope;
    return null;
  } catch {
    return null;
  }
}

function parseLegacy(raw: string | null): PasswordCipher | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Partial<PasswordCipher & { v?: number; kind?: string }>;
    if (obj.kind) return null;
    if (obj.v === 1 && obj.salt && obj.iv && obj.ct) return { salt: obj.salt, iv: obj.iv, ct: obj.ct };
    return null;
  } catch {
    return null;
  }
}

function authOf(raw: string | null): VaultAuth {
  const env = parseEnvelope(raw);
  if (env) {
    const hasPassword = Boolean(env.password);
    const hasPasskey = Boolean(env.passkey?.credentialId && env.passkey.ciphertext);
    return {
      saved: true,
      hasPassword,
      hasPasskey,
      require2fa: Boolean(env.require2fa) && hasPassword && hasPasskey,
    };
  }
  if (parseLegacy(raw)) return { saved: true, hasPassword: true, hasPasskey: false, require2fa: false };
  return emptyAuth();
}

export function inspectWallet(name: string): VaultAuth {
  return authOf(readRaw(name));
}

export function listWallets(): SavedWallet[] {
  migrateLegacy();
  return readNames().flatMap((name) => {
    const raw = readSecret(slot(name));
    const auth = authOf(raw);
    if (!auth.saved) return [];
    const env = parseEnvelope(raw);
    return [{
      name,
      addressHint: env?.addressHint ?? "",
      hasPassword: auth.hasPassword,
      hasPasskey: auth.hasPasskey,
      require2fa: auth.require2fa,
    }];
  });
}

export function walletNameTaken(name: string): boolean {
  const wanted = normalizeWalletName(name).toLowerCase();
  return listWallets().some((row) => row.name.toLowerCase() === wanted);
}

async function encryptPassword(password: string, mnemonic: string): Promise<PasswordCipher> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, "encrypt");
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(mnemonic),
  );
  return { salt: bytesToB64(salt), iv: bytesToB64(iv), ct: bytesToB64(new Uint8Array(ct)) };
}

async function decryptPassword(password: string, blob: PasswordCipher): Promise<string> {
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

function passwordCipher(name: string): PasswordCipher | null {
  const raw = readRaw(name);
  return parseEnvelope(raw)?.password ?? parseLegacy(raw);
}

async function dropPasskey(block: PasskeyBlock | null | undefined) {
  if (!block?.credentialId) return;
  if (block.mode === "native") await deleteNativePasskey(block.credentialId);
  else await deleteDeviceKey(block.credentialId);
}

export async function loadByPassword(name: string, password: string): Promise<string> {
  const blob = passwordCipher(name);
  if (!blob) throw new Error("This wallet does not unlock with a password.");
  return decryptPassword(password, blob);
}

export async function loadByPasskey(name: string): Promise<string> {
  const walletName = normalizeWalletName(name);
  const env = parseEnvelope(readRaw(walletName));
  if (!env?.passkey) throw new Error("This wallet has no passkey.");
  if (env.passkey.mode !== "native") return decryptMnemonicWithPasskey(env.passkey);
  const opened = await revealNativePasskey(env.passkey);
  if (opened.upgraded) {
    const previous = env.passkey.credentialId;
    try {
      env.passkey = opened.upgraded;
      await putSecret(slot(walletName), JSON.stringify(env));
      if (previous && previous !== opened.upgraded.credentialId) await deleteNativePasskey(previous);
    } catch {
      // The old key still opens. The next unlock tries the upgrade again.
    }
  }
  return opened.plaintext;
}

export async function saveWithPasskey(
  name: string,
  mnemonic: string,
  hint: string,
  options: { password?: string; require2fa: boolean; native: boolean; existingPassword?: boolean },
): Promise<void> {
  const walletName = normalizeWalletName(name);
  if (options.require2fa && !options.existingPassword) {
    if (!options.password) throw new Error("2FA needs a password of at least 8 characters.");
    try {
      checkPassword(options.password);
    } catch (err) {
      if (!nativeShell()) throw new Error("2FA needs a password of at least 8 characters.");
      throw err;
    }
  } else if (options.require2fa && !options.password) {
    throw new Error("2FA needs a password of at least 8 characters.");
  }
  const previous = parseEnvelope(readRaw(walletName));
  const passkey = options.native
    ? await encryptWithNativePasskey(walletName, mnemonic)
    : await encryptMnemonicWithNewPasskey(mnemonic, hint || walletName);
  if (previous?.passkey?.credentialId && previous.passkey.credentialId !== passkey.credentialId) {
    await dropPasskey(previous.passkey);
  }
  const password = options.password ? await encryptPassword(options.password, mnemonic) : null;
  const envelope: VaultEnvelope = {
    v: 2,
    kind: KIND,
    addressHint: hint,
    require2fa: Boolean(options.require2fa && password),
    password,
    passkey,
  };
  await putSecret(slot(walletName), JSON.stringify(envelope));
  await remember(walletName);
}

export async function savePasswordOnly(name: string, mnemonic: string, password: string, hint: string): Promise<void> {
  const walletName = normalizeWalletName(name);
  checkPassword(password);
  const previous = parseEnvelope(readRaw(walletName));
  if (previous?.passkey) await dropPasskey(previous.passkey);
  const envelope: VaultEnvelope = {
    v: 2,
    kind: KIND,
    addressHint: hint,
    require2fa: false,
    password: await encryptPassword(password, mnemonic),
    passkey: null,
  };
  await putSecret(slot(walletName), JSON.stringify(envelope));
  await remember(walletName);
}

export async function attachPassword2fa(name: string, mnemonic: string, password: string): Promise<void> {
  const walletName = normalizeWalletName(name);
  const env = parseEnvelope(readRaw(walletName));
  if (!env?.passkey) throw new Error("Enable a passkey before turning on 2FA.");
  checkPassword(password);
  env.password = await encryptPassword(password, mnemonic);
  env.require2fa = true;
  await putSecret(slot(walletName), JSON.stringify(env));
}

export async function forgetWallet(name: string): Promise<void> {
  const walletName = normalizeWalletName(name);
  const env = parseEnvelope(readRaw(walletName));
  if (env?.passkey) await dropPasskey(env.passkey);
  await dropSecret(slot(walletName));
  await writeNames(readNames().filter((row) => row.toLowerCase() !== walletName.toLowerCase()));
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
  status: "broadcast" | "minted" | "paid";
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

const ETH_KEY = "hemi-eth-tunnel-history-v1";

export type EthDirection = "to-hemi" | "to-ethereum";

export type StoredWithdrawal = {
  nonce: string;
  sender: string;
  target: string;
  value: string;
  gasLimit: string;
  data: string;
  hash: string;
};

export type EthMove = {
  id: string;
  direction: EthDirection;
  createdAt: number;
  amountWei: string;
  from: string;
  to: string;
  txHash: string;
  l2Block?: number;
  withdrawal?: StoredWithdrawal;
  /** Hemi ETH balance just before a deposit, used to notice when the credit arrives. */
  hemiWeiBefore?: string;
  status: "submitted" | "proven" | "finalized" | "credited";
};

function isEthMove(value: unknown): value is EthMove {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<EthMove>;
  return typeof row.id === "string"
    && (row.direction === "to-hemi" || row.direction === "to-ethereum")
    && typeof row.amountWei === "string"
    && typeof row.txHash === "string"
    && (row.status === "submitted" || row.status === "proven" || row.status === "finalized" || row.status === "credited");
}

export function readEthMoves(): EthMove[] {
  try {
    const raw = localStorage.getItem(ETH_KEY);
    const rows = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(rows) ? rows.filter(isEthMove) : [];
  } catch {
    return [];
  }
}

export function pushEthMove(record: EthMove): EthMove[] {
  const next = [record, ...readEthMoves().filter((row) => row.id !== record.id)].slice(0, 40);
  localStorage.setItem(ETH_KEY, JSON.stringify(next));
  return next;
}

export function markEthMove(id: string, status: EthMove["status"]): EthMove[] {
  const next = readEthMoves().map((row) => (row.id === id ? { ...row, status } : row));
  localStorage.setItem(ETH_KEY, JSON.stringify(next));
  return next;
}
