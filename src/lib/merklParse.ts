import { formatUnits } from "./format.ts";

/** A live Merkl campaign for one pool. apr is already a percent, the same unit as the fee APR. */
export type MerklIncentive = {
  apr: number;
  reward: string;
  endsAt: number;
};

/** One reward token earned in a pool. Amounts are raw token units. */
export type MerklAmount = {
  address: string;
  symbol: string;
  decimals: number;
  /** In the live Merkle root. This is what a claim can pay. */
  claimable: bigint;
  /** Earned, not in a root yet. A claim cannot pay this. */
  pending: bigint;
};

/** A token the distributor can pay. amount is the cumulative figure the proof covers. */
export type MerklClaimToken = MerklAmount & {
  amount: bigint;
  /** Null when the proof was missing or malformed. */
  proofs: string[] | null;
};

/** Merkl state for one pool this wallet can hold a position in. */
export type MerklPoolReward = {
  /** Live campaign APR, already a percent. Null when the campaign has ended. */
  apr: number | null;
  reward: string;
  endsAt: number;
  tokens: MerklAmount[];
};

export type MerklWalletRewards = {
  byPool: Map<string, MerklPoolReward>;
  /** One entry per reward token. A claim pays the whole unclaimed balance of that token. */
  claims: MerklClaimToken[];
  /** False when the per-wallet reward feed did not load. APR lines can still be present. */
  rewardsReady: boolean;
};

/** Join the live campaign list with one wallet's breakdown and proof payloads. */
export function readMerklWallet(opportunities: unknown, breakdowns: unknown, rewards: unknown): MerklWalletRewards {
  const byPool = new Map<string, MerklPoolReward>();
  if (Array.isArray(opportunities)) {
    for (const item of opportunities) {
      const incentive = readOpportunity(item);
      const pool = poolAddress(item);
      if (!incentive || !pool) continue;
      const current = byPool.get(pool);
      if (!current) {
        byPool.set(pool, { apr: incentive.apr, reward: incentive.reward, endsAt: incentive.endsAt, tokens: [] });
        continue;
      }
      current.apr = (current.apr ?? 0) + incentive.apr;
      if (incentive.endsAt > 0 && (current.endsAt === 0 || incentive.endsAt < current.endsAt)) current.endsAt = incentive.endsAt;
      for (const symbol of incentive.reward.split(", ")) {
        if (symbol && !current.reward.split(", ").includes(symbol)) current.reward = `${current.reward}, ${symbol}`;
      }
    }
  }

  const breakdownReady = readBreakdowns(breakdowns, byPool);
  const parsed = readClaims(rewards);
  if (breakdownReady && parsed.ready) {
    const proven = new Map(parsed.claims.map((item) => [item.address, item.claimable]));
    for (const reward of byPool.values()) {
      for (const token of reward.tokens) {
        const cap = proven.get(token.address);
        // A token the proof feed omits keeps its pool amount. One the feed has
        // already paid down is capped, including down to zero after a claim.
        if (cap != null && token.claimable > cap) token.claimable = cap;
      }
    }
  }
  for (const [pool, reward] of byPool) {
    if (reward.reward === "" || reward.reward === "the reward token") {
      const symbols = [...new Set(reward.tokens.map((token) => token.symbol))];
      if (symbols.length > 0) reward.reward = symbols.join(", ");
    }
    const alive = reward.apr != null || reward.tokens.some((token) => token.claimable > 0n || token.pending > 0n);
    if (!alive) byPool.delete(pool);
  }
  return {
    byPool,
    claims: parsed.claims,
    rewardsReady: breakdownReady && parsed.ready,
  };
}

export function merklForPool(data: MerklWalletRewards | null, pool: string | null): MerklPoolReward | null {
  if (!data || !pool) return null;
  return data.byPool.get(pool.toLowerCase()) ?? null;
}

/** Reward-token addresses, so the price book can cover a token the wallet does not list. */
export function merklTokenAddresses(data: MerklWalletRewards | null): string[] {
  if (!data) return [];
  const seen = new Set<string>();
  for (const reward of data.byPool.values()) {
    for (const token of reward.tokens) seen.add(token.address);
  }
  for (const claim of data.claims) seen.add(claim.address);
  return [...seen];
}

/** Tokens this pool has claimable, limited to proofs the distributor can use. */
export function merklClaimable(reward: MerklPoolReward, claims: readonly MerklClaimToken[]): MerklClaimToken[] {
  const want = new Set(reward.tokens.filter((token) => token.claimable > 0n).map((token) => token.address));
  return claims.filter((claim) => want.has(claim.address) && claim.claimable > 0n && claim.proofs != null);
}

