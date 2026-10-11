import { Contract, Wallet, getAddress } from "ethers";
import { formatUnits } from "./format";
import { HEMIBTC, HEMI_TOKEN, VE_HEMI, VE_HEMI_LENS, VE_HEMI_REWARDS, VUSD } from "../chain";
import { hemiProvider } from "./hemi";

/** VeHemi YEAR / 60. Locks round down onto this grid. */
export const STAKE_EPOCH_SECONDS = 525_960;
const YEAR_SECONDS = 365.25 * 24 * 60 * 60;
/** Four Julian years, the contract MAX_TIME. */
export const STAKE_MAX_SECONDS = 4 * YEAR_SECONDS;
/** Two epoch buckets. Shorter than this reverts. */
export const STAKE_MIN_SECONDS = STAKE_EPOCH_SECONDS * 2;
export const STAKE_MIN_HEMI = 10n * 10n ** 18n;

export const STAKE_PRESETS = [
  { id: "6m", label: "6 months", seconds: Math.round(YEAR_SECONDS / 2) },
  { id: "1y", label: "1 year", seconds: Math.round(YEAR_SECONDS) },
  { id: "2y", label: "2 years", seconds: Math.round(YEAR_SECONDS * 2) },
  { id: "4y", label: "4 years", seconds: Math.round(STAKE_MAX_SECONDS) },
] as const;

export type StakePresetId = (typeof STAKE_PRESETS)[number]["id"];

const allowanceAbi = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const veAbi = [
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function getLockedBalance(uint256 tokenId) view returns (tuple(int128 amount, uint64 end))",
  "function balanceOfNFT(uint256 tokenId) view returns (uint256)",
  "function createLock(uint256 amount, uint256 lockDuration) returns (uint256)",
  "function withdraw(uint256 tokenId)",
];

const rewardsAbi = [
  "function veHemi() view returns (address)",
  "function settledEpoch() view returns (uint32)",
  "function MAX_CLAIM_EPOCHS() view returns (uint256)",
  "function positionClass(uint256 tokenId) view returns (uint64 transferableAfter, bool forfeitable, bool captured)",
  "function capturePositionClass(uint256 tokenId) returns (bool)",
  "function claimFrom(uint256 tokenId, address holder, uint32 fromEpoch, uint32 toEpoch, uint256 tokenStart) returns (uint256)",
  "function claimToken(uint256 tokenId, address holder, address token, uint32 fromEpoch, uint32 toEpoch)",
];

const lensAbi = [
  "function claimableByTokenAll(uint256 tokenId, address holder) view returns (tuple(address token, string symbol, uint8 decimals, uint256 claimable, uint256 carry)[])",
  "function claimableByToken(uint256 tokenId, address holder, uint32 fromEpoch, uint32 toEpoch) view returns (tuple(address token, string symbol, uint8 decimals, uint256 claimable, uint256 carry)[])",
];

export type StakeReward = {
  symbol: string;
  decimals: number;
  amount: bigint;
};

export type StakePosition = {
  tokenId: string;
  amount: bigint;
  /** Unix seconds when the lock can be withdrawn. */
  end: number;
  weight: bigint | null;
  expired: boolean;
  /** Null when the lens could not be read. */
  rewards: StakeReward[] | null;
};

type RewardRow = {
  token: string;
  symbol: string;
  decimals: number | bigint;
  claimable: bigint;
};

export function stakeRewardLine(position: StakePosition): string {
  if (position.rewards == null) return "Could not read";
  if (position.rewards.length === 0) return "None yet";
  return position.rewards.map((reward) => `${formatUnits(reward.amount, reward.decimals)} ${reward.symbol}`).join(" · ");
}

export function stakeWeightLabel(seconds: number): string {
  const pct = (seconds / STAKE_MAX_SECONDS) * 100;
  const text = Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
  return `${text}%`;
}

/** Unlock timestamp after VeHemi rounds the duration down to the epoch grid. */
export function stakeUnlockAt(nowSec: number, durationSec: number): number {
  return Math.floor((nowSec + durationSec) / STAKE_EPOCH_SECONDS) * STAKE_EPOCH_SECONDS;
}

