import { geckoJson } from "./gecko";
import { hemiProvider } from "./hemi";
import {
  amountsForLiquidity,
  assetSpec,
  depositSides,
  type PoolInfo,
  type PoolMarket,
  type TickRange,
} from "./pool";

const LIQUIDITY = "0x1a686502";
const GLOBAL_STATE = "0xe76c01e4";
/** One unit of liquidity, scaled out of the estimate so the deposit size cancels. */
const REFERENCE_LIQUIDITY = 10n ** 18n;

export type FeeAprInputs = {
  activeLiquidity: bigint;
  /** Fee kept by the position, in hundredths of a bip (1e-6). */
  feePips: number;
  /** Share of the swap fee the position keeps. 1 means the whole fee. */
  lpShare: number;
  volumeUsd24h: number;
  price0Usd: number;
  price1Usd: number;
};

export type FeeAprEstimate = {
  /** Annualized trading-fee return, in percent. */
  percent: number;
  inRange: boolean;
  lpShare: number;
};

/**
 * Last-24h volume from GeckoTerminal, plus the pool's active liquidity and the
 * fee a position actually keeps. BrownFi's community share is taken out of the fee.
 */
export async function loadFeeAprInputs(pool: PoolInfo): Promise<FeeAprInputs | null> {
  try {
    const provider = hemiProvider();
    const [liquidityHex, stateHex, volume] = await Promise.all([
      provider.call({ to: pool.pool, data: LIQUIDITY }),
      pool.venue === "brownfi" ? provider.call({ to: pool.pool, data: GLOBAL_STATE }) : Promise.resolve(null),
      fetchVolume(pool),
    ]);
    const activeLiquidity = BigInt(liquidityHex);
    if (activeLiquidity <= 0n || volume == null) return null;
    const fee = pool.venue === "sushi" ? { feePips: pool.fee, lpShare: 1 } : lpFee(stateHex);
    if (fee.feePips <= 0) return null;
    return { activeLiquidity, ...fee, ...volume };
  } catch {
    return null;
  }
}

/**
 * Fee APR for this range if today's volume repeated and the price stayed inside it.
 * A range that does not contain the price earns nothing until the price moves in.
 */
export function estimateFeeApr(
  market: PoolMarket,
  range: TickRange,
  inputs: FeeAprInputs,
  dec0: number,
  dec1: number,
): FeeAprEstimate | null {
  if (depositSides(market.sqrtPriceX96, range) !== "both") return { percent: 0, inRange: false, lpShare: inputs.lpShare };
  if (!(inputs.volumeUsd24h >= 0) || !(inputs.price0Usd > 0) || !(inputs.price1Usd > 0)) return null;
  if (inputs.activeLiquidity <= 0n || inputs.feePips <= 0) return null;
  const amounts = amountsForLiquidity(market.sqrtPriceX96, range, REFERENCE_LIQUIDITY);
  const capital = tokenUsd(amounts.amount0, dec0, inputs.price0Usd) + tokenUsd(amounts.amount1, dec1, inputs.price1Usd);
  if (!(capital > 0) || !Number.isFinite(capital)) return null;
  const share = Number(REFERENCE_LIQUIDITY) / Number(inputs.activeLiquidity);
  const annual = inputs.volumeUsd24h * (inputs.feePips / 1_000_000) * 365 * share;
  const percent = annual / capital * 100;
  if (!Number.isFinite(percent) || percent < 0) return null;
  return { percent, inRange: true, lpShare: inputs.lpShare };
}

async function fetchVolume(pool: PoolInfo): Promise<Pick<FeeAprInputs, "volumeUsd24h" | "price0Usd" | "price1Usd"> | null> {
  const url = `https://api.geckoterminal.com/api/v2/networks/hemi/pools/${pool.pool.toLowerCase()}`;
  const body = await geckoJson(url) as {
    data?: {
      attributes?: {
        volume_usd?: { h24?: string };
        base_token_price_usd?: string;
        quote_token_price_usd?: string;
      };
      relationships?: {
        base_token?: { data?: { id?: string } };
        quote_token?: { data?: { id?: string } };
      };
    };
  } | null;
  if (!body) return null;
  const attributes = body.data?.attributes;
  const volumeUsd24h = Number(attributes?.volume_usd?.h24);
  const basePrice = Number(attributes?.base_token_price_usd);
  const quotePrice = Number(attributes?.quote_token_price_usd);
  const base = tokenAddress(body.data?.relationships?.base_token?.data?.id);
  const quote = tokenAddress(body.data?.relationships?.quote_token?.data?.id);
  if (!Number.isFinite(volumeUsd24h) || volumeUsd24h < 0 || !(basePrice > 0) || !(quotePrice > 0)) return null;
  const token0 = assetSpec(pool.token0).address.toLowerCase();
  const token1 = assetSpec(pool.token1).address.toLowerCase();
  let price0Usd = 0;
  let price1Usd = 0;
  if (base === token0 && quote === token1) {
    price0Usd = basePrice;
    price1Usd = quotePrice;
  } else if (base === token1 && quote === token0) {
    price0Usd = quotePrice;
    price1Usd = basePrice;
  } else {
    return null;
  }
  return { volumeUsd24h, price0Usd, price1Usd };
}

/** Algebra globalState word 2 is the swap fee. Word 4 is the protocol share in thousandths. */
function lpFee(stateHex: string | null): { feePips: number; lpShare: number } {
  if (stateHex == null) return { feePips: 0, lpShare: 1 };
  const fee = Number(word(stateHex, 2));
  const community = Number(word(stateHex, 4));
  if (!Number.isFinite(fee) || fee <= 0 || fee > 100_000) return { feePips: 0, lpShare: 1 };
  if (!Number.isInteger(community) || community <= 0 || community >= 1000) return { feePips: fee, lpShare: 1 };
  return {
    feePips: Math.floor(fee * (1000 - community) / 1000),
    lpShare: (1000 - community) / 1000,
  };
}

function tokenAddress(id: string | undefined): string {
  return (id?.split("_").pop() ?? "").toLowerCase();
}

function tokenUsd(amount: bigint, decimals: number, price: number): number {
  if (amount <= 0n || !(price > 0)) return 0;
  const scaled = amount * 1_000_000n / 10n ** BigInt(decimals);
  const units = Number(scaled) / 1e6;
  if (!Number.isFinite(units)) return Number.POSITIVE_INFINITY;
  return units * price;
}

function word(hex: string, index: number): bigint {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  const slice = body.slice(index * 64, index * 64 + 64);
  if (slice.length !== 64) throw new Error("Could not read this pool.");
  return BigInt(`0x${slice}`);
}
