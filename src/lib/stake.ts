import { Contract, getAddress } from "ethers";
import { formatUnits } from "./format";
import { HEMIBTC, HEMI_CHAIN_ID, HEMI_TOKEN, VE_HEMI, VE_HEMI_LENS, VE_HEMI_REWARDS, VUSD } from "../chain";
import { sendCall } from "./evmSend.ts";
import { hemiProvider } from "./hemi";
import { holdingUsd, legsUsd, type PriceBook } from "./prices";
import { requirePublic } from "./sessionVault.ts";

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
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getLockedBalance(uint256 tokenId) view returns (tuple(int128 amount, uint64 end))",
  "function balanceOfNFT(uint256 tokenId) view returns (uint256)",
  "function createLock(uint256 amount, uint256 lockDuration) returns (uint256)",
  "function increaseAmount(uint256 tokenId, uint256 amount)",
  "function increaseUnlockTime(uint256 tokenId, uint256 lockDuration)",
  "function withdraw(uint256 tokenId)",
  "error AmountIsZero()",
  "error AmountTooSmall()",
  "error LockDurationTooLong()",
  "error LockExpired()",
  "error LockNotExpired()",
  "error NewLockDurationNotGreater()",
  "error NoExistingLock()",
  "error NotOwner()",
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
  token: string;
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

export function stakeRewardTokens(positions: readonly StakePosition[] | null): string[] {
  const seen = new Set<string>();
  for (const position of positions ?? []) {
    for (const reward of position.rewards ?? []) seen.add(reward.token);
  }
  return [...seen];
}

/** Dollar value of the locked HEMI. */
export function stakeLockedUsd(position: StakePosition, book: PriceBook | null): string | null {
  return holdingUsd(book, position.amount, 18, HEMI_TOKEN);
}

/** Dollar value of epoch rewards. Each token is priced, then totaled. */
export function stakeRewardsUsd(rewards: StakeReward[] | null, book: PriceBook | null): string | null {
  if (rewards == null) return null;
  return legsUsd(book, rewards.map((reward) => ({
    amount: reward.amount,
    decimals: reward.decimals,
    address: reward.token,
    label: reward.symbol,
  })));
}