export function merklAmountLine(tokens: readonly MerklAmount[], field: "claimable" | "pending"): string | null {
  const parts = tokens
    .filter((token) => token[field] > 0n)
    .map((token) => `${formatUnits(token[field], token.decimals)} ${token.symbol}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** What a claim of this pool's tokens will actually send. Merkl pays the whole token balance. */
export function merklPayoutLine(reward: MerklPoolReward, claims: readonly MerklClaimToken[]): string | null {
  const paying = merklClaimable(reward, claims);
  if (paying.length === 0) return null;
  return paying.map((token) => `${formatUnits(token.claimable, token.decimals)} ${token.symbol}`).join(" · ");
}

export function merklPayoutCoversMore(reward: MerklPoolReward, claims: readonly MerklClaimToken[]): boolean {
  return merklClaimable(reward, claims).some((claim) => {
    const slice = reward.tokens.find((token) => token.address === claim.address);
    return slice != null && claim.claimable > slice.claimable;
  });
}

export function poolAddress(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const row = item as { explorerAddress?: unknown; identifier?: unknown };
  const address = typeof row.explorerAddress === "string" ? row.explorerAddress : row.identifier;
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) return "";
  return address.toLowerCase();
}

export function readOpportunity(item: unknown): MerklIncentive | null {
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

function readBreakdowns(body: unknown, byPool: Map<string, MerklPoolReward>): boolean {
  if (!body || typeof body !== "object") return false;
  const rows = (body as { opportunities?: unknown }).opportunities;
  if (!Array.isArray(rows)) return false;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as { opportunity?: unknown; tokens?: unknown };
    const pool = poolAddress(item.opportunity);
    if (!pool) continue;
    const current = byPool.get(pool) ?? { apr: null, reward: "", endsAt: 0, tokens: [] };
    const incentive = readOpportunity(item.opportunity);
    if (incentive && current.apr == null) {
      current.apr = incentive.apr;
      current.reward = incentive.reward;
      current.endsAt = incentive.endsAt;
    }
    if (!Array.isArray(item.tokens)) {
      if (current.apr != null) byPool.set(pool, current);
      continue;
    }
    for (const tokenRow of item.tokens) {
      const parsed = readBreakdownToken(tokenRow);
      if (parsed) mergeAmount(current.tokens, parsed);
    }
    const alive = current.apr != null || current.tokens.some((token) => token.claimable > 0n || token.pending > 0n);
    if (alive) byPool.set(pool, current);
  }
  return true;
}

function readBreakdownToken(item: unknown): MerklAmount | null {
  if (!item || typeof item !== "object") return null;
  const row = item as { token?: unknown; claimable?: unknown; pending?: unknown };
  const token = readToken(row.token);
  const claimable = rawAmount(row.claimable);
  const pending = rawAmount(row.pending);
  if (!token || claimable == null || pending == null) return null;
  return { ...token, claimable, pending };
}

function readClaims(body: unknown): { ready: boolean; claims: MerklClaimToken[] } {
  if (!Array.isArray(body)) return { ready: false, claims: [] };
  const claims: MerklClaimToken[] = [];
  const seen = new Set<string>();
  for (const chain of body) {
    if (!chain || typeof chain !== "object") continue;
    const rewards = (chain as { rewards?: unknown }).rewards;
    if (!Array.isArray(rewards)) continue;
    for (const reward of rewards) {
      const parsed = readClaim(reward);
      if (!parsed || seen.has(parsed.address)) continue;
      seen.add(parsed.address);
      claims.push(parsed);
    }
  }
  return { ready: true, claims };
}

function readClaim(item: unknown): MerklClaimToken | null {
  if (!item || typeof item !== "object") return null;
  const row = item as { token?: unknown; amount?: unknown; claimed?: unknown; pending?: unknown; proofs?: unknown };
  const token = readToken(row.token);
  const amount = rawAmount(row.amount);
  const claimed = rawAmount(row.claimed);
  const pending = rawAmount(row.pending) ?? 0n;
  if (!token || amount == null || claimed == null || amount < claimed) return null;
  return { ...token, amount, claimable: amount - claimed, pending, proofs: readProofs(row.proofs) };
}

function readToken(item: unknown): { address: string; symbol: string; decimals: number } | null {
  if (!item || typeof item !== "object") return null;
  const row = item as { address?: unknown; symbol?: unknown; decimals?: unknown };
  if (typeof row.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(row.address)) return null;
  const decimals = Number(row.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  return {
    address: row.address.toLowerCase(),
    symbol: cleanSymbol(typeof row.symbol === "string" ? row.symbol : ""),
    decimals,
  };
}

function readProofs(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const proofs: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(item)) return null;
    proofs.push(item);
  }
  return proofs;
}

function rawAmount(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

function mergeAmount(tokens: MerklAmount[], next: MerklAmount) {
  const found = tokens.find((token) => token.address === next.address);
  if (!found) {
    tokens.push(next);
    return;
  }
  found.claimable += next.claimable;
  found.pending += next.pending;
}

function cleanSymbol(symbol: string): string {
  const clean = symbol.replace(/[^\w.$+-]/g, "").slice(0, 16);
  return clean || "TOKEN";
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
