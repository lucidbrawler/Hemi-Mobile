import { Capacitor } from "@capacitor/core";
import { HEMI_CHAIN_ID } from "../chain";

/** A live Merkl campaign for one pool. apr is already a percent, the same unit as the fee APR. */
export type MerklIncentive = {
  apr: number;
  reward: string;
  endsAt: number;
};

const FRESH_MS = 4 * 60 * 1000;

let stored: { at: number; map: Map<string, MerklIncentive> } | null = null;
let pending: Promise<Map<string, MerklIncentive> | null> | null = null;

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

async function readMap(): Promise<Map<string, MerklIncentive> | null> {
  const path = `/v4/opportunities?chainId=${HEMI_CHAIN_ID}&status=LIVE&items=100`;
  // The dev server proxies this. The APK uses native HTTP, which is not bound by browser CORS.
  const url = Capacitor.isNativePlatform() ? `https://api.merkl.xyz${path}` : `/api/merkl${path}`;
  const response = await fetch(url);
  if (!response.ok) return null;
  const body: unknown = await response.json();
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

function poolAddress(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const row = item as { explorerAddress?: unknown; identifier?: unknown };
  const address = typeof row.explorerAddress === "string" ? row.explorerAddress : row.identifier;
  return typeof address === "string" ? address.toLowerCase() : "";
}

function readOpportunity(item: unknown): MerklIncentive | null {
  if (!item || typeof item !== "object") return null;
  const row = item as {
    status?: unknown;
    apr?: unknown;
    earliestCampaignEnd?: unknown;
    rewardsRecord?: { breakdowns?: unknown };
  };
  if (row.status !== "LIVE") return null;
  const apr = Number(row.apr);
  if (!(apr > 0) || !Number.isFinite(apr)) return null;
  const endsAt = Number(row.earliestCampaignEnd);
  const symbols = rewardSymbols(row.rewardsRecord?.breakdowns);
  return {
    apr,
    reward: symbols.length > 0 ? symbols.join(", ") : "the reward token",
    endsAt: Number.isFinite(endsAt) && endsAt > 0 ? endsAt : 0,
  };
}

function rewardSymbols(breakdowns: unknown): string[] {
  if (!Array.isArray(breakdowns)) return [];
  const symbols: string[] = [];
  for (const breakdown of breakdowns) {
    if (!breakdown || typeof breakdown !== "object") continue;
    const symbol = (breakdown as { token?: { symbol?: unknown } }).token?.symbol;
    if (typeof symbol !== "string" || symbol === "" || symbols.includes(symbol)) continue;
    symbols.push(symbol);
  }
  return symbols;
}
