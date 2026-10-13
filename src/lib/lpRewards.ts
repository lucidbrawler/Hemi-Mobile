import { Contract, Interface, Wallet, getAddress } from "ethers";
import { formatUnits } from "./format";
import { legsUsd, walletValueUsd, type PriceBook, type ValuedHolding } from "./prices";
import { hemiProvider } from "./hemi";
import {
  amountsForLiquidity,
  assetSpec,
  findPool,
  formatTickPrice,
  managerFor,
  quoteWithdraw,
  readPoolMarket,
  type PoolAsset,
  type PoolInfo,
  type PoolMarket,
  type PoolVenue,
} from "./pool";

const ZERO = "0x0000000000000000000000000000000000000000";
const MAX128 = (1n << 128n) - 1n;
const POSITION_CAP = 30;

const positionAbi = [
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) payable returns (uint256 amount0, uint256 amount1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)",
  "function burn(uint256 tokenId) payable",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function unwrapWNativeToken(uint256 amountMinimum, address recipient) payable",
  "function sweepToken(address token, uint256 amountMinimum, address recipient) payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
];

const positionIface = new Interface(positionAbi);

export type LpPosition = {
  venue: PoolVenue;
  tokenId: string;
  venueLabel: string;
  pairLabel: string;
  feeLabel: string;
  token0: PoolAsset;
  token1: PoolAsset;
  lowerPrice: string;
  upperPrice: string;
  priceUnit: string;
  inRange: boolean;
  feesKnown: boolean;
  fee0: bigint;
  fee1: bigint;
  poolId: string;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  amountsKnown: boolean;
  amount0: bigint;
  amount1: bigint;
};

export type LpWithdraw = {
  poolId: string;
  venue: PoolVenue;
  tokenId: bigint;
  percent: number;
  liquidity: bigint;
  liquidityOut: bigint;
  amount0: bigint;
  amount1: bigint;
  min0: bigint;
  min1: bigint;
  tickLower: number;
  tickUpper: number;
};

export type LpRewardSnapshot = {
  positions: LpPosition[];
  truncated: boolean;
};

export async function readLpPosition(owner: string, venue: PoolVenue, tokenId: bigint): Promise<LpPosition | null> {
  const manager = managerFor(venue);
  const npm = new Contract(manager, positionAbi, hemiProvider());
  try {
    const holder = await npm.ownerOf(tokenId) as string;
    if (getAddress(holder) !== getAddress(owner)) return null;
  } catch {
    return null;
  }
  const position = await readOne(npm, tokenId);
  if (!position) return null;
  const pool = findPool(venue, position.token0, position.token1, position.fee);
  if (!pool) return null;
  const fees = await previewFees(manager, tokenId, owner);
  let market: PoolMarket | null = null;
  try {
    market = await readPoolMarket(pool);
  } catch {
    market = null;
  }
  return toRow(venue, tokenId, pool, position, fees, market);
}

export async function loadLpRewards(owner: string): Promise<LpRewardSnapshot> {
  const [sushi, brown] = await Promise.all([
    listVenue(owner, "sushi"),
    listVenue(owner, "brownfi"),
  ]);
  return {
    positions: [...sushi.positions, ...brown.positions],
    truncated: sushi.truncated || brown.truncated,
  };
}

export async function claimPositionFees(privateKey: string, venue: PoolVenue, tokenId: bigint): Promise<string> {
  const wallet = new Wallet(privateKey, hemiProvider());
  const manager = getAddress(managerFor(venue));
  const npm = new Contract(manager, positionAbi, wallet);
  const position = await readOne(npm, tokenId);
  if (!position) throw new Error("This position could not be read.");
  const fees = await previewFees(manager, tokenId, wallet.address);
  if (!fees || (fees.amount0 === 0n && fees.amount1 === 0n)) {
    throw new Error("Nothing is ready to claim for this position.");
  }
  const eth = await hemiProvider().getBalance(wallet.address);
  if (eth === 0n) throw new Error("This Hemi address has no ETH for gas.");
  const data = encodeClaim(venue, tokenId, wallet.address, position.token0, position.token1);
  const tx = await wallet.sendTransaction({ to: manager, data, value: 0n });
  const receipt = await tx.wait();
  if (receipt && receipt.status === 0) throw new Error("The claim failed.");
  return receipt?.hash ?? tx.hash;
}