/** Voting weight veHEMI stores: amount / max-lock, then times the seconds still left. */
export function stakeWeight(amount: bigint, endSec: number, nowSec: number): bigint {
  if (amount <= 0n || endSec <= nowSec) return 0n;
  const slope = amount / BigInt(Math.round(STAKE_MAX_SECONDS));
  return slope * BigInt(endSec - nowSec);
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

/** Latest unlock `increaseUnlockTime` can store from this moment. */
export function stakeMaxUnlock(nowSec: number): number {
  return stakeUnlockAt(nowSec, STAKE_MAX_SECONDS);
}

export type StakeExtend = { kind: "extra"; seconds: number } | { kind: "max" };

export type StakeExtension = {
  id: string;
  label: string;
  /** Epoch-aligned unlock this choice would store. */
  unlockAt: number;
  extend: StakeExtend;
};

/**
 * Extra time that still fits on a live lock.
 * A preset is listed only when that full period lands after the current unlock
 * and on or before the 4-year cap. Maximum is listed whenever the unlock can
 * move at all. An ended lock, or one already at the cap, has no choices.
 */
export function stakeExtensions(nowSec: number, currentEnd: number): StakeExtension[] {
  if (!(currentEnd > nowSec)) return [];
  const cap = stakeMaxUnlock(nowSec);
  if (!(currentEnd < cap)) return [];
  const choices: StakeExtension[] = [];
  for (const preset of STAKE_PRESETS) {
    if (preset.id === "4y") continue;
    const unlockAt = stakeUnlockAt(currentEnd, preset.seconds);
    if (unlockAt > currentEnd && unlockAt <= cap) {
      choices.push({
        id: preset.id,
        label: `+ ${preset.label}`,
        unlockAt,
        extend: { kind: "extra", seconds: preset.seconds },
      });
    }
  }
  if (!choices.some((choice) => choice.unlockAt === cap)) {
    choices.push({ id: "max", label: "Maximum", unlockAt: cap, extend: { kind: "max" } });
  }
  return choices;
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
      token: getAddress(row.token),
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

async function requireGas(address: string) {
  const eth = await hemiProvider().getBalance(address);
  if (eth === 0n) throw new Error("Need Hemi ETH for gas.");
}

async function hemiCall(address: string, abi: readonly string[], method: string, args: readonly unknown[]): Promise<string> {
  const sent = await sendCall(hemiProvider(), HEMI_CHAIN_ID, address, abi, method, args);
  if (sent.receipt?.status === 0) throw new Error("The transaction failed.");
  return sent.hash;
}

const EPOCH = BigInt(STAKE_EPOCH_SECONDS);
const MAX_TIME = BigInt(Math.round(STAKE_MAX_SECONDS));

function floorEpoch(sec: bigint): bigint {
  return (sec / EPOCH) * EPOCH;
}

async function chainNow(): Promise<bigint> {
  const block = await hemiProvider().getBlock("latest");
  if (block == null) throw new Error("Could not read the Hemi clock.");
  return BigInt(block.timestamp);
}

async function readLocked(ve: Contract, tokenId: bigint): Promise<{ amount: bigint; end: bigint }> {
  const locked = await ve.getLockedBalance(tokenId);
  const amount = BigInt(locked.amount ?? locked[0]);
  const end = BigInt(locked.end ?? locked[1]);
  return { amount: amount < 0n ? -amount : amount, end };
}

export async function lockHemi(
  amount: bigint,
  durationSec: bigint,
  onPhase?: (phase: "approve" | "lock") => void,
): Promise<string> {
  if (amount < STAKE_MIN_HEMI) throw new Error("The minimum lock is 10 HEMI.");
  requireDuration(durationSec);
  const holder = requirePublic().hemiAddress;
  await requireGas(holder);
  const token = new Contract(HEMI_TOKEN, allowanceAbi, hemiProvider());
  const allowed = BigInt(await token.allowance(holder, VE_HEMI));
  if (allowed < amount) {
    onPhase?.("approve");
    await hemiCall(HEMI_TOKEN, allowanceAbi, "approve", [VE_HEMI, amount]);
  }
  onPhase?.("lock");
  return hemiCall(VE_HEMI, veAbi, "createLock", [amount, durationSec]);
}

/** Add HEMI to a lock that has not ended. The unlock date stays the same. */
export async function addHemiToLock(
  tokenId: bigint,
  amount: bigint,
  onPhase?: (phase: "approve" | "add") => void,
): Promise<string> {
  if (amount <= 0n) throw new Error("Enter an amount of HEMI.");
  const holder = requirePublic().hemiAddress;
  await requireGas(holder);
  const ve = new Contract(VE_HEMI, veAbi, hemiProvider());
  const locked = await readLocked(ve, tokenId);
  const now = await chainNow();
  if (locked.amount <= 0n) throw new Error("This lock is empty.");
  if (locked.end <= now) throw new Error("This lock has ended. Unlock the HEMI instead of adding more.");
  const token = new Contract(HEMI_TOKEN, allowanceAbi, hemiProvider());
  const allowed = BigInt(await token.allowance(holder, VE_HEMI));
  if (allowed < amount) {
    onPhase?.("approve");
    await hemiCall(HEMI_TOKEN, allowanceAbi, "approve", [VE_HEMI, amount]);
  }
  onPhase?.("add");
  await ve.increaseAmount.staticCall(tokenId, amount);
  return hemiCall(VE_HEMI, veAbi, "increaseAmount", [tokenId, amount]);
}

/**
 * Push a live lock's unlock later.
 * `extra` adds that many seconds to the current end. `max` uses the longest
 * unlock the contract still accepts, 4 years from the chain clock.
 */
export async function extendHemiLock(
  tokenId: bigint,
  extend: StakeExtend,
): Promise<string> {
  const holder = requirePublic().hemiAddress;
  await requireGas(holder);
  const ve = new Contract(VE_HEMI, veAbi, hemiProvider());
  const owner = String(await ve.ownerOf(tokenId));
  if (owner.toLowerCase() !== holder.toLowerCase()) throw new Error("This lock is in another wallet.");
  const locked = await readLocked(ve, tokenId);
  const now = await chainNow();
  if (locked.amount <= 0n) throw new Error("This lock is empty.");
  if (locked.end <= now) throw new Error("This lock has ended. Unlock the HEMI instead of adding time.");
  const cap = floorEpoch(now + MAX_TIME);
  const target = extend.kind === "max"
    ? cap
    : floorEpoch(locked.end + BigInt(Math.round(extend.seconds)));
  if (target <= locked.end) throw new Error("That does not add time to this lock.");
  if (target > cap) throw new Error("That much time would pass the 4 year limit.");
  const duration = target - now;
  await ve.increaseUnlockTime.staticCall(tokenId, duration);
  return hemiCall(VE_HEMI, veAbi, "increaseUnlockTime", [tokenId, duration]);
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

export async function claimStake(tokenId: bigint): Promise<string> {
  const holder = requirePublic().hemiAddress;
  await requireGas(holder);
  const rewards = new Contract(VE_HEMI_REWARDS, rewardsAbi, hemiProvider());
  const lens = new Contract(VE_HEMI_LENS, lensAbi, hemiProvider());
  const quoted = (await lens.claimableByTokenAll(tokenId, holder)) as RewardRow[];
  if (!quoted.some((row) => row.claimable > 0n)) throw new Error("Nothing is ready to claim for this position.");

  const settled = Number(await rewards.settledEpoch());
  const span = Math.max(1, Number(await rewards.MAX_CLAIM_EPOCHS()));
  let from = await rewardFloor(settled);
  let last = "";
  let sent = 0;
  while (from <= settled && sent < 6) {
    const fitted = await fitClaim(rewards, tokenId, holder, from, Math.min(settled, from + span - 1));
    if (fitted == null) {
      const rows = (await lens.claimableByToken(tokenId, holder, from, from)) as RewardRow[];
      let moved = false;
      for (const row of rows) {
        if (row.claimable === 0n) continue;
        await rewards.claimToken.staticCall(tokenId, holder, row.token, from, from);
        last = await hemiCall(VE_HEMI_REWARDS, rewardsAbi, "claimToken", [tokenId, holder, row.token, from, from]);
        moved = true;
        sent += 1;
      }
      if (!moved) throw new Error("The reward contract would not settle this claim.");
      from += 1;
      continue;
    }
    const rows = (await lens.claimableByToken(tokenId, holder, from, fitted)) as RewardRow[];
    if (rows.some((row) => row.claimable > 0n)) {
      last = await hemiCall(VE_HEMI_REWARDS, rewardsAbi, "claimFrom", [tokenId, holder, from, fitted, 0]);
      sent += 1;
    }
    from = fitted + 1;
  }
  if (!last) throw new Error("Nothing in the recent epochs is ready to claim.");
  return last;
}

export async function unlockStake(
  tokenId: bigint,
  onPhase?: (phase: "record" | "unlock") => void,
): Promise<string> {
  const holder = requirePublic().hemiAddress;
  await requireGas(holder);
  const rewards = new Contract(VE_HEMI_REWARDS, rewardsAbi, hemiProvider());
  const ve = new Contract(VE_HEMI, veAbi, hemiProvider());
  const bound = String(await rewards.veHemi()).toLowerCase();
  if (bound === VE_HEMI.toLowerCase()) {
    const klass = await rewards.positionClass(tokenId);
    const captured = Boolean(klass.captured ?? klass[2]);
    if (!captured) {
      onPhase?.("record");
      const ok = Boolean(await rewards.capturePositionClass.staticCall(tokenId));
      if (!ok) throw new Error("This position's reward class cannot be recorded, so it stays locked.");
      await hemiCall(VE_HEMI_REWARDS, rewardsAbi, "capturePositionClass", [tokenId]);
    }
  }
  onPhase?.("unlock");
  await ve.withdraw.staticCall(tokenId);
  return hemiCall(VE_HEMI, veAbi, "withdraw", [tokenId]);
}
