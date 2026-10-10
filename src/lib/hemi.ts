import { Contract, JsonRpcProvider, Wallet, getAddress, isAddress } from "ethers";
import { HEMIBTC, HEMI_CHAIN_ID, HEMI_EXPLORER, HEMI_RPC, HEMI_TOKEN, MEMPOOL, VAULT_FACTORY, VAULT_INDEX, VUSD } from "../chain";

const erc20Abi = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const factoryAbi = [
  "function vaults(uint32) view returns (address)",
  "function initiateWithdrawal(uint32 vaultIndex, string btcAddress, uint256 amount) returns (uint256)",
  "function confirmDeposit(uint32 vaultIndex, bytes32 txid, uint256 outputIndex, bytes extraInfo) returns (bool)",
];

const vaultAbi = [
  "function bitcoinCustodyAddress() view returns (string)",
  "function MINIMUM_DEPOSIT_SATS() view returns (uint256)",
  "function MINIMUM_WITHDRAWAL_SATS() view returns (uint256)",
  "function MIN_BITCOIN_CONFIRMATIONS() view returns (uint32)",
  "function isAcceptingDeposits() view returns (bool)",
  "function vaultStateChild() view returns (address)",
];

const stateAbi = [
  "function calculateDepositFee(uint256) view returns (uint256)",
  "function calculateWithdrawalFee(uint256) view returns (uint256)",
  "function depositFeeBps() view returns (uint256)",
  "function minDepositFeeSats() view returns (uint256)",
  "function withdrawalFeeBps() view returns (uint256)",
  "function minWithdrawalFeeSats() view returns (uint256)",
];

export function hemiProvider(): JsonRpcProvider {
  return new JsonRpcProvider(HEMI_RPC, HEMI_CHAIN_ID);
}

export function requireEvmAddress(value: string): string {
  const text = value.trim();
  if (!isAddress(text)) throw new Error("Enter a Hemi address (0x…).");
  return getAddress(text);
}

export type HemiHoldings = {
  hemiSats: bigint;
  ethWei: bigint;
  symbol: string;
  decimals: number;
};

/** Native ETH plus the hemiBTC ERC-20 held by this Hemi address. */
export async function readHemiBalances(address: string): Promise<HemiHoldings> {
  const provider = hemiProvider();
  const token = new Contract(HEMIBTC, erc20Abi, provider);
  const [hemiSats, ethWei, symbol, decimals] = await Promise.all([
    token.balanceOf(address) as Promise<bigint>,
    provider.getBalance(address),
    token.symbol().catch(() => "hemiBTC") as Promise<string>,
    token.decimals().catch(() => 8) as Promise<bigint | number>,
  ]);
  const places = Number(decimals);
  return {
    hemiSats,
    ethWei,
    symbol: symbol || "hemiBTC",
    decimals: Number.isInteger(places) && places >= 0 && places <= 18 ? places : 8,
  };
}

export type VaultQuote = {
  vaultAddress: string;
  stateAddress: string;
  custodyAddress: string;
  minDepositSats: bigint;
  minWithdrawSats: bigint;
  confirmations: number;
  accepting: boolean;
  depositFeeBps: bigint;
  minDepositFeeSats: bigint;
  withdrawFeeBps: bigint;
  minWithdrawFeeSats: bigint;
};