export async function withdrawLp(privateKey: string, order: LpWithdraw): Promise<string> {
  if (!Number.isInteger(order.percent) || order.percent < 1 || order.percent > 100) {
    throw new Error("Pick a share of the position.");
  }
  const wallet = new Wallet(privateKey, hemiProvider());
  const manager = getAddress(managerFor(order.venue));
  const npm = new Contract(manager, positionAbi, hemiProvider());
  let owner: string;
  try {
    owner = await npm.ownerOf(order.tokenId) as string;
  } catch {
    throw new Error("This position could not be read.");
  }
  if (getAddress(owner) !== getAddress(wallet.address)) throw new Error("This position is not in this wallet.");
  const position = await readOne(npm, order.tokenId);
  if (!position) throw new Error("This position could not be read.");
  const pool = findPool(order.venue, position.token0, position.token1, position.fee);
  if (!pool || pool.id !== order.poolId) throw new Error("This position is in a different pool.");
  if (position.tickLower !== order.tickLower || position.tickUpper !== order.tickUpper) {
    throw new Error("This position's range does not match the one on screen.");
  }
  if (position.liquidity !== order.liquidity) {
    throw new Error("This position changed. Check the new amounts before withdrawing.");
  }
  const market = await readPoolMarket(pool);
  const fresh = quoteWithdraw(
    market.sqrtPriceX96,
    { tickLower: position.tickLower, tickUpper: position.tickUpper },
    position.liquidity,
    order.percent,
  );
  if (fresh.liquidityOut !== order.liquidityOut) {
    throw new Error("This position changed. Check the new amounts before withdrawing.");
  }
  if (fresh.amount0 < order.min0 || fresh.amount1 < order.min1) {
    throw new Error("The pool price moved. Check the new amounts before withdrawing.");
  }
  const eth = await hemiProvider().getBalance(wallet.address);
  if (eth === 0n) throw new Error("This Hemi address has no ETH for gas.");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
  const data = encodeWithdraw(
    order.venue,
    order.tokenId,
    wallet.address,
    position.token0,
    position.token1,
    order.liquidityOut,
    order.min0,
    order.min1,
    deadline,
    order.percent === 100,
  );
  const tx = await wallet.sendTransaction({ to: manager, data, value: 0n });
  const receipt = await tx.wait();
  if (receipt && receipt.status === 0) throw new Error("The withdrawal failed.");
  return receipt?.hash ?? tx.hash;
}

async function listVenue(owner: string, venue: PoolVenue): Promise<{ positions: LpPosition[]; truncated: boolean }> {
  const manager = managerFor(venue);
  const npm = new Contract(manager, positionAbi, hemiProvider());
  const balance = await npm.balanceOf(owner) as bigint;
  const truncated = balance > BigInt(POSITION_CAP);
  const count = truncated ? POSITION_CAP : Number(balance);
  const ids = await Promise.all(
    Array.from({ length: count }, (_, index) => npm.tokenOfOwnerByIndex(owner, index) as Promise<bigint>),
  );
  const rows = await Promise.all(ids.map(async (tokenId) => {
    const position = await readOne(npm, tokenId);
    if (!position) return null;
    const pool = findPool(venue, position.token0, position.token1, position.fee);
    if (!pool) return null;
    const fees = await previewFees(manager, tokenId, owner);
    if ((position.liquidity === 0n) && (!fees || (fees.amount0 === 0n && fees.amount1 === 0n))) return null;
    let market: PoolMarket | null = null;
    try {
      market = await readPoolMarket(pool);
    } catch {
      market = null;
    }
    return toRow(venue, tokenId, pool, position, fees, market);
  }));
  return { positions: rows.filter((row): row is LpPosition => row != null), truncated };
}

type OnchainPosition = {
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
};

async function readOne(npm: Contract, tokenId: bigint): Promise<OnchainPosition | null> {
  try {
    const row = await npm.positions(tokenId) as {
      token0: string;
      token1: string;
      fee: bigint;
      tickLower: bigint;
      tickUpper: bigint;
      liquidity: bigint;
    };
    return {
      token0: row.token0,
      token1: row.token1,
      fee: Number(row.fee),
      tickLower: Number(row.tickLower),
      tickUpper: Number(row.tickUpper),
      liquidity: row.liquidity,
    };
  } catch {
    return null;
  }
}

async function previewFees(
  manager: string,
  tokenId: bigint,
  owner: string,
): Promise<{ amount0: bigint; amount1: bigint } | null> {
  const npm = new Contract(manager, positionAbi, hemiProvider());
  try {
    const out = await npm.collect.staticCall(
      [tokenId, owner, MAX128, MAX128],
      { from: owner },
    ) as [bigint, bigint];
    return { amount0: out[0], amount1: out[1] };
  } catch {
    return null;
  }
}

function toRow(
  venue: PoolVenue,
  tokenId: bigint,
  pool: PoolInfo,
  position: OnchainPosition,
  fees: { amount0: bigint; amount1: bigint } | null,
  market: PoolMarket | null,
): LpPosition {
  const spec0 = assetSpec(pool.token0);
  const spec1 = assetSpec(pool.token1);
  const inRange = market != null && position.tickLower <= market.tick && market.tick < position.tickUpper;
  const held = market
    ? amountsForLiquidity(market.sqrtPriceX96, { tickLower: position.tickLower, tickUpper: position.tickUpper }, position.liquidity)
    : null;
  return {
    venue,
    tokenId: tokenId.toString(),
    venueLabel: venue === "sushi" ? "Sushi" : "BrownFi",
    pairLabel: pool.pairLabel,
    feeLabel: pool.feeLabel,
    token0: pool.token0,
    token1: pool.token1,
    lowerPrice: formatTickPrice(position.tickLower, spec0.decimals, spec1.decimals),
    upperPrice: formatTickPrice(position.tickUpper, spec0.decimals, spec1.decimals),
    priceUnit: `${spec1.label} per ${spec0.label}`,
    inRange,
    feesKnown: fees != null,
    fee0: fees?.amount0 ?? 0n,
    fee1: fees?.amount1 ?? 0n,
    poolId: pool.id,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    liquidity: position.liquidity,
    amountsKnown: held != null,
    amount0: held?.amount0 ?? 0n,
    amount1: held?.amount1 ?? 0n,
  };
}