function rewardSymbol(address: string, symbol: string): string {
  const key = address.toLowerCase();
  if (key === HEMI_TOKEN.toLowerCase()) return "HEMI";
  if (key === HEMIBTC.toLowerCase()) return "hemiBTC";
  if (key === VUSD.toLowerCase()) return "VUSD";
  const clean = symbol.replace(/[^\w.$+-]/g, "").slice(0, 12);
  return clean || "TOKEN";
}

function asRewards(rows: RewardRow[]): StakeReward[] {
  return rows
    .filter((row) => row.claimable > 0n)
    .map((row) => ({
      symbol: rewardSymbol(row.token, row.symbol),
      decimals: Number(row.decimals),
      amount: row.claimable,
    }));
}

export async function readStake(address: string): Promise<StakePosition[]> {
  const provider = hemiProvider();
  const ve = new Contract(VE_HEMI, veAbi, provider);
  const lens = new Contract(VE_HEMI_LENS, lensAbi, provider);
  const owner = getAddress(address);
  const count = Number(await ve.balanceOf(owner));
  const now = Math.floor(Date.now() / 1000);
  const positions: StakePosition[] = [];
  for (let i = 0; i < Math.min(count, 12); i += 1) {
    const tokenId = BigInt(await ve.tokenOfOwnerByIndex(owner, i));
    const locked = await ve.getLockedBalance(tokenId);
    const amount = BigInt(locked.amount ?? locked[0]);
    const end = Number(locked.end ?? locked[1]);
    let weight: bigint | null = 0n;
    try {
      weight = BigInt(await ve.balanceOfNFT(tokenId));
    } catch {
      weight = null;
    }
    let rewards: StakeReward[] | null = null;
    try {
      const quoted = (await lens.claimableByTokenAll(tokenId, owner)) as RewardRow[];
      rewards = asRewards(quoted);
    } catch {
      rewards = null;
    }
    positions.push({
      tokenId: tokenId.toString(),
      amount: amount < 0n ? -amount : amount,
      end,
      weight,
      expired: end > 0 && end <= now,
      rewards,
    });
  }
  return positions;
}

export async function stakeNeedsApproval(owner: string, amount: bigint): Promise<boolean> {
  if (amount <= 0n) return false;
  const token = new Contract(HEMI_TOKEN, allowanceAbi, hemiProvider());
  const allowed = BigInt(await token.allowance(getAddress(owner), VE_HEMI));
  return allowed < amount;
}

function requireDuration(durationSec: bigint) {
  if (durationSec < BigInt(STAKE_MIN_SECONDS) || durationSec > BigInt(STAKE_MAX_SECONDS)) {
    throw new Error("Pick a lock from 12 days through 4 years.");
  }
}

async function requireGas(wallet: Wallet) {
  const eth = await hemiProvider().getBalance(wallet.address);
  if (eth === 0n) throw new Error("Need Hemi ETH for gas.");
}

async function mined(tx: { hash: string; wait: () => Promise<{ status?: number; hash?: string } | null> }): Promise<string> {
  const receipt = await tx.wait();
  if (receipt?.status === 0) throw new Error("The transaction failed.");
  return receipt?.hash ?? tx.hash;
}

export async function lockHemi(
  privateKey: string,
  amount: bigint,
  durationSec: bigint,
  onPhase?: (phase: "approve" | "lock") => void,
): Promise<string> {
  if (amount < STAKE_MIN_HEMI) throw new Error("The minimum lock is 10 HEMI.");
  requireDuration(durationSec);
  const wallet = new Wallet(privateKey, hemiProvider());
  await requireGas(wallet);
  const token = new Contract(HEMI_TOKEN, allowanceAbi, wallet);
  const allowed = BigInt(await token.allowance(wallet.address, VE_HEMI));
  if (allowed < amount) {
    onPhase?.("approve");
    await mined(await token.approve(VE_HEMI, amount));
  }
  onPhase?.("lock");
  const ve = new Contract(VE_HEMI, veAbi, wallet);
  return mined(await ve.createLock(amount, durationSec));
}

