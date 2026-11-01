import { Transaction, getAddress, isAddress, type TypedDataDomain, type TypedDataField } from "ethers";
import { HEMI_CHAIN_ID, HEMI_RPC } from "../chain";
import {
  DappError,
  HEMI_CHAIN_HEX,
  asParams,
  ethText,
  hexData,
  hexQuantity,
  isHemiChain,
  isReadMethod,
  messageBytes,
  parseTypedRequest,
  previewMessage,
  sameAddress,
  signParts,
  siteHost,
  txAction,
} from "./dapp";
import { requirePublic, signEvm, signEvmMessage, signEvmTypedData } from "./sessionVault.ts";

export type DappPrompt = {
  origin: string;
  title: string;
  body: string;
  lines: { label: string; value: string }[];
  confirm: string;
  /** Spending and signatures need the checkbox. A connection does not. */
  sure: boolean;
};

type PreparedTx = {
  to?: string;
  value: bigint;
  data: string;
  gasLimit: bigint;
  nonce: number | null;
  maxFeePerGas: bigint | null;
  maxPriorityFeePerGas: bigint | null;
  gasPrice: bigint | null;
  fee: bigint | null;
  action: string;
};

export async function answerDappRequest(
  method: string,
  params: unknown,
  origin: string,
  connected: ReadonlySet<string>,
  ask: (prompt: DappPrompt) => Promise<boolean>,
): Promise<{ result: unknown; connect?: boolean; disconnect?: boolean }> {
  const list = asParams(params);
  const wallet = requirePublic().hemiAddress;
  const host = siteHost(origin);

  if (method === "eth_chainId") return { result: HEMI_CHAIN_HEX };
  if (method === "net_version") return { result: String(HEMI_CHAIN_ID) };
  if (method === "web3_clientVersion") return { result: "HemiBTC" };
  if (method === "eth_syncing") return { result: false };
  if (method === "eth_accounts") return { result: connected.has(origin) ? [wallet] : [] };
  if (method === "wallet_getPermissions") {
    return { result: connected.has(origin) ? [{ parentCapability: "eth_accounts" }] : [] };
  }
  if (isReadMethod(method)) return { result: await rpc(method, list) };

  if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") {
    const first = list[0];
    const chainId = first && typeof first === "object" ? (first as { chainId?: unknown }).chainId : first;
    if (!isHemiChain(chainId)) throw new DappError(4902, "This wallet stays on Hemi.");
    return { result: null };
  }

  if (method === "eth_requestAccounts" || method === "wallet_requestPermissions") {
    if (connected.has(origin)) return { result: accountsResult(method, wallet), connect: true };
    const ok = await ask({
      origin,
      title: "Connect",
      body: `${host} wants to see this Hemi address. It cannot move funds until you approve a transaction.`,
      lines: [{ label: "Address", value: wallet }],
      confirm: "Connect",
      sure: false,
    });
    if (!ok) throw new DappError(4001, "You rejected the request.");
    return { result: accountsResult(method, wallet), connect: true };
  }

  if (method === "wallet_revokePermissions") {
    return { result: null, disconnect: true };
  }

  if (!connected.has(origin)) throw new DappError(4100, "Connect this site first.");

  if (method === "personal_sign") {
    const parts = signParts(list);
    sameAddress(parts.address, wallet);
    const shown = previewMessage(parts.raw);
    const ok = await ask({
      origin,
      title: "Sign",
      body: `${host} wants a signature. This does not send a transaction.`,
      lines: [{ label: "Message", value: shown }],
      confirm: "Sign",
      sure: true,
    });
    if (!ok) throw new DappError(4001, "You rejected the request.");
    return { result: signEvmMessage(messageBytes(parts.raw)) };
  }

  if (method === "eth_signTypedData_v4" || method === "eth_signTypedData_v3") {
    const typed = parseTypedRequest(list);
    sameAddress(typed.address, wallet);
    const ok = await ask({
      origin,
      title: "Sign",
      body: `${host} wants a typed signature. This does not send a transaction.`,
      lines: [
        { label: "Site name", value: typed.domainName },
        { label: "Type", value: typed.primary },
        { label: "Message", value: typed.summary },
      ],
      confirm: "Sign",
      sure: true,
    });
    if (!ok) throw new DappError(4001, "You rejected the request.");
    const types = typed.types as Record<string, TypedDataField[]>;
    return { result: signEvmTypedData(typed.domain as TypedDataDomain, types, typed.message) };
  }

  if (method === "eth_sign" || method === "eth_signTypedData") {
    throw new DappError(-32601, "This site uses an old signature format. It needs personal_sign or typed data v4.");
  }

  if (method === "eth_sendTransaction") {
    const prepared = await prepareTx(list, wallet);
    const lines = [
      { label: "Action", value: prepared.action },
      { label: "To", value: prepared.to ?? "New contract" },
      { label: "Amount", value: ethText(prepared.value) },
      { label: "Max fee", value: prepared.fee == null ? "Unavailable" : ethText(prepared.fee) },
    ];
    const ok = await ask({
      origin,
      title: "Send",
      body: `${host} wants to send this on Hemi.`,
      lines,
      confirm: "Send",
      sure: true,
    });
    if (!ok) throw new DappError(4001, "You rejected the request.");
    return { result: await broadcast(prepared, wallet) };
  }

  throw new DappError(-32601, "This wallet does not support that request.");
}

function accountsResult(method: string, wallet: string): unknown {
  if (method === "wallet_requestPermissions") return [{ parentCapability: "eth_accounts" }];
  return [wallet];
}