export async function readVault(): Promise<VaultQuote> {
  const provider = hemiProvider();
  const factory = new Contract(VAULT_FACTORY, factoryAbi, provider);
  const vaultAddress = (await factory.vaults(VAULT_INDEX)) as string;
  const vault = new Contract(vaultAddress, vaultAbi, provider);
  const [custodyAddress, minDepositSats, minWithdrawSats, confirmations, accepting, stateAddress] =
    await Promise.all([
      vault.bitcoinCustodyAddress() as Promise<string>,
      vault.MINIMUM_DEPOSIT_SATS() as Promise<bigint>,
      vault.MINIMUM_WITHDRAWAL_SATS() as Promise<bigint>,
      vault.MIN_BITCOIN_CONFIRMATIONS() as Promise<bigint>,
      vault.isAcceptingDeposits() as Promise<boolean>,
      vault.vaultStateChild() as Promise<string>,
    ]);
  const state = new Contract(stateAddress, stateAbi, provider);
  const [depositFeeBps, minDepositFeeSats, withdrawFeeBps, minWithdrawFeeSats] = await Promise.all([
    state.depositFeeBps() as Promise<bigint>,
    state.minDepositFeeSats() as Promise<bigint>,
    state.withdrawalFeeBps() as Promise<bigint>,
    state.minWithdrawalFeeSats() as Promise<bigint>,
  ]);
  return {
    vaultAddress,
    stateAddress,
    custodyAddress,
    minDepositSats,
    minWithdrawSats,
    confirmations: Number(confirmations),
    accepting,
    depositFeeBps,
    minDepositFeeSats,
    withdrawFeeBps,
    minWithdrawFeeSats,
  };
}

export async function quoteVaultFee(stateAddress: string, kind: "deposit" | "withdraw", amount: bigint): Promise<bigint> {
  const state = new Contract(stateAddress, stateAbi, hemiProvider());
  if (kind === "deposit") return state.calculateDepositFee(amount) as Promise<bigint>;
  return state.calculateWithdrawalFee(amount) as Promise<bigint>;
}

export function fallbackVaultFee(amount: bigint, bps: bigint, minFee: bigint): bigint {
  const proportional = (amount * bps) / 10_000n;
  return proportional > minFee ? proportional : minFee;
}

export async function sendEth(privateKey: string, to: string, amount: bigint): Promise<string> {
  const wallet = new Wallet(privateKey, hemiProvider());
  const tx = await wallet.sendTransaction({ to: requireEvmAddress(to), value: amount });
  const receipt = await tx.wait();
  return receipt?.hash ?? tx.hash;
}

export type Erc20Balance = {
  raw: bigint;
  symbol: string;
  decimals: number;
};

/** ERC-20 balance, symbol, and decimals for one Hemi token. */
export async function readErc20(
  holder: string,
  tokenAddress: string,
  fallbackSymbol: string,
  fallbackDecimals: number,
): Promise<Erc20Balance> {
  const token = new Contract(tokenAddress, erc20Abi, hemiProvider());
  const [raw, symbol, decimals] = await Promise.all([
    token.balanceOf(holder) as Promise<bigint>,
    token.symbol().catch(() => fallbackSymbol) as Promise<string>,
    token.decimals().catch(() => fallbackDecimals) as Promise<bigint | number>,
  ]);
  const places = Number(decimals);
  return {
    raw,
    symbol: symbol || fallbackSymbol,
    decimals: Number.isInteger(places) && places >= 0 && places <= 18 ? places : fallbackDecimals,
  };
}

export async function sendErc20(privateKey: string, tokenAddress: string, to: string, amount: bigint): Promise<string> {
  const wallet = new Wallet(privateKey, hemiProvider());
  const token = new Contract(tokenAddress, erc20Abi, wallet);
  const tx = await token.transfer(requireEvmAddress(to), amount);
  const receipt = await tx.wait();
  return receipt?.hash ?? tx.hash;
}

export async function sendHemiBtc(privateKey: string, to: string, amount: bigint): Promise<string> {
  return sendErc20(privateKey, HEMIBTC, to, amount);
}

export async function withdrawToBitcoin(privateKey: string, btcAddress: string, amount: bigint): Promise<string> {
  const wallet = new Wallet(privateKey, hemiProvider());
  const factory = new Contract(VAULT_FACTORY, factoryAbi, wallet);
  const tx = await factory.initiateWithdrawal(VAULT_INDEX, btcAddress, amount);
  const receipt = await tx.wait();
  return receipt?.hash ?? tx.hash;
}

