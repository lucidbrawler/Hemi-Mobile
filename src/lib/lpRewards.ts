import { Contract, Interface, Wallet, getAddress } from "ethers";
import { formatUnits } from "./format";
import { hemiProvider } from "./hemi";
import {
  assetSpec,
  findPool,
  formatTickPrice,
  managerFor,
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
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)",
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
};

export type LpRewardSnapshot = {
  positions: LpPosition[];
  truncated: boolean;
};

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
  };
}

function encodeClaim(venue: PoolVenue, tokenId: bigint, recipient: string, token0: string, token1: string): string {
  const weth = assetSpec("eth").address.toLowerCase();
  const native = token0.toLowerCase() === weth || token1.toLowerCase() === weth;
  const collect = positionIface.encodeFunctionData("collect", [[
    tokenId,
    native ? ZERO : recipient,
    MAX128,
    MAX128,
  ]]);
  if (!native) return collect;
  const unwrap = venue === "sushi"
    ? positionIface.encodeFunctionData("unwrapWETH9", [0, recipient])
    : positionIface.encodeFunctionData("unwrapWNativeToken", [0, recipient]);
  const other = token0.toLowerCase() === weth ? token1 : token0;
  const sweep = positionIface.encodeFunctionData("sweepToken", [getAddress(other), 0, recipient]);
  return positionIface.encodeFunctionData("multicall", [[collect, unwrap, sweep]]);
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
