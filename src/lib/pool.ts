import { Contract, Interface, Wallet, getAddress } from "ethers";
import { BROWNFI_POSITION_MANAGER, HEMIBTC, HEMI_TOKEN, SUSHI_POSITION_MANAGER, VETRO_USD, VUSD, WBTC } from "../chain";
import { formatUnits, parseUnits } from "./format";
import { hemiProvider } from "./hemi";
import { ETH_GAS_RESERVE } from "./swap";

/** Canonical WETH on Hemi. Pool token0 when the deposit pays native ETH. */
const WETH = "0x4200000000000000000000000000000000000006";
const ZERO = "0x0000000000000000000000000000000000000000";

/** Half a percent, matching swaps. */
const SLIPPAGE_BPS = 50n;
const MIN_TICK = -887272;
const MAX_TICK = 887272;
const Q96 = 2n ** 96n;

const SLOT0 = "0x3850c7bd";
const GLOBAL_STATE = "0xe76c01e4";
const TICK_SPACING = "0xd0c93a7c";
const FEE = "0xddca3f43";

const allowanceAbi = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

const sushiIface = new Interface([
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function refundETH() payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
]);

const brownfiIface = new Interface([
  "function mint((address token0, address token1, address deployer, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function refundNativeToken() payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
]);

export type PoolAsset = "eth" | "hemi" | "vusd" | "hemibtc" | "vetro" | "wbtc";
export type PoolVenue = "sushi" | "brownfi";
export type PoolSide = "token0" | "token1";

export type PoolInfo = {
  id: string;
  venue: PoolVenue;
  /** Pair key shared by the fee tiers of one market. */
  pair: string;
  pairLabel: string;
  token0: PoolAsset;
  token1: PoolAsset;
  /** Sushi fee pips. BrownFi picks the fee inside the pool, so this is 0. */
  fee: number;
  feeLabel: string;
  /** Open this tier first when the pair has several. */
  preferred: boolean;
  pool: string;
};

type AssetSpec = { label: string; decimals: number; address: string; native: boolean };

const ASSETS: Record<PoolAsset, AssetSpec> = {
  eth: { label: "ETH", decimals: 18, address: WETH, native: true },
  hemi: { label: "HEMI", decimals: 18, address: HEMI_TOKEN, native: false },
  vusd: { label: "VUSD", decimals: 18, address: VUSD, native: false },
  hemibtc: { label: "hemiBTC", decimals: 8, address: HEMIBTC, native: false },
  /** BrownFi's VUSD ticker. A different contract from official VUSD. */
  vetro: { label: "Vetro", decimals: 18, address: VETRO_USD, native: false },
  wbtc: { label: "WBTC", decimals: 8, address: WBTC, native: false },
};

/**
 * Live Hemi pools read back from the factories. Empty pools are left out.
 * Sushi pairs are ETH, HEMI, official VUSD, and hemiBTC.
 * BrownFi's HEMI and WETH "VUSD" markets are Vetro USD, not official VUSD.
 * Official VUSD has no BrownFi pool with HEMI or WETH.
 */