export async function confirmHemiDeposit(
  privateKey: string,
  txid: string,
  outputIndex: number,
): Promise<string> {
  const wallet = new Wallet(privateKey, hemiProvider());
  const factory = new Contract(VAULT_FACTORY, factoryAbi, wallet);
  const id = txid.startsWith("0x") ? txid : `0x${txid}`;
  const tx = await factory.confirmDeposit(VAULT_INDEX, id, BigInt(outputIndex), "0x");
  const receipt = await tx.wait();
  return receipt?.hash ?? tx.hash;
}

export function hemiAddressUrl(address: string): string {
  return `${HEMI_EXPLORER}/address/${address}`;
}

export function hemiTxUrl(hash: string): string {
  return `${HEMI_EXPLORER}/tx/${hash}`;
}

export function btcTxUrl(txid: string): string {
  return `${MEMPOOL}/tx/${txid}`;
}

export function btcAddressUrl(address: string): string {
  return `${MEMPOOL}/address/${address}`;
}

export type ChainLeg = {
  /** Signed raw units. Negative leaves the wallet. */
  amount: string;
  decimals: number;
  symbol: string;
};

export type ChainRow = {
  id: string;
  when: number;
  title: string;
  detail: string;
  href: string;
  legs: ChainLeg[];
};

type MempoolTx = {
  txid: string;
  status: { confirmed: boolean; block_time?: number };
  vin: { prevout?: { scriptpubkey_address?: string; value?: number } }[];
  vout: { scriptpubkey_address?: string; value?: number }[];
};

export async function readBtcActivity(address: string): Promise<ChainRow[]> {
  const res = await fetch(`${MEMPOOL}/api/address/${address}/txs`);
  if (!res.ok) throw new Error("Bitcoin history is unavailable.");
  const txs = (await res.json()) as MempoolTx[];
  return txs.slice(0, 12).map((tx) => {
    let incoming = 0n;
    let outgoing = 0n;
    for (const input of tx.vin) {
      if (input.prevout?.scriptpubkey_address === address) outgoing += BigInt(input.prevout.value ?? 0);
    }
    for (const output of tx.vout) {
      if (output.scriptpubkey_address === address) incoming += BigInt(output.value ?? 0);
    }
    const delta = incoming - outgoing;
    const when = (tx.status.block_time ?? Math.floor(Date.now() / 1000)) * 1000;
    return {
      id: tx.txid,
      when,
      title: delta >= 0n ? "Bitcoin received" : "Bitcoin sent",
      detail: tx.status.confirmed ? "Confirmed" : "In the mempool",
      href: btcTxUrl(tx.txid),
      legs: [{ amount: delta.toString(), decimals: 8, symbol: "BTC" }],
    };
  });
}

const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  [HEMIBTC.toLowerCase()]: { symbol: "hemiBTC", decimals: 8 },
  [HEMI_TOKEN.toLowerCase()]: { symbol: "HEMI", decimals: 18 },
  [VUSD.toLowerCase()]: { symbol: "VUSD", decimals: 18 },
};

type Party = { hash?: string } | null;

type ExplorerTransfer = {
  tx_hash?: string;
  timestamp?: string;
  from?: Party;
  to?: Party;
  total?: { value?: string; decimals?: string };
  token?: { address?: string; symbol?: string; decimals?: string; type?: string };
};

type ExplorerTx = {
  hash?: string;
  timestamp?: string;
  from?: Party;
  to?: Party;
  value?: string;
  status?: string;
};

type ExplorerInternal = {
  transaction_hash?: string;
  tx_hash?: string;
  timestamp?: string;
  from?: Party;
  to?: Party;
  value?: string;
  success?: boolean;
  type?: string;
};

type LegAcc = { symbol: string; decimals: number; delta: bigint };

type TxAcc = {
  hash: string;
  when: number;
  legs: Map<string, LegAcc>;
  other: string;
};