async function rewardFloor(settled: number): Promise<number> {
  try {
    const res = await fetch("https://hemistake.hemi.xyz/v1/snapshot");
    if (res.ok) {
      const body = (await res.json()) as { firstFundableEpoch?: number };
      const first = body.firstFundableEpoch;
      if (Number.isInteger(first) && first != null && first >= 0 && first <= settled) return first;
    }
  } catch {
    // The on-chain window below still covers the funded epochs.
  }
  return Math.max(0, settled - 240);
}

async function fitClaim(
  rewards: Contract,
  tokenId: bigint,
  holder: string,
  from: number,
  to: number,
): Promise<number | null> {
  let end = to;
  while (end >= from) {
    try {
      const cursor = BigInt(await rewards.claimFrom.staticCall(tokenId, holder, from, end, 0));
      if (cursor === 0n) return end;
    } catch {
      // A revert means this span cannot be claimed as one call.
    }
    if (end === from) return null;
    end = from + Math.floor((end - from) / 2);
  }
  return null;
}

export async function claimStake(privateKey: string, tokenId: bigint): Promise<string> {
  const wallet = new Wallet(privateKey, hemiProvider());
  await requireGas(wallet);
  const rewards = new Contract(VE_HEMI_REWARDS, rewardsAbi, wallet);
  const lens = new Contract(VE_HEMI_LENS, lensAbi, wallet);
  const quoted = (await lens.claimableByTokenAll(tokenId, wallet.address)) as RewardRow[];
  if (!quoted.some((row) => row.claimable > 0n)) throw new Error("Nothing is ready to claim for this position.");

  const settled = Number(await rewards.settledEpoch());
  const span = Math.max(1, Number(await rewards.MAX_CLAIM_EPOCHS()));
  let from = await rewardFloor(settled);
  let last = "";
  let sent = 0;
  while (from <= settled && sent < 6) {
    const fitted = await fitClaim(rewards, tokenId, wallet.address, from, Math.min(settled, from + span - 1));
    if (fitted == null) {
      const rows = (await lens.claimableByToken(tokenId, wallet.address, from, from)) as RewardRow[];
      let moved = false;
      for (const row of rows) {
        if (row.claimable === 0n) continue;
        await rewards.claimToken.staticCall(tokenId, wallet.address, row.token, from, from);
        last = await mined(await rewards.claimToken(tokenId, wallet.address, row.token, from, from));
        moved = true;
        sent += 1;
      }
      if (!moved) throw new Error("The reward contract would not settle this claim.");
      from += 1;
      continue;
    }
    const rows = (await lens.claimableByToken(tokenId, wallet.address, from, fitted)) as RewardRow[];
    if (rows.some((row) => row.claimable > 0n)) {
      last = await mined(await rewards.claimFrom(tokenId, wallet.address, from, fitted, 0));
      sent += 1;
    }
    from = fitted + 1;
  }
  if (!last) throw new Error("Nothing in the recent epochs is ready to claim.");
  return last;
}

export async function unlockStake(
  privateKey: string,
  tokenId: bigint,
  onPhase?: (phase: "record" | "unlock") => void,
): Promise<string> {
  const wallet = new Wallet(privateKey, hemiProvider());
  await requireGas(wallet);
  const rewards = new Contract(VE_HEMI_REWARDS, rewardsAbi, wallet);
  const ve = new Contract(VE_HEMI, veAbi, wallet);
  const bound = String(await rewards.veHemi()).toLowerCase();
  if (bound === VE_HEMI.toLowerCase()) {
    const klass = await rewards.positionClass(tokenId);
    const captured = Boolean(klass.captured ?? klass[2]);
    if (!captured) {
      onPhase?.("record");
      const ok = Boolean(await rewards.capturePositionClass.staticCall(tokenId));
      if (!ok) throw new Error("This position's reward class cannot be recorded, so it stays locked.");
      await mined(await rewards.capturePositionClass(tokenId));
    }
  }
  onPhase?.("unlock");
  await ve.withdraw.staticCall(tokenId);
  return mined(await ve.withdraw(tokenId));
}