export const POOLS: PoolInfo[] = [
  pool("sushi", "hemi-eth", "HEMI / ETH", "eth", "hemi", 500, "0x0222c96283754e92c859336b95f293d061675463", false),
  pool("sushi", "hemi-eth", "HEMI / ETH", "eth", "hemi", 3000, "0xc871132b4c67a81fb416067c1a07998dc6131685", true),
  pool("sushi", "hemi-hemibtc", "HEMI / hemiBTC", "hemi", "hemibtc", 500, "0x519ce7290870ff699f7a1f7fc6aff00172f4fefc", true),
  pool("sushi", "vusd-eth", "VUSD / ETH", "eth", "vusd", 100, "0xbe8fcf7afc0b67f2124056c1fc3c1119c7f2eceb", false),
  pool("sushi", "vusd-eth", "VUSD / ETH", "eth", "vusd", 500, "0xdc805886ebca1ee5a0107405deeb8a6802749ba2", false),
  pool("sushi", "vusd-eth", "VUSD / ETH", "eth", "vusd", 3000, "0x9d0558bb39f30960a10c0558867e344d0d7196b5", true),
  pool("sushi", "hemibtc-eth", "hemiBTC / ETH", "eth", "hemibtc", 100, "0x3f1228f4bd8de23dec4e1fcf81f16ed7fde5d1a8", false),
  pool("sushi", "hemibtc-eth", "hemiBTC / ETH", "eth", "hemibtc", 500, "0xd8a6e60661aa3e53bcd77cc0d20f462c2d9376b9", false),
  pool("sushi", "hemibtc-eth", "hemiBTC / ETH", "eth", "hemibtc", 3000, "0x51109fa53e904c17daeb320d56166900e23707d3", true),
  pool("sushi", "hemibtc-eth", "hemiBTC / ETH", "eth", "hemibtc", 10000, "0xe31377f1f1e200a24e8c2d5b059829635b8c34ea", false),
  pool("sushi", "hemibtc-vusd", "hemiBTC / VUSD", "vusd", "hemibtc", 3000, "0x2870cbb75529cd48b5cb04cbc454bb9e81a43962", false),
  pool("sushi", "hemibtc-vusd", "hemiBTC / VUSD", "vusd", "hemibtc", 10000, "0x249b964a6abff2ea43c6502eabaddc68e08276df", true),
  pool("brownfi", "hemibtc-eth", "hemiBTC / ETH", "eth", "hemibtc", 0, "0x44b4db10a1891926f8b655944babe0cdde774b90", true),
  pool("brownfi", "hemi-vetro", "HEMI / Vetro", "hemi", "vetro", 0, "0x7e8b925b43dBb364DeF5E44e93E9f8fBc02cfC21", true),
  pool("brownfi", "vetro-eth", "Vetro / ETH", "eth", "vetro", 0, "0x6153eF0ABFE8fA881A2492743dfc34ec594868D1", true),
  pool("brownfi", "wbtc-hemibtc", "WBTC / hemiBTC", "wbtc", "hemibtc", 0, "0xd34D0734b8d225dF900f21a1EF5444AdCE7e4BEA", true),
];

export const DEFAULT_POOL_ID = "sushi-hemi-eth-3000";

export type PoolQuote = {
  amount0: bigint;
  amount1: bigint;
  min0: bigint;
  min1: bigint;
  tickLower: number;
  tickUpper: number;
  sqrtPriceX96: bigint;
};

export type PoolDeposit = {
  poolId: string;
  driver: PoolSide;
  /** Amount of the side the user typed, in raw token units. */
  amount: bigint;
  amount0: bigint;
  amount1: bigint;
  tickLower: number;
  tickUpper: number;
};

export type PoolMarket = {
  sqrtPriceX96: bigint;
  tick: number;
  spacing: number;
};

export type TickRange = { tickLower: number; tickUpper: number };

/** Which tokens a deposit uses while the pool price sits where it is. */
export type DepositSides = "both" | "token0" | "token1";

export function poolById(id: string): PoolInfo | null {
  return POOLS.find((item) => item.id === id) ?? null;
}

export function assetSpec(id: PoolAsset): AssetSpec {
  return ASSETS[id];
}

export function managerFor(venue: PoolVenue): string {
  return venue === "sushi" ? SUSHI_POSITION_MANAGER : BROWNFI_POSITION_MANAGER;
}

/** Deposit sized from one side at the pool's current price and the chosen ticks. */
export async function quoteDeposit(
  pool: PoolInfo,
  driver: PoolSide,
  amount: bigint,
  range: TickRange,
): Promise<PoolQuote> {
  const market = await readPoolMarket(pool);
  return quoteOn(pool, market, range, driver, amount);
}

/**
 * Largest deposit on `driver` that still fits the free balances this range needs.
 * A range around the current price takes both tokens. A range entirely above or
 * below the price takes only one.
 */