function party(value: Party | undefined): string {
  return value?.hash?.toLowerCase() ?? "";
}

function rawInt(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

function asDecimals(value: unknown, fallback: number): number {
  const n = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > 18) return fallback;
  return n;
}

function whenOf(timestamp: string | undefined): number {
  const ms = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function shortParty(addr: string): string {
  return addr ? `${addr.slice(0, 8)}…` : "Hemi";
}

function tokenMeta(token: ExplorerTransfer["token"]): { key: string; symbol: string; decimals: number } | null {
  const address = token?.address?.toLowerCase() ?? "";
  if (!/^0x[0-9a-f]{40}$/.test(address)) return null;
  const known = KNOWN_TOKENS[address];
  const symbol = (known?.symbol ?? token?.symbol ?? "TOKEN").replace(/[^\w.$+-]/g, "").slice(0, 12) || "TOKEN";
  return {
    key: address,
    symbol,
    decimals: asDecimals(token?.decimals, known?.decimals ?? 18),
  };
}

function touch(map: Map<string, TxAcc>, hash: string, when: number): TxAcc {
  const row = map.get(hash) ?? { hash, when, legs: new Map(), other: "" };
  if (when > row.when) row.when = when;
  map.set(hash, row);
  return row;
}

function addLeg(row: TxAcc, key: string, symbol: string, decimals: number, delta: bigint, other: string) {
  if (delta === 0n) return;
  const cur = row.legs.get(key) ?? { symbol, decimals, delta: 0n };
  cur.delta += delta;
  cur.symbol = symbol || cur.symbol;
  cur.decimals = decimals;
  row.legs.set(key, cur);
  if (other) row.other = other;
}

/** Group token and ETH legs that share a transaction. A pay leg plus a receive leg is a swap. */
export function buildHemiRows(input: {
  mine: string;
  transfers: ExplorerTransfer[];
  transactions: ExplorerTx[];
  internals: ExplorerInternal[];
}): ChainRow[] {
  const mine = input.mine.toLowerCase();
  const grouped = new Map<string, TxAcc>();
  const failed = new Set<string>();
  const tops = new Map<string, { from: string; to: string; value: bigint }>();

  for (const tx of input.transactions) {
    const hash = tx.hash?.toLowerCase() ?? "";
    if (!/^0x[0-9a-f]{64}$/.test(hash)) continue;
    if (tx.status === "error") {
      failed.add(hash);
      continue;
    }
    const value = rawInt(tx.value);
    if (value == null || value === 0n) continue;
    const from = party(tx.from);
    const to = party(tx.to);
    tops.set(hash, { from, to, value });
    const row = touch(grouped, hash, whenOf(tx.timestamp));
    if (from === mine && to !== mine) addLeg(row, "eth", "ETH", 18, -value, to);
    if (to === mine && from !== mine) addLeg(row, "eth", "ETH", 18, value, from);
  }

  for (const transfer of input.transfers) {
    const hash = transfer.tx_hash?.toLowerCase() ?? "";
    if (!/^0x[0-9a-f]{64}$/.test(hash) || failed.has(hash)) continue;
    if (transfer.token?.type && transfer.token.type !== "ERC-20") continue;
    const meta = tokenMeta(transfer.token);
    const value = rawInt(transfer.total?.value);
    if (!meta || value == null || value === 0n) continue;
    const from = party(transfer.from);
    const to = party(transfer.to);
    const row = touch(grouped, hash, whenOf(transfer.timestamp));
    if (from === mine && to !== mine) addLeg(row, meta.key, meta.symbol, meta.decimals, -value, to);
    if (to === mine && from !== mine) addLeg(row, meta.key, meta.symbol, meta.decimals, value, from);
  }

  for (const call of input.internals) {
    if (call.success === false || call.type === "delegatecall") continue;
    const hash = (call.transaction_hash ?? call.tx_hash)?.toLowerCase() ?? "";
    if (!/^0x[0-9a-f]{64}$/.test(hash) || failed.has(hash)) continue;
    const value = rawInt(call.value);
    if (value == null || value === 0n) continue;
    const from = party(call.from);
    const to = party(call.to);
    const top = tops.get(hash);
    if (top && top.from === from && top.to === to && top.value === value) continue;
    const row = touch(grouped, hash, whenOf(call.timestamp));
    if (from === mine && to !== mine) addLeg(row, "eth", "ETH", 18, -value, to);
    if (to === mine && from !== mine) addLeg(row, "eth", "ETH", 18, value, from);
  }

  const rows: ChainRow[] = [];
  for (const row of grouped.values()) {
    const legs = [...row.legs.values()]
      .filter((leg) => leg.delta !== 0n)
      .sort((a, b) => {
        if ((a.delta < 0n) !== (b.delta < 0n)) return a.delta < 0n ? -1 : 1;
        const absA = a.delta < 0n ? -a.delta : a.delta;
        const absB = b.delta < 0n ? -b.delta : b.delta;
        if (absA === absB) return 0;
        return absA > absB ? -1 : 1;
      });
    if (legs.length === 0) continue;
    const spent = legs.filter((leg) => leg.delta < 0n);
    const gained = legs.filter((leg) => leg.delta > 0n);
    const swap = spent.length > 0 && gained.length > 0;
    const one = legs.length === 1 ? legs[0] : null;
    const inbound = one != null && one.delta > 0n;
    rows.push({
      id: row.hash,
      when: row.when,
      title: swap ? "Swap" : one ? `${one.symbol} ${inbound ? "received" : "sent"}` : spent.length ? "Sent" : "Received",
      detail: swap
        ? `${spent[0].symbol} → ${gained[0].symbol}`
        : one
          ? `${inbound ? "From" : "To"} ${shortParty(row.other)}`
          : legs.map((leg) => leg.symbol).join(", "),
      href: hemiTxUrl(row.hash),
      legs: legs.slice(0, 3).map((leg) => ({
        amount: leg.delta.toString(),
        decimals: leg.decimals,
        symbol: leg.symbol,
      })),
    });
  }
  return rows.sort((a, b) => b.when - a.when).slice(0, 40);
}

async function readExplorer<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function readHemiActivity(address: string): Promise<ChainRow[]> {
  const base = `${HEMI_EXPLORER}/api/v2/addresses/${address}`;
  const [transfers, transactions, internals] = await Promise.all([
    readExplorer<{ items?: ExplorerTransfer[] }>(`${base}/token-transfers?type=ERC-20`),
    readExplorer<{ items?: ExplorerTx[] }>(`${base}/transactions`),
    readExplorer<{ items?: ExplorerInternal[] }>(`${base}/internal-transactions`),
  ]);
  if (!transfers && !transactions) throw new Error("Hemi history is unavailable.");
  return buildHemiRows({
    mine: address,
    transfers: (transfers?.items ?? []).slice(0, 50),
    transactions: (transactions?.items ?? []).slice(0, 50),
    internals: (internals?.items ?? []).slice(0, 50),
  });
}

/** True when Hemi has mined this transaction successfully. */
export async function readHemiMined(hash: string): Promise<boolean> {
  const receipt = await hemiProvider().getTransactionReceipt(hash);
  return receipt != null && receipt.status === 1;
}

export async function readBtcConfirmations(txid: string): Promise<number> {
  const [statusRes, tipRes] = await Promise.all([
    fetch(`${MEMPOOL}/api/tx/${txid}/status`),
    fetch(`${MEMPOOL}/api/blocks/tip/height`),
  ]);
  if (!statusRes.ok || !tipRes.ok) return 0;
  const status = (await statusRes.json()) as { confirmed: boolean; block_height?: number };
  if (!status.confirmed || status.block_height == null) return 0;
  const tip = Number(await tipRes.text());
  return tip - status.block_height + 1;
}
