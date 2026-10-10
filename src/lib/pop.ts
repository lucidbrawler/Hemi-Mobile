import { Contract, JsonRpcProvider } from "ethers";
import { HEMI_CHAIN_ID, HEMI_EXPLORER, HEMI_RPC, HEMI_TOKEN, KEYSTONE_EVERY, MEMPOOL, VAULT_FACTORY } from "../chain.ts";

const POP_MAGIC = "48454d49";

const erc20Abi = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
];

const factoryAbi = ["function globalConfig() view returns (address)"];
const configAbi = ["function bitcoinKitAddr() view returns (address)"];
const kitAbi = [
  "function getLastHeader() view returns (tuple(uint32 height, bytes32 blockHash, uint32 version, bytes32 previousBlockHash, bytes32 merkleRoot, uint32 timestamp, uint32 bits, uint32 nonce))",
];

export type PopPublication = {
  txid: string;
  confirmed: boolean;
  when: number | null;
};

export type PopReward = {
  tx: string;
  when: string;
  amount: bigint;
  decimals: number;
};

export type PopDash = {
  hemiBlock: number;
  hemiTime: number;
  blocksUntilKeystone: number;
  onKeystoneBoundary: boolean;
  bitcoinKitHeight: number | null;
  mempoolHeight: number | null;
  kitLag: number | null;
  fastestFee: number | null;
  halfHourFee: number | null;
  hourFee: number | null;
  symbol: string;
  decimals: number;
  hemiBalance: bigint | null;
  scanned: number;
  publications: PopPublication[];
  rewards: PopReward[];
  notes: string[];
};

type MempoolTx = {
  txid: string;
  status?: { confirmed?: boolean; block_time?: number };
  vout?: { scriptpubkey?: string; scriptpubkey_type?: string }[];
};

/** True when a Bitcoin output is an OP_RETURN whose data starts with the HEMI PoP magic. */
export function isPopPublication(script: string): boolean {
  const hex = script.replace(/^0x/i, "").toLowerCase();
  if (!hex.startsWith("6a")) return false;
  const magicAt = hex.indexOf(POP_MAGIC);
  return magicAt >= 0 && magicAt <= 12;
}

function blocksUntilKeystone(height: number): { until: number; onBoundary: boolean } {
  const mod = height % KEYSTONE_EVERY;
  if (mod === 0) return { until: 0, onBoundary: true };
  return { until: KEYSTONE_EVERY - mod, onBoundary: false };
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} from ${url}`);
  return res.json();
}

export async function readPopDash(btcAddress: string, hemiAddress: string): Promise<PopDash> {
  const provider = new JsonRpcProvider(HEMI_RPC, HEMI_CHAIN_ID);
  const notes: string[] = [];

  const blockPromise = provider.getBlock("latest");
  const kitPromise = (async () => {
    const factory = new Contract(VAULT_FACTORY, factoryAbi, provider);
    const config = new Contract(await factory.globalConfig(), configAbi, provider);
    const kit = new Contract(await config.bitcoinKitAddr(), kitAbi, provider);
    const header = await kit.getLastHeader();
    return Number(header.height);
  })();
  const tipPromise = fetch(`${MEMPOOL}/api/blocks/tip/height`).then(async (res) => {
    if (!res.ok) throw new Error("Bitcoin tip is unavailable.");
    return Number(await res.text());
  });
  const feePromise = getJson(`${MEMPOOL}/api/v1/fees/recommended`) as Promise<{
    fastestFee?: number;
    halfHourFee?: number;
    hourFee?: number;
  }>;
  const txPromise = getJson(`${MEMPOOL}/api/address/${encodeURIComponent(btcAddress)}/txs`) as Promise<MempoolTx[]>;
  const tokenPromise = (async () => {
    const token = new Contract(HEMI_TOKEN, erc20Abi, provider);
    const [symbol, decimals, balance] = await Promise.all([
      token.symbol() as Promise<string>,
      token.decimals() as Promise<bigint>,
      token.balanceOf(hemiAddress) as Promise<bigint>,
    ]);
    return { symbol: symbol || "HEMI", decimals: Number(decimals), balance };
  })();
  const rewardPromise = getJson(
    `${HEMI_EXPLORER}/api/v2/addresses/${hemiAddress}/token-transfers?type=ERC-20&token=${HEMI_TOKEN}`,
  ) as Promise<{ items?: { tx_hash: string; timestamp: string; to?: { hash?: string }; total?: { value?: string; decimals?: string } }[] }>;

  const [block, kit, tip, fees, txs, token, rewardsBody] = await Promise.all([
    blockPromise,
    kitPromise.then((height) => ({ height, error: null as string | null })).catch((err: unknown) => ({
      height: null,
      error: err instanceof Error ? err.message : "Bitcoin kit is unavailable.",
    })),
    tipPromise.then((height) => ({ height, error: null as string | null })).catch(() => ({ height: null, error: "Bitcoin tip is unavailable." })),
    feePromise.then((row) => row).catch(() => null),
    txPromise.then((rows) => rows).catch(() => null),
    tokenPromise.then((row) => row).catch(() => null),
    rewardPromise.then((body) => body).catch(() => null),
  ]);

  if (!block) throw new Error("Hemi tip is unavailable.");
  if (kit.error) notes.push(kit.error);
  if (tip.error) notes.push(tip.error);

  const hemiBlock = Number(block.number);
  const boundary = blocksUntilKeystone(hemiBlock);
  const list = Array.isArray(txs) ? txs : [];
  if (!Array.isArray(txs)) notes.push("Bitcoin history for this address is unavailable.");

  const publications = list.flatMap((tx) => {
    const hit = (tx.vout ?? []).some((out) => out.scriptpubkey && isPopPublication(out.scriptpubkey));
    if (!hit) return [];
    return [{
      txid: tx.txid,
      confirmed: Boolean(tx.status?.confirmed),
      when: tx.status?.block_time ? tx.status.block_time * 1000 : null,
    }];
  }).slice(0, 8);

  const mine = hemiAddress.toLowerCase();
  const rewards: PopReward[] = (rewardsBody?.items ?? []).flatMap((row) => {
    if (String(row.to?.hash || "").toLowerCase() !== mine) return [];
    const decimals = Number(row.total?.decimals ?? token?.decimals ?? 18);
    return [{
      tx: row.tx_hash,
      when: row.timestamp,
      amount: BigInt(row.total?.value || "0"),
      decimals: Number.isInteger(decimals) ? decimals : 18,
    }];
  }).slice(0, 6);

  const kitLag = kit.height != null && tip.height != null ? tip.height - kit.height : null;

  return {
    hemiBlock,
    hemiTime: block.timestamp * 1000,
    blocksUntilKeystone: boundary.until,
    onKeystoneBoundary: boundary.onBoundary,
    bitcoinKitHeight: kit.height,
    mempoolHeight: tip.height,
    kitLag,
    fastestFee: fees?.fastestFee ?? null,
    halfHourFee: fees?.halfHourFee ?? null,
    hourFee: fees?.hourFee ?? null,
    symbol: token?.symbol ?? "HEMI",
    decimals: token?.decimals ?? 18,
    hemiBalance: token?.balance ?? null,
    scanned: list.length,
    publications,
    rewards,
    notes,
  };
}