export async function maxDeposit(
  pool: PoolInfo,
  driver: PoolSide,
  free0: bigint,
  free1: bigint,
  range: TickRange,
): Promise<PoolQuote> {
  const market = await readPoolMarket(pool);
  const sides = depositSides(market.sqrtPriceX96, range);
  if (sides === "token0" && driver === "token1") {
    throw new Error(`The price is below this range, so it only takes ${ASSETS[pool.token0].label}.`);
  }
  if (sides === "token1" && driver === "token0") {
    throw new Error(`The price is above this range, so it only takes ${ASSETS[pool.token1].label}.`);
  }
  const needs0 = sides !== "token1";
  const needs1 = sides !== "token0";
  if (needs0 && free0 <= 0n) {
    throw new Error(`This deposit needs ${ASSETS[pool.token0].label}. ${ASSETS[pool.token0].label} has nothing available.`);
  }
  if (needs1 && free1 <= 0n) {
    throw new Error(`This deposit needs ${ASSETS[pool.token1].label}. ${ASSETS[pool.token1].label} has nothing available.`);
  }
  const state = { sqrtPriceX96: market.sqrtPriceX96, ...range };
  const cap = driver === "token0" ? free0 : free1;
  let lo = 0n;
  let hi = cap;
  let best: PoolQuote | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) / 2n;
    if (mid === 0n) break;
    const quote = tryQuote(state, driver, mid);
    if (!quote) {
      lo = mid + 1n;
      continue;
    }
    const fits = quote.amount0 <= free0 && quote.amount1 <= free1;
    if (fits) {
      best = quote;
      lo = mid + 1n;
    } else {
      hi = mid - 1n;
    }
  }
  if (!best) throw new Error("That amount is too small for this range.");
  return best;
}

export async function poolNeedsApproval(owner: string, pool: PoolInfo, amount0: bigint, amount1: bigint): Promise<boolean> {
  const manager = managerFor(pool.venue);
  const needs = spenders(pool, amount0, amount1);
  for (const need of needs) {
    const token = new Contract(need.token, allowanceAbi, hemiProvider());
    const allowed = await token.allowance(owner, manager) as bigint;
    if (allowed < need.amount) return true;
  }
  return false;
}

export async function executePoolDeposit(
  privateKey: string,
  from: string,
  order: PoolDeposit,
  onPhase?: (phase: "approve" | "deposit") => void,
): Promise<string> {
  const pool = poolById(order.poolId);
  if (!pool) throw new Error("Pick a pool.");
  if (order.amount <= 0n) throw new Error("Enter an amount to deposit.");
  const market = await readPoolMarket(pool);
  assertRange(market.spacing, { tickLower: order.tickLower, tickUpper: order.tickUpper });
  const fresh = quoteOn(pool, market, { tickLower: order.tickLower, tickUpper: order.tickUpper }, order.driver, order.amount);
  const freshDriver = order.driver === "token0" ? fresh.amount0 : fresh.amount1;
  const freshOther = order.driver === "token0" ? fresh.amount1 : fresh.amount0;
  const shownOther = order.driver === "token0" ? order.amount1 : order.amount0;
  if (freshDriver !== order.amount || freshOther > shownOther * (10_000n + SLIPPAGE_BPS) / 10_000n) {
    throw new Error("The pool price moved. Check the new amounts before depositing.");
  }

  const wallet = new Wallet(privateKey, hemiProvider());
  const manager = getAddress(managerFor(pool.venue));
  const value = ethValue(pool, fresh.amount0, fresh.amount1);
  const eth = await hemiProvider().getBalance(from);
  if (value > 0n) {
    if (eth < value + ETH_GAS_RESERVE) throw new Error("Leave 0.0003 ETH for gas.");
  } else if (eth === 0n) {
    throw new Error("This Hemi address has no ETH for gas.");
  }
  for (const need of spenders(pool, fresh.amount0, fresh.amount1)) {
    const token = new Contract(need.token, allowanceAbi, wallet);
    const balance = await token.balanceOf(from) as bigint;
    if (balance < need.amount) {
      throw new Error(`Only ${formatUnits(balance, need.decimals)} ${need.label} is in this wallet.`);
    }
  }

  let approving = false;
  for (const need of spenders(pool, fresh.amount0, fresh.amount1)) {
    const token = new Contract(need.token, allowanceAbi, wallet);
    const allowed = await token.allowance(from, manager) as bigint;
    if (allowed < need.amount) {
      if (!approving) {
        approving = true;
        onPhase?.("approve");
      }
      const approveTx = await token.approve(manager, need.amount);
      await approveTx.wait();
    }
  }

  onPhase?.("deposit");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
  const data = encodeDeposit(pool, fresh, from, deadline, value > 0n);
  const tx = await wallet.sendTransaction({ to: manager, data, value });
  const receipt = await tx.wait();
  if (receipt && receipt.status === 0) throw new Error("The deposit failed.");
  return receipt?.hash ?? tx.hash;
}