function claimCalls(venue: PoolVenue, tokenId: bigint, recipient: string, token0: string, token1: string): string[] {
  const weth = assetSpec("eth").address.toLowerCase();
  const native = token0.toLowerCase() === weth || token1.toLowerCase() === weth;
  const collect = positionIface.encodeFunctionData("collect", [[
    tokenId,
    native ? ZERO : recipient,
    MAX128,
    MAX128,
  ]]);
  if (!native) return [collect];
  const unwrap = venue === "sushi"
    ? positionIface.encodeFunctionData("unwrapWETH9", [0, recipient])
    : positionIface.encodeFunctionData("unwrapWNativeToken", [0, recipient]);
  const other = token0.toLowerCase() === weth ? token1 : token0;
  const sweep = positionIface.encodeFunctionData("sweepToken", [getAddress(other), 0, recipient]);
  return [collect, unwrap, sweep];
}

function encodeClaim(venue: PoolVenue, tokenId: bigint, recipient: string, token0: string, token1: string): string {
  const calls = claimCalls(venue, tokenId, recipient, token0, token1);
  return calls.length === 1 ? calls[0] : positionIface.encodeFunctionData("multicall", [calls]);
}

function encodeWithdraw(
  venue: PoolVenue,
  tokenId: bigint,
  recipient: string,
  token0: string,
  token1: string,
  liquidityOut: bigint,
  min0: bigint,
  min1: bigint,
  deadline: bigint,
  burn: boolean,
): string {
  const decrease = positionIface.encodeFunctionData("decreaseLiquidity", [[
    tokenId,
    liquidityOut,
    min0,
    min1,
    deadline,
  ]]);
  // Collect clears tokens owed, which burn requires. Fees come out with the withdrawal.
  const calls = [...claimCalls(venue, tokenId, recipient, token0, token1)];
  calls.unshift(decrease);
  if (burn) calls.push(positionIface.encodeFunctionData("burn", [tokenId]));
  return positionIface.encodeFunctionData("multicall", [calls]);
}

export function formatFee(amount: bigint, asset: PoolAsset): string | null {
  if (amount <= 0n) return null;
  const spec = assetSpec(asset);
  return `${formatUnits(amount, spec.decimals)} ${spec.label}`;
}

export function positionFeeLine(position: LpPosition): string {
  if (!position.feesKnown) return "Could not read";
  const parts = [formatFee(position.fee0, position.token0), formatFee(position.fee1, position.token1)]
    .filter((part): part is string => part != null);
  return parts.length > 0 ? parts.join(" · ") : "None yet";
}

/**
 * Dollar value of tokens sitting in the positions.
 * Null when a position with liquidity has no amounts yet, or a non-zero side has no price.
 * Trading fees are not included.
 */
export function poolsValueUsd(book: PriceBook | null, positions: readonly LpPosition[]): number | null {
  const holdings: ValuedHolding[] = [];
  for (const position of positions) {
    if (position.liquidity === 0n) continue;
    if (!position.amountsKnown) return null;
    const left = assetSpec(position.token0);
    const right = assetSpec(position.token1);
    holdings.push({ amount: position.amount0, decimals: left.decimals, token: left.address });
    holdings.push({ amount: position.amount1, decimals: right.decimals, token: right.address });
  }
  return walletValueUsd(book, holdings);
}

/** Dollar value of the held tokens, or of the trading-fee rewards. */
export function positionUsdLine(position: LpPosition, book: PriceBook | null, kind: "size" | "fees"): string | null {
  if (kind === "size") {
    if (position.liquidity === 0n || !position.amountsKnown) return null;
  } else if (!position.feesKnown) return null;
  const spec0 = assetSpec(position.token0);
  const spec1 = assetSpec(position.token1);
  return legsUsd(book, [
    {
      amount: kind === "size" ? position.amount0 : position.fee0,
      decimals: spec0.decimals,
      address: spec0.address,
      label: spec0.label,
    },
    {
      amount: kind === "size" ? position.amount1 : position.fee1,
      decimals: spec1.decimals,
      address: spec1.address,
      label: spec1.label,
    },
  ]);
}

export function positionSizeLine(position: LpPosition): string {
  if (position.liquidity === 0n) return "No liquidity left";
  if (!position.amountsKnown) return "Position size unavailable";
  const parts = [formatFee(position.amount0, position.token0), formatFee(position.amount1, position.token1)]
    .filter((part): part is string => part != null);
  return parts.length > 0 ? `Held ${parts.join(" · ")}` : "Held amount is too small to show";
}