async function prepareTx(params: unknown[], wallet: string): Promise<PreparedTx> {
  const first = params[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    throw new DappError(-32602, "This transaction is missing.");
  }
  const tx = first as Record<string, unknown>;
  if (typeof tx.from === "string" && tx.from) {
    if (!isAddress(tx.from)) throw new DappError(-32602, "That from address is not valid.");
    sameAddress(getAddress(tx.from), wallet);
  }
  if (tx.chainId != null && !isHemiChain(tx.chainId)) {
    throw new DappError(4902, "This transaction is for a different network. This wallet stays on Hemi.");
  }
  const to = tx.to == null || tx.to === "" ? null : addressOf(tx.to);
  const value = tx.value == null ? 0n : hexQuantity(tx.value);
  const data = hexData(tx.data);
  const siteGas = tx.gas == null && tx.gasLimit == null ? null : hexQuantity(tx.gas ?? tx.gasLimit);
  if (siteGas != null && siteGas > 30_000_000n) throw new DappError(-32602, "That gas limit is too high.");
  let estimated: bigint | null = null;
  try {
    const raw = await rpc("eth_estimateGas", [{
      from: wallet,
      to: to ?? undefined,
      value: hex(value),
      data,
    }]);
    if (typeof raw === "string") estimated = hexQuantity(raw);
  } catch (err) {
    if (siteGas == null) throw err;
  }
  const gasLimit = siteGas != null && (estimated == null || siteGas >= estimated) ? siteGas : estimated;
  if (gasLimit == null || gasLimit <= 0n) throw new DappError(-32603, "Could not estimate this transaction.");
  const fees = await networkFees(tx);
  const fee = fees.maxFeePerGas != null
    ? gasLimit * fees.maxFeePerGas
    : fees.gasPrice != null
      ? gasLimit * fees.gasPrice
      : null;
  return {
    to: to ?? undefined,
    value,
    data,
    gasLimit,
    nonce: tx.nonce == null ? null : safeNonce(hexQuantity(tx.nonce)),
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    gasPrice: fees.gasPrice,
    fee,
    action: txAction(data, value, to),
  };
}

function hex(value: bigint): string {
  if (value < 0n) throw new DappError(-32602, "A value in this request is not hex.");
  return `0x${value.toString(16)}`;
}

function addressOf(value: unknown): string {
  if (typeof value !== "string" || !isAddress(value)) throw new DappError(-32602, "That destination address is not valid.");
  return getAddress(value);
}

async function networkFees(tx: Record<string, unknown>): Promise<{
  maxFeePerGas: bigint | null;
  maxPriorityFeePerGas: bigint | null;
  gasPrice: bigint | null;
}> {
  if (tx.maxFeePerGas != null || tx.maxPriorityFeePerGas != null) {
    const tip = tx.maxPriorityFeePerGas == null ? 0n : hexQuantity(tx.maxPriorityFeePerGas);
    const max = tx.maxFeePerGas == null ? tip : hexQuantity(tx.maxFeePerGas);
    return { maxFeePerGas: max, maxPriorityFeePerGas: tip, gasPrice: null };
  }
  if (tx.gasPrice != null) {
    return { maxFeePerGas: null, maxPriorityFeePerGas: null, gasPrice: hexQuantity(tx.gasPrice) };
  }
  try {
    const [block, tipHex] = await Promise.all([
      rpc("eth_getBlockByNumber", ["latest", false]) as Promise<{ baseFeePerGas?: string } | null>,
      rpc("eth_maxPriorityFeePerGas", []) as Promise<string>,
    ]);
    if (block && typeof block === "object" && block.baseFeePerGas && typeof tipHex === "string") {
      const base = hexQuantity(block.baseFeePerGas);
      const tip = hexQuantity(tipHex);
      return { maxFeePerGas: base * 2n + tip, maxPriorityFeePerGas: tip, gasPrice: null };
    }
  } catch {
    // Fall through to a legacy gas price.
  }
  const gasPrice = await rpc("eth_gasPrice", []);
  if (typeof gasPrice !== "string") throw new DappError(-32603, "Hemi did not return a network fee.");
  return { maxFeePerGas: null, maxPriorityFeePerGas: null, gasPrice: hexQuantity(gasPrice) };
}

async function broadcast(prepared: PreparedTx, wallet: string): Promise<string> {
  const nonce = prepared.nonce ?? safeNonce(hexQuantity(await rpc("eth_getTransactionCount", [wallet, "pending"])));
  const shared = {
    chainId: HEMI_CHAIN_ID,
    nonce,
    gasLimit: prepared.gasLimit,
    to: prepared.to,
    value: prepared.value,
    data: prepared.data,
  };
  const unsigned = prepared.maxFeePerGas != null
    ? Transaction.from({
      ...shared,
      type: 2,
      maxFeePerGas: prepared.maxFeePerGas,
      maxPriorityFeePerGas: prepared.maxPriorityFeePerGas ?? 0n,
    })
    : Transaction.from({
      ...shared,
      type: 0,
      gasPrice: prepared.gasPrice ?? 1n,
    });
  unsigned.signature = signEvm(unsigned.unsignedSerialized);
  if ((unsigned.from ?? "").toLowerCase() !== wallet.toLowerCase()) {
    throw new DappError(-32603, "The signing key does not match this address.");
  }
  const hash = await rpc("eth_sendRawTransaction", [unsigned.serialized]);
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new DappError(-32603, "Hemi did not return a transaction hash.");
  }
  return hash;
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(HEMI_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  } catch {
    throw new DappError(-32603, "Hemi did not answer.");
  }
  if (!res.ok) throw new DappError(-32603, "Hemi did not answer.");
  const body = await res.json() as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new DappError(-32603, body.error.message || "Hemi rejected this request.");
  return body.result ?? null;
}

function safeNonce(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new DappError(-32602, "That nonce is not valid.");
  return Number(value);
}