type PoolState = { sqrtPriceX96: bigint; tickLower: number; tickUpper: number };

export async function readPoolMarket(pool: PoolInfo): Promise<PoolMarket> {
  const provider = hemiProvider();
  const priceData = pool.venue === "sushi" ? SLOT0 : GLOBAL_STATE;
  const [priceHex, spacingHex, feeHex] = await Promise.all([
    provider.call({ to: pool.pool, data: priceData }),
    provider.call({ to: pool.pool, data: TICK_SPACING }),
    pool.venue === "sushi" ? provider.call({ to: pool.pool, data: FEE }) : Promise.resolve(null),
  ]);
  const sqrtPriceX96 = word(priceHex, 0);
  if (sqrtPriceX96 <= 0n) throw new Error("This pool is not open for deposits.");
  const spacing = int24(word(spacingHex, 0));
  if (spacing <= 0) throw new Error("This pool has no tick spacing.");
  if (feeHex != null) {
    const fee = Number(word(feeHex, 0));
    if (fee !== pool.fee) throw new Error("This pool's fee does not match the one on screen.");
  }
  return { sqrtPriceX96, tick: int24(word(priceHex, 1)), spacing };
}

export function fullRange(spacing: number): TickRange {
  return {
    tickLower: Math.ceil(MIN_TICK / spacing) * spacing,
    tickUpper: Math.floor(MAX_TICK / spacing) * spacing,
  };
}

/** A band around the current tick, widened out to the pool's tick spacing. */
export function bandRange(tick: number, spacing: number, percent: number): TickRange {
  const delta = Math.max(spacing, Math.round(Math.log(1 + percent / 100) / Math.log(1.0001)));
  const bounds = fullRange(spacing);
  let range = alignRange(tick - delta, tick + delta, spacing);
  if (range.tickLower > tick) range = { ...range, tickLower: Math.max(bounds.tickLower, Math.floor(tick / spacing) * spacing) };
  if (range.tickUpper <= tick) range = { ...range, tickUpper: Math.min(bounds.tickUpper, Math.floor(tick / spacing) * spacing + spacing) };
  if (range.tickUpper <= range.tickLower) range = alignRange(range.tickLower, range.tickLower + spacing, spacing);
  return range;
}

/** Prices are token1 per one token0. Ticks snap outward so the band contains them. */
export function ticksFromPrices(
  lowText: string,
  highText: string,
  dec0: number,
  dec1: number,
  spacing: number,
): TickRange | null {
  const low = priceToTick(lowText, dec0, dec1);
  const high = priceToTick(highText, dec0, dec1);
  if (low == null || high == null || low >= high) return null;
  const range = alignRange(low, high, spacing);
  return range.tickLower < range.tickUpper ? range : null;
}

export function depositSides(sqrtPriceX96: bigint, range: TickRange): DepositSides {
  const sqrtLower = sqrtPriceAtTick(range.tickLower);
  const sqrtUpper = sqrtPriceAtTick(range.tickUpper);
  if (sqrtPriceX96 <= sqrtLower) return "token0";
  if (sqrtPriceX96 >= sqrtUpper) return "token1";
  return "both";
}

/** Token amounts held by `liquidity` in this range at the current price. */
export function amountsForLiquidity(
  sqrtPriceX96: bigint,
  range: TickRange,
  liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
  const sqrtLower = sqrtPriceAtTick(range.tickLower);
  const sqrtUpper = sqrtPriceAtTick(range.tickUpper);
  if (liquidity <= 0n || sqrtLower >= sqrtUpper) return { amount0: 0n, amount1: 0n };
  if (sqrtPriceX96 <= sqrtLower) {
    return { amount0: amount0ForLiquidity(sqrtLower, sqrtUpper, liquidity), amount1: 0n };
  }
  if (sqrtPriceX96 >= sqrtUpper) {
    return { amount0: 0n, amount1: amount1ForLiquidity(sqrtLower, sqrtUpper, liquidity) };
  }
  return {
    amount0: amount0ForLiquidity(sqrtPriceX96, sqrtUpper, liquidity),
    amount1: amount1ForLiquidity(sqrtLower, sqrtPriceX96, liquidity),
  };
}

