import { hex } from "@scure/base";
import { Address, NETWORK, Transaction, p2wpkh } from "@scure/btc-signer";
import { DUST_SATS, MEMPOOL } from "../chain.ts";
import { requirePublic, signBitcoin } from "./sessionVault.ts";

export type Utxo = { txid: string; vout: number; value: number };

export type BuiltTx = {
  hex: string;
  txid: string;
  feeSats: bigint;
  vsize: number;
  outputIndex: number;
};

type PaymentOut = { address: string; amount: bigint };
type ExtraOut = { script: Uint8Array; amount: bigint };

/** ASCII uppercase Hemi address without 0x. The vault reads this OP_RETURN. */
export function tunnelMemo(hemiAddress: string): Uint8Array {
  const body = hemiAddress.trim().slice(2).toUpperCase();
  if (!/^[0-9A-F]{40}$/.test(body)) throw new Error("Hemi address must be 20 bytes.");
  return new TextEncoder().encode(body);
}

function scriptPush(data: Uint8Array): Uint8Array {
  if (data.length >= 76) throw new Error("Memo is too long for a single OP_RETURN push.");
  const out = new Uint8Array(2 + data.length);
  out[0] = 0x6a;
  out[1] = data.length;
  out.set(data, 2);
  return out;
}

export function assertBtcAddress(address: string): string {
  const text = address.trim();
  try {
    Address(NETWORK).decode(text);
  } catch {
    throw new Error("Enter a Bitcoin address.");
  }
  return text;
}

/** Miner fee for a plain send, from the live UTXOs and fee rate. Null when the quote cannot be built. */
export async function quoteBtcSendFee(address: string, amount: bigint): Promise<bigint | null> {
  if (amount <= 0n) return null;
  try {
    const [utxos, rate] = await Promise.all([fetchUtxos(address), fetchFeeRate()]);
    if (utxos.length === 0 || !Number.isFinite(rate) || rate <= 0) return null;
    return estimateSpend(utxos, amount, rate, false);
  } catch {
    return null;
  }
}

/** Rough miner fee for a payment of `amount`, including an OP_RETURN when `withMemo` is set. */
export function estimateSpend(utxos: Utxo[], amount: bigint, feeRate: number, withMemo: boolean): bigint {
  const outputs = withMemo ? 3 : 2;
  let sum = 0n;
  let count = 0;
  for (const utxo of utxos) {
    count += 1;
    sum += BigInt(utxo.value);
    const fee = BigInt(feeRate) * guessVsize(count, outputs);
    if (sum >= amount + fee + DUST_SATS) return fee;
  }
  return BigInt(feeRate) * guessVsize(Math.max(1, count), outputs);
}

/** True when `address` receives at least `minSats` in a transaction at or after `sinceMs`. */
export async function findBtcCredit(address: string, sinceMs: number, minSats: bigint): Promise<boolean> {
  if (minSats <= 0n) return false;
  const res = await fetch(`${MEMPOOL}/api/address/${address}/txs`);
  if (!res.ok) return false;
  const txs = (await res.json()) as {
    status?: { confirmed?: boolean; block_time?: number };
    vout?: { scriptpubkey_address?: string; value?: number }[];
  }[];
  for (const tx of txs) {
    const when = tx.status?.block_time ? tx.status.block_time * 1000 : Date.now();
    if (when + 120_000 < sinceMs) continue;
    const got = (tx.vout ?? [])
      .filter((out) => out.scriptpubkey_address === address)
      .reduce((sum, out) => sum + BigInt(out.value ?? 0), 0n);
    if (got >= minSats) return true;
  }
  return false;
}

export async function fetchUtxos(address: string): Promise<Utxo[]> {
  const res = await fetch(`${MEMPOOL}/api/address/${address}/utxo`);
  if (!res.ok) throw new Error("Could not load Bitcoin coins.");
  const rows = (await res.json()) as Utxo[];
  return rows.sort((a, b) => b.value - a.value);
}

export async function fetchFeeRate(): Promise<number> {
  const res = await fetch(`${MEMPOOL}/api/v1/fees/recommended`);
  if (!res.ok) return 5;
  const body = (await res.json()) as { halfHourFee?: number };
  return Math.max(1, body.halfHourFee ?? 5);
}

export async function fetchBtcBalance(address: string): Promise<bigint> {
  const res = await fetch(`${MEMPOOL}/api/address/${address}`);
  if (!res.ok) throw new Error("Could not load the Bitcoin balance.");
  const body = (await res.json()) as {
    chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
    mempool_stats: { funded_txo_sum: number; spent_txo_sum: number };
  };
  const confirmed = BigInt(body.chain_stats.funded_txo_sum - body.chain_stats.spent_txo_sum);
  const pending = BigInt(body.mempool_stats.funded_txo_sum - body.mempool_stats.spent_txo_sum);
  return confirmed + pending;
}

export async function fetchBtcPrice(): Promise<number> {
  const res = await fetch(`${MEMPOOL}/api/v1/prices`);
  if (!res.ok) throw new Error("Could not load the BTC price.");
  const body = (await res.json()) as { USD: number };
  return body.USD;
}

export async function broadcastTx(rawHex: string): Promise<string> {
  const res = await fetch(`${MEMPOOL}/api/tx`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: rawHex,
  });
  const text = (await res.text()).trim();
  if (!res.ok) throw new Error(text || "Bitcoin rejected the transaction.");
  return text;
}

