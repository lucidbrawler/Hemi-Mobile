import { Capacitor } from "@capacitor/core";
import { Contract, Wallet, getAddress } from "ethers";
import { HEMI_CHAIN_ID, MERKL_DISTRIBUTOR } from "../chain";
import { hemiProvider } from "./hemi";
import {
  poolAddress,
  readMerklWallet,
  readOpportunity,
  type MerklAmount,
  type MerklClaimToken,
  type MerklIncentive,
  type MerklWalletRewards,
} from "./merklParse";
import { legsUsd, type PriceBook } from "./prices";

export type { MerklAmount, MerklClaimToken, MerklIncentive, MerklPoolReward, MerklWalletRewards } from "./merklParse";
export {
  merklAmountLine,
  merklClaimable,
  merklForPool,
  merklPayoutCoversMore,
  merklPayoutLine,
  merklTokenAddresses,
  readMerklWallet,
} from "./merklParse";

const FRESH_MS = 4 * 60 * 1000;
const USER_FRESH_MS = 2 * 60 * 1000;

const distributorAbi = [
  "function claim(address[] users, address[] tokens, uint256[] amounts, bytes32[][] proofs)",
];

let stored: { at: number; map: Map<string, MerklIncentive> } | null = null;
let pending: Promise<Map<string, MerklIncentive> | null> | null = null;
let userStored: { at: number; key: string; value: MerklWalletRewards } | null = null;
let userPending: { key: string; promise: Promise<MerklWalletRewards> } | null = null;

/**
 * Merkl's published incentive for this pool, or null when the pool has no live campaign.
 * The browser cannot read api.merkl.xyz directly: the response leaves out
 * Access-Control-Allow-Origin. The dev server proxies /api/merkl. The APK
 * reads the same URL through native HTTP.
 */
export async function loadMerklIncentive(pool: string): Promise<MerklIncentive | null> {
  const map = await loadMap();
  if (!map) throw new Error("The Merkl incentive feed did not load.");
  return map.get(pool.toLowerCase()) ?? null;
}

function loadMap(): Promise<Map<string, MerklIncentive> | null> {
  if (stored && Date.now() - stored.at < FRESH_MS) return Promise.resolve(stored.map);
  if (!pending) {
    pending = readMap().finally(() => {
      pending = null;
    });
  }
  return pending;
}

/**
 * Live Merkl APR plus this wallet's claimable and pending amounts, keyed by pool address.
 * A claim is per reward token, not per position. The returned claims carry the proof for
 * the wallet's whole unclaimed balance of that token.
 */
export function loadMerklWallet(owner: string, fresh = false): Promise<MerklWalletRewards> {
  const key = `${owner.toLowerCase()}:${fresh ? "fresh" : "cached"}`;
  if (!fresh && userStored && userStored.key === owner.toLowerCase() && Date.now() - userStored.at < USER_FRESH_MS) {
    return Promise.resolve(userStored.value);
  }
  if (userPending?.key === key) return userPending.promise;
  const promise = readWallet(owner, fresh).finally(() => {
    if (userPending?.promise === promise) userPending = null;
  });
  userPending = { key, promise };
  return promise;
}

/** Claim the wallet's full unclaimed balance of these reward tokens. */
export async function claimMerklRewards(privateKey: string, tokenAddresses: readonly string[]): Promise<string> {
  const want = new Set(tokenAddresses.map((item) => item.toLowerCase()));
  if (want.size === 0) throw new Error("Nothing is ready to claim for this position.");
  const wallet = new Wallet(privateKey, hemiProvider());
  const live = await readWallet(wallet.address, true);
  const picked = live.claims.filter((item): item is MerklClaimToken & { proofs: string[] } => (
    want.has(item.address) && item.claimable > 0n && item.proofs != null
  ));
  if (picked.length === 0) throw new Error("Nothing is ready to claim for this position.");
  const eth = await hemiProvider().getBalance(wallet.address);
  if (eth === 0n) throw new Error("This Hemi address has no ETH for gas.");
  const distributor = new Contract(MERKL_DISTRIBUTOR, distributorAbi, wallet);
  const tx = await distributor.claim(
    picked.map(() => wallet.address),
    picked.map((item) => getAddress(item.address)),
    picked.map((item) => item.amount),
    picked.map((item) => item.proofs),
  );
  const receipt = await tx.wait();
  if (receipt && receipt.status === 0) throw new Error("The claim failed.");
  userStored = null;
  return receipt?.hash ?? tx.hash;
}

export function merklAmountUsd(
  tokens: readonly MerklAmount[],
  book: PriceBook | null,
  field: "claimable" | "pending",
): string | null {
  return legsUsd(book, tokens.filter((token) => token[field] > 0n).map((token) => ({
    amount: token[field],
    decimals: token.decimals,
    address: token.address,
    label: token.symbol,
  })));
}

async function readWallet(owner: string, fresh: boolean): Promise<MerklWalletRewards> {
  const address = owner.toLowerCase();
  const reload = fresh ? `&reloadChainId=${HEMI_CHAIN_ID}` : "";
  const [map, breakdowns, rewards] = await Promise.all([
    loadMap(),
    merklJson(`/v4/users/${address}/rewards/chains/${HEMI_CHAIN_ID}/breakdowns`),
    merklJson(`/v4/users/${address}/rewards?chainId=${HEMI_CHAIN_ID}${reload}`),
  ]);
  const opportunities = map == null ? null : [...mapEntries(map)];
  const value = readMerklWallet(opportunities, breakdowns, rewards);
  userStored = { at: Date.now(), key: address, value };
  return value;
}

/** Rebuild the opportunity objects readMerklWallet expects from the cached incentive map. */
function mapEntries(map: Map<string, MerklIncentive>): unknown[] {
  const rows: unknown[] = [];
  for (const [pool, incentive] of map) {
    rows.push({
      status: "LIVE",
      apr: incentive.apr,
      earliestCampaignEnd: incentive.endsAt,
      explorerAddress: pool,
      rewardsRecord: {
        breakdowns: incentive.reward.split(", ").filter((symbol) => symbol && symbol !== "the reward token").map((symbol) => ({
          token: { symbol },
        })),
      },
    });
  }
  return rows;
}

function merklUrl(path: string): string {
  // The dev server proxies this. The APK uses native HTTP, which is not bound by browser CORS.
  return Capacitor.isNativePlatform() ? `https://api.merkl.xyz${path}` : `/api/merkl${path}`;
}

async function merklJson(path: string): Promise<unknown | null> {
  try {
    const response = await fetch(merklUrl(path));
    if (!response.ok) return null;
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

async function readMap(): Promise<Map<string, MerklIncentive> | null> {
  const body = await merklJson(`/v4/opportunities?chainId=${HEMI_CHAIN_ID}&status=LIVE&items=100`);
  if (!Array.isArray(body)) return null;
  const map = new Map<string, MerklIncentive>();
  for (const item of body) {
    const incentive = readOpportunity(item);
    if (!incentive) continue;
    const address = poolAddress(item);
    if (!address) continue;
    const current = map.get(address);
    if (!current) {
      map.set(address, incentive);
      continue;
    }
    current.apr += incentive.apr;
    if (incentive.endsAt > 0 && (current.endsAt === 0 || incentive.endsAt < current.endsAt)) current.endsAt = incentive.endsAt;
    for (const symbol of incentive.reward.split(", ")) {
      if (!current.reward.split(", ").includes(symbol)) current.reward = `${current.reward}, ${symbol}`;
    }
  }
  stored = { at: Date.now(), map };
  return map;
}