export function findPool(venue: PoolVenue, token0: string, token1: string, fee: number): PoolInfo | null {
  const left = token0.toLowerCase();
  const right = token1.toLowerCase();
  return POOLS.find((pool) => {
    if (pool.venue !== venue) return false;
    if (ASSETS[pool.token0].address.toLowerCase() !== left) return false;
    if (ASSETS[pool.token1].address.toLowerCase() !== right) return false;
    return venue === "brownfi" || pool.fee === fee;
  }) ?? null;
}

/** token1 received for one token0, shown the same way as the pool price line. */
export function formatSqrtPrice(sqrt: bigint, dec0: number, dec1: number): string {
  const scale = 10n ** 18n;
  const num = sqrt * sqrt * scale * 10n ** BigInt(dec0);
  const den = (2n ** 192n) * 10n ** BigInt(dec1);
  if (den === 0n) return "—";
  return showAmount(num / den, 18);
}

export function formatTickPrice(tick: number, dec0: number, dec1: number): string {
  return formatSqrtPrice(sqrtPriceAtTick(tick), dec0, dec1);
}

function quoteOn(pool: PoolInfo, market: PoolMarket, range: TickRange, driver: PoolSide, amount: bigint): PoolQuote {
  const sides = depositSides(market.sqrtPriceX96, range);
  if (sides === "token0" && driver === "token1") {
    throw new Error(`The price is below this range, so it only takes ${ASSETS[pool.token0].label}.`);
  }
  if (sides === "token1" && driver === "token0") {
    throw new Error(`The price is above this range, so it only takes ${ASSETS[pool.token1].label}.`);
  }
  const quote = tryQuote({ sqrtPriceX96: market.sqrtPriceX96, ...range }, driver, amount);
  if (!quote) throw new Error("That amount is too small for this range.");
  return quote;
}

function assertRange(spacing: number, range: TickRange) {
  const bounds = fullRange(spacing);
  if (!Number.isInteger(range.tickLower) || !Number.isInteger(range.tickUpper)) throw new Error("The range is not valid.");
  if (range.tickLower >= range.tickUpper) throw new Error("The range is empty.");
  if (spacing <= 0 || range.tickLower % spacing !== 0 || range.tickUpper % spacing !== 0) {
    throw new Error("The range does not match this pool.");
  }
  if (range.tickLower < bounds.tickLower || range.tickUpper > bounds.tickUpper) {
    throw new Error("The range is outside this pool.");
  }
}

function alignRange(lowerTick: number, upperTick: number, spacing: number): TickRange {
  const bounds = fullRange(spacing);
  let tickLower = Math.floor(lowerTick / spacing) * spacing;
  let tickUpper = Math.ceil(upperTick / spacing) * spacing;
  if (tickLower < bounds.tickLower) tickLower = bounds.tickLower;
  if (tickUpper > bounds.tickUpper) tickUpper = bounds.tickUpper;
  if (tickUpper <= tickLower) {
    if (tickLower + spacing <= bounds.tickUpper) tickUpper = tickLower + spacing;
    else tickLower = tickUpper - spacing;
  }
  return { tickLower, tickUpper };
}

function priceToTick(text: string, dec0: number, dec1: number): number | null {
  const scaled = parseUnits(text, 18);
  if (scaled == null || scaled <= 0n) return null;
  const num = scaled * 10n ** BigInt(dec1) * Q96 * Q96;
  const den = 10n ** BigInt(18 + dec0);
  const sqrt = isqrt(num / den);
  if (sqrt <= 0n) return null;
  return tickAtSqrtPrice(sqrt);
}

