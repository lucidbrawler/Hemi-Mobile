import { getAddress, getBytes, isAddress } from "ethers";
import { HEMI_CHAIN_ID } from "../chain";
import { formatUnits, shortAddr } from "./format";

export class DappError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "DappError";
    this.code = code;
  }
}

export const HEMI_CHAIN_HEX = `0x${HEMI_CHAIN_ID.toString(16)}`;

const READ_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getBlockTransactionCountByHash",
  "eth_getBlockTransactionCountByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByBlockHashAndIndex",
  "eth_getTransactionByBlockNumberAndIndex",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "eth_syncing",
  "net_version",
  "web3_clientVersion",
]);

export function isReadMethod(method: string): boolean {
  return READ_METHODS.has(method);
}

/** https URL for the site browser. Rejects other schemes, including http. */
export function prepareDappUrl(input: string): string {
  const text = input.trim();
  if (!text) throw new DappError(-32602, "Enter a site address.");
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new DappError(-32602, "That site address is not valid.");
  }
  if (url.username || url.password) throw new DappError(-32602, "That site address is not valid.");
  if (url.protocol !== "https:") throw new DappError(-32602, "Open an https site.");
  if (!url.hostname.includes(".")) throw new DappError(-32602, "That site address is not valid.");
  return url.toString();
}

export function isHemiChain(value: unknown): boolean {
  if (typeof value === "number" && Number.isFinite(value)) return value === HEMI_CHAIN_ID;
  if (typeof value === "bigint") return value === BigInt(HEMI_CHAIN_ID);
  if (typeof value !== "string") return false;
  const text = value.trim().toLowerCase();
  if (text === String(HEMI_CHAIN_ID)) return true;
  if (!/^0x[0-9a-f]+$/.test(text)) return false;
  try {
    return BigInt(text) === BigInt(HEMI_CHAIN_ID);
  } catch {
    return false;
  }
}

export function asParams(value: unknown): unknown[] {
  if (value == null) return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed;
    } catch {
      throw new DappError(-32602, "This request has bad parameters.");
    }
  }
  if (Array.isArray(value)) return value;
  throw new DappError(-32602, "This request has bad parameters.");
}

export function hexQuantity(value: unknown): bigint {
  if (typeof value === "bigint") return value >= 0n ? value : invalidHex();
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return invalidHex();
}

function invalidHex(): never {
  throw new DappError(-32602, "A value in this request is not hex.");
}

export function hexData(value: unknown): string {
  if (value == null || value === "" || value === "0x") return "0x";
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
    throw new DappError(-32602, "The transaction data is not hex.");
  }
  return value.toLowerCase();
}

/** Text a person can read from a personal_sign payload. */
export function previewMessage(raw: string): string {
  if (!raw) return "(empty message)";
  let text = raw;
  if (/^0x[0-9a-fA-F]*$/.test(raw) && raw.length % 2 === 0 && raw.length > 2) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(getBytes(raw));
    } catch {
      text = raw;
    }
  }
  const clean = text.replace(/\u0000/g, "");
  if (!clean.trim()) return raw.length > 66 ? `${raw.slice(0, 66)}…` : raw;
  return clean.length > 600 ? `${clean.slice(0, 600)}…` : clean;
}

export function messageBytes(raw: string): string | Uint8Array {
  if (/^0x[0-9a-fA-F]*$/.test(raw) && raw.length % 2 === 0 && raw.length >= 2) return getBytes(raw);
  return raw;
}

export function signParts(params: unknown[]): { address: string | null; raw: string } {
  const texts = params.filter((item): item is string => typeof item === "string");
  const address = texts.find((item) => isAddress(item)) ?? null;
  const raw = texts.find((item) => item !== address) ?? "";
  return { address: address ? getAddress(address) : null, raw };
}

export type TypedRequest = {
  address: string | null;
  domainName: string;
  primary: string;
  summary: string;
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  message: Record<string, unknown>;
};

export function parseTypedRequest(params: unknown[]): TypedRequest {
  const texts = params.filter((item): item is string => typeof item === "string");
  const address = texts.find((item) => isAddress(item)) ?? null;
  const payload = params.find((item) => item && typeof item === "object") ?? texts.find((item) => !isAddress(item));
  let body: {
    domain?: Record<string, unknown>;
    types?: Record<string, { name: string; type: string }[]>;
    primaryType?: string;
    message?: Record<string, unknown>;
  };
  if (typeof payload === "string") {
    try {
      body = JSON.parse(payload) as typeof body;
    } catch {
      throw new DappError(-32602, "This signature data is not readable.");
    }
  } else if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    body = payload as typeof body;
  } else {
    throw new DappError(-32601, "This site uses an old signature format. It needs typed data v4.");
  }
  if (!body.types || !body.message || typeof body.types !== "object") {
    throw new DappError(-32602, "This signature data is not readable.");
  }
  const domain = body.domain ?? {};
  if (domain.chainId != null && !isHemiChain(domain.chainId)) {
    throw new DappError(4902, "This signature is for a different network. This wallet stays on Hemi.");
  }
  const types = { ...body.types };
  delete types.EIP712Domain;
  const names = Object.keys(types);
  const primary = body.primaryType && types[body.primaryType] ? body.primaryType : names[names.length - 1];
  if (!primary) throw new DappError(-32602, "This signature data is not readable.");
  const domainName = typeof domain.name === "string" && domain.name ? domain.name : "Signature";
  let summary = "";
  try {
    summary = JSON.stringify(body.message);
  } catch {
    summary = primary;
  }
  if (summary.length > 600) summary = `${summary.slice(0, 600)}…`;
  return {
    address: address ? getAddress(address) : null,
    domainName,
    primary,
    summary,
    domain,
    types,
    message: body.message,
  };
}

export function txAction(data: string, value: bigint, to: string | null): string {
  const selector = data.slice(2, 10);
  if (!to) return "Create a contract";
  if (selector === "095ea7b3") return "Let this contract spend a token";
  if (selector === "a9059cbb" || selector === "23b872dd") return "Send a token";
  if ((data === "0x" || data === "0x0") && value > 0n) return "Send ETH";
  if (data === "0x" || data.length <= 2) return value > 0n ? "Send ETH" : "Contract call";
  return "Contract call";
}

export function sameAddress(asked: string | null, wallet: string): void {
  if (asked && asked.toLowerCase() !== wallet.toLowerCase()) {
    throw new DappError(4100, "This site asked a different address to sign.");
  }
}

export function ethText(value: bigint): string {
  const text = formatUnits(value, 18);
  const [whole, frac = ""] = text.split(".");
  const cut = frac.slice(0, 6).replace(/0+$/, "");
  return cut ? `${whole}.${cut} ETH` : `${whole} ETH`;
}

export function siteHost(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin || "This site";
  }
}

export function txTo(to: string | null): string {
  if (!to) return "New contract";
  return shortAddr(to, 8, 6);
}