function paymentScript(publicKey: Uint8Array): Uint8Array {
  const payment = p2wpkh(publicKey, NETWORK);
  if (!payment.script) throw new Error("Could not build the Bitcoin spend script.");
  return payment.script;
}

type UnsignedSpend = { tx: Transaction; feeSats: bigint; vsize: number };

/** Worst-case native-segwit witness, so the fee is not short a byte before signing. */
function placeholderVsize(tx: Transaction, publicKey: Uint8Array): number {
  const copy = tx.clone();
  const dummy = new Uint8Array(73);
  dummy[0] = 0x30;
  for (let i = 0; i < copy.inputsLength; i += 1) {
    copy.updateInput(i, { partialSig: [[publicKey, dummy]] }, true);
  }
  copy.finalize();
  return Math.ceil(copy.weight / 4);
}

/**
 * Unsigned native-segwit spend. `payTo` is output 0, which confirmDeposit expects.
 * Optional OP_RETURN follows it. The session signer adds the signature.
 */
function buildUnsignedSpend(input: {
  publicKey: Uint8Array;
  utxos: Utxo[];
  payTo: PaymentOut;
  memo?: Uint8Array;
  changeAddress: string;
  feeRate: number;
}): UnsignedSpend {
  if (input.payTo.amount <= 0n) throw new Error("Amount must be greater than zero.");
  const script = paymentScript(input.publicKey);
  const extras: ExtraOut[] = input.memo ? [{ script: scriptPush(input.memo), amount: 0n }] : [];
  let fee = BigInt(input.feeRate) * guessVsize(2, extras.length + 2);
  let last: UnsignedSpend | null = null;

  for (let attempt = 0; attempt < 4; attempt++) {
    const selected: Utxo[] = [];
    let sum = 0n;
    for (const utxo of input.utxos) {
      selected.push(utxo);
      sum += BigInt(utxo.value);
      const withChange = guessVsize(selected.length, extras.length + 2);
      const noChange = guessVsize(selected.length, extras.length + 1);
      const feeIfChange = BigInt(input.feeRate) * withChange;
      const feeIfDrop = BigInt(input.feeRate) * noChange;
      if (sum >= input.payTo.amount + feeIfChange + DUST_SATS) {
        fee = feeIfChange;
        break;
      }
      if (sum >= input.payTo.amount + feeIfDrop) {
        fee = feeIfDrop;
        break;
      }
    }
    if (sum < input.payTo.amount + fee) {
      throw new Error("Not enough Bitcoin for that amount and the network fee.");
    }
    let change = sum - input.payTo.amount - fee;
    const outputs = extras.length + (change >= DUST_SATS ? 2 : 1);
    fee = BigInt(input.feeRate) * guessVsize(selected.length, outputs);
    if (sum < input.payTo.amount + fee) {
      throw new Error("Not enough Bitcoin for that amount and the network fee.");
    }
    change = sum - input.payTo.amount - fee;
    const keepChange = change >= DUST_SATS;
    if (!keepChange) {
      fee += change;
      change = 0n;
    }

    const tx = new Transaction({ allowUnknownOutputs: true });
    for (const utxo of selected) {
      tx.addInput({
        txid: utxo.txid,
        index: utxo.vout,
        witnessUtxo: { script, amount: BigInt(utxo.value) },
      });
    }
    tx.addOutputAddress(input.payTo.address, input.payTo.amount, NETWORK);
    for (const extra of extras) tx.addOutput({ script: extra.script, amount: extra.amount });
    if (keepChange) tx.addOutputAddress(input.changeAddress, change, NETWORK);
    const vsize = placeholderVsize(tx, input.publicKey);
    const exact = BigInt(input.feeRate) * BigInt(vsize);
    last = { tx, feeSats: fee, vsize };
    if (exact === fee || attempt === 3) return last;
    fee = exact;
  }
  if (!last) throw new Error("Could not build the Bitcoin transaction.");
  return last;
}

/** Unsigned PSBT. Tests and the session signer use this. */
export function planBtcPsbt(input: {
  publicKey: Uint8Array;
  utxos: Utxo[];
  payTo: PaymentOut;
  memo?: Uint8Array;
  changeAddress: string;
  feeRate: number;
}): { psbt: Uint8Array; feeSats: bigint; vsize: number } {
  const planned = buildUnsignedSpend(input);
  return { psbt: planned.tx.toPSBT(2), feeSats: planned.feeSats, vsize: planned.vsize };
}

/** Sign with the open session and return the raw transaction. */
export function spendBitcoin(input: {
  utxos: Utxo[];
  payTo: PaymentOut;
  memo?: Uint8Array;
  feeRate: number;
}): BuiltTx {
  const pubs = requirePublic();
  const planned = planBtcPsbt({
    publicKey: pubs.btcPublicKey,
    utxos: input.utxos,
    payTo: input.payTo,
    memo: input.memo,
    changeAddress: pubs.btcAddress,
    feeRate: input.feeRate,
  });
  const signed = signBitcoin(planned.psbt);
  return {
    hex: signed.hex,
    txid: signed.txid,
    feeSats: planned.feeSats,
    vsize: planned.vsize,
    outputIndex: 0,
  };
}

function guessVsize(inputs: number, outputs: number): bigint {
  return BigInt(11 + inputs * 68 + outputs * 43);
}

export function memoScriptHex(hemiAddress: string): string {
  return hex.encode(scriptPush(tunnelMemo(hemiAddress)));
}