function isqrt(value: bigint): bigint {
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

/** Highest tick whose sqrt price is still at or below `sqrtPriceX96`. */
export function tickAtSqrtPrice(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 <= sqrtPriceAtTick(MIN_TICK)) return MIN_TICK;
  if (sqrtPriceX96 >= sqrtPriceAtTick(MAX_TICK)) return MAX_TICK;
  let lo = MIN_TICK;
  let hi = MAX_TICK;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (sqrtPriceAtTick(mid) <= sqrtPriceX96) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Pure quote for a tick range. `null` when the amount rounds to no liquidity. */
export function quoteAtPrice(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  driver: PoolSide,
  amount: bigint,
): PoolQuote | null {
  return tryQuote({ sqrtPriceX96, tickLower, tickUpper }, driver, amount);
}

function tryQuote(state: PoolState, driver: PoolSide, amount: bigint): PoolQuote | null {
  if (amount <= 0n || state.tickLower >= state.tickUpper) return null;
  const sqrtLower = sqrtPriceAtTick(state.tickLower);
  const sqrtUpper = sqrtPriceAtTick(state.tickUpper);
  const sqrt = state.sqrtPriceX96;
  let amount0 = 0n;
  let amount1 = 0n;
  let liquidity = 0n;
  if (sqrt <= sqrtLower) {
    if (driver !== "token0") return null;
    liquidity = liquidityForAmount0(sqrtLower, sqrtUpper, amount);
    amount0 = amount;
  } else if (sqrt >= sqrtUpper) {
    if (driver !== "token1") return null;
    liquidity = liquidityForAmount1(sqrtLower, sqrtUpper, amount);
    amount1 = amount;
  } else if (driver === "token0") {
    liquidity = liquidityForAmount0(sqrt, sqrtUpper, amount);
    amount1 = amount1ForLiquidity(sqrtLower, sqrt, liquidity);
    amount0 = amount;
    if (amount1 <= 0n) return null;
  } else {
    liquidity = liquidityForAmount1(sqrtLower, sqrt, amount);
    amount0 = amount0ForLiquidity(sqrt, sqrtUpper, liquidity);
    amount1 = amount;
    if (amount0 <= 0n) return null;
  }
  if (liquidity <= 0n) return null;
  return {
    amount0,
    amount1,
    min0: withSlippage(amount0),
    min1: withSlippage(amount1),
    tickLower: state.tickLower,
    tickUpper: state.tickUpper,
    sqrtPriceX96: sqrt,
  };
}

function encodeDeposit(pool: PoolInfo, quote: PoolQuote, recipient: string, deadline: bigint, refund: boolean): string {
  if (pool.venue === "sushi") {
    const mint = sushiIface.encodeFunctionData("mint", [[
      getAddress(ASSETS[pool.token0].address),
      getAddress(ASSETS[pool.token1].address),
      pool.fee,
      quote.tickLower,
      quote.tickUpper,
      quote.amount0,
      quote.amount1,
      quote.min0,
      quote.min1,
      recipient,
      deadline,
    ]]);
    if (!refund) return mint;
    return sushiIface.encodeFunctionData("multicall", [[mint, sushiIface.encodeFunctionData("refundETH")]]);
  }
  const mint = brownfiIface.encodeFunctionData("mint", [[
    getAddress(ASSETS[pool.token0].address),
    getAddress(ASSETS[pool.token1].address),
    ZERO,
    quote.tickLower,
    quote.tickUpper,
    quote.amount0,
    quote.amount1,
    quote.min0,
    quote.min1,
    recipient,
    deadline,
  ]]);
  if (!refund) return mint;
  return brownfiIface.encodeFunctionData("multicall", [[mint, brownfiIface.encodeFunctionData("refundNativeToken")]]);
}

function spenders(pool: PoolInfo, amount0: bigint, amount1: bigint): { token: string; amount: bigint; label: string; decimals: number }[] {
  const rows: { token: string; amount: bigint; label: string; decimals: number }[] = [];
  const add = (id: PoolAsset, amount: bigint) => {
    const spec = ASSETS[id];
    if (!spec.native && amount > 0n) rows.push({ token: spec.address, amount, label: spec.label, decimals: spec.decimals });
  };
  add(pool.token0, amount0);
  add(pool.token1, amount1);
  return rows;
}

function ethValue(pool: PoolInfo, amount0: bigint, amount1: bigint): bigint {
  if (ASSETS[pool.token0].native) return amount0;
  if (ASSETS[pool.token1].native) return amount1;
  return 0n;
}

function withSlippage(amount: bigint): bigint {
  if (amount === 0n) return 0n;
  const min = amount * (10_000n - SLIPPAGE_BPS) / 10_000n;
  return min === 0n ? 1n : min;
}

function showAmount(amount: bigint, decimals: number): string {
  if (amount === 0n) return "0";
  const places = Math.min(6, decimals);
  if (places === decimals) return formatUnits(amount, decimals);
  const factor = 10n ** BigInt(decimals - places);
  const rounded = (amount + factor / 2n) / factor;
  if (rounded !== 0n) return formatUnits(rounded, places);
  const frac = formatUnits(amount, decimals).split(".")[1] ?? "";
  const start = frac.search(/[1-9]/);
  if (start < 0) return "0";
  const cut = frac.slice(0, Math.min(frac.length, start + 4)).replace(/0+$/, "");
  return `0.${cut}`;
}

function pool(
  venue: PoolVenue,
  pair: string,
  pairLabel: string,
  token0: PoolAsset,
  token1: PoolAsset,
  fee: number,
  address: string,
  preferred: boolean,
): PoolInfo {
  const feeLabel = fee === 100 ? "0.01%" : fee === 500 ? "0.05%" : fee === 3000 ? "0.3%" : fee === 10000 ? "1%" : "";
  return {
    id: `${venue}-${pair}-${fee || "pool"}`,
    venue,
    pair,
    pairLabel,
    token0,
    token1,
    fee,
    feeLabel,
    preferred,
    pool: getAddress(address),
  };
}

function word(hex: string, index: number): bigint {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  const start = index * 64;
  const slice = body.slice(start, start + 64);
  if (slice.length !== 64) throw new Error("Could not read this pool.");
  return BigInt(`0x${slice}`);
}

function int24(value: bigint): number {
  return Number(BigInt.asIntN(24, value));
}

/** Uniswap V3 TickMath.getSqrtRatioAtTick, so the quoted amounts match the pool. */
export function sqrtPriceAtTick(tick: number): bigint {
  const abs = tick < 0 ? -tick : tick;
  if (!Number.isInteger(tick) || abs > MAX_TICK) throw new Error("Tick is outside the pool range.");
  let ratio = (abs & 0x1) !== 0
    ? 0xfffcb933bd6fad37aa2d162d1a594001n
    : 0x100000000000000000000000000000000n;
  if (abs & 0x2) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if (abs & 0x4) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if (abs & 0x8) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if (abs & 0x10) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if (abs & 0x20) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if (abs & 0x40) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if (abs & 0x80) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if (abs & 0x100) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if (abs & 0x200) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if (abs & 0x400) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if (abs & 0x800) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if (abs & 0x1000) ratio = (ratio * 0xd097f3bdfd20277b4963315fdfd67d23n) >> 128n;
  if (abs & 0x2000) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if (abs & 0x4000) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if (abs & 0x8000) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if (abs & 0x10000) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if (abs & 0x20000) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if (abs & 0x40000) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if (abs & 0x80000) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  const rounded = ratio % (1n << 32n) === 0n ? 0n : 1n;
  return (ratio >> 32n) + rounded;
}

function liquidityForAmount0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  if (sqrtA > sqrtB) return liquidityForAmount0(sqrtB, sqrtA, amount0);
  const intermediate = (sqrtA * sqrtB) / Q96;
  return (amount0 * intermediate) / (sqrtB - sqrtA);
}

function liquidityForAmount1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  if (sqrtA > sqrtB) return liquidityForAmount1(sqrtB, sqrtA, amount1);
  return (amount1 * Q96) / (sqrtB - sqrtA);
}

function amount0ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  if (sqrtA > sqrtB) return amount0ForLiquidity(sqrtB, sqrtA, liquidity);
  return ((liquidity << 96n) * (sqrtB - sqrtA) / sqrtB) / sqrtA;
}

function amount1ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  if (sqrtA > sqrtB) return amount1ForLiquidity(sqrtB, sqrtA, liquidity);
  return (liquidity * (sqrtB - sqrtA)) / Q96;
}
