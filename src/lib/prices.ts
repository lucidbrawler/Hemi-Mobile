/**
 * USD prices for the tokens this wallet shows.
 * One GeckoTerminal call covers WETH, HEMI, official VUSD, Vetro, hemiBTC,
 * WBTC, USDT, and bridged USDC.e. Native BTC uses the mempool price.
 * hemiBTC and WBTC use that BTC price only when this feed has no price.
 * A token the feed leaves out stays unpriced. Vetro uses its own feed price.
 */

import { HEMIBTC, HEMI_TOKEN, USDT, VETRO_USD, VUSD, WBTC } from "../chain";
import { formatUsd } from "./format";
import { geckoJson } from "./gecko";

/** Canonical WETH on Hemi. Prices native ETH on Ethereum and on Hemi. */
export const WETH = "0x4200000000000000000000000000000000000006";

/** Bridged USDC (Stargate) on Hemi. veHEMI epoch rewards pay this token. */
const USDC_E = "0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA";

const SIMPLE = "https://api.geckoterminal.com/api/v2/simple/networks/hemi/token_price/";

export const PRICE_TOKENS = [WETH, HEMI_TOKEN, VUSD, VETRO_USD, HEMIBTC, WBTC, USDT, USDC_E];

const BTC_LIKE = new Set([HEMIBTC.toLowerCase(), WBTC.toLowerCase()]);

export type PriceBook = {
  /** USD for one whole token, keyed by lowercase address. */
  byAddress: Record<string, number>;
  /** Mempool BTC/USD. Native BTC uses this. */
  btc: number | null;
};

export type UsdLeg = {
  amount: bigint;
  decimals: number;
  address: string;
  label: string;
};

export function fetchTokenPrices(addresses: readonly string[]): Promise<Record<string, number> | null> {
  const list = [...new Set(addresses.map((item) => item.toLowerCase()))].filter((item) => /^0x[0-9a-f]{40}$/.test(item));
  if (list.length === 0) return Promise.resolve({});
  return geckoJson(`${SIMPLE}${list.join(",")}`).then((body) => (body == null ? null : readPrices(body)));
}

export function tokenPrice(book: PriceBook, address: string): number | null {
  const key = address.toLowerCase();
  const direct = book.byAddress[key];
  if (direct != null && Number.isFinite(direct) && direct > 0) return direct;
  if (BTC_LIKE.has(key) && book.btc != null && book.btc > 0) return book.btc;
  return null;
}

export function withPrices(book: PriceBook, extra: Record<string, number>): PriceBook {
  if (Object.keys(extra).length === 0) return book;
  return { btc: book.btc, byAddress: { ...book.byAddress, ...extra } };
}

/** USD value of a raw token amount. Null when the price is missing. */
export function amountUsd(amount: bigint, decimals: number, price: number | null): number | null {
  if (amount === 0n) return 0;
  if (price == null || !(price > 0) || !Number.isFinite(price)) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const negative = amount < 0n;
  const value = negative ? -amount : amount;
  const scaled = value * 1_000_000n / 10n ** BigInt(decimals);
  // Smaller than the 6-decimal scale. formatUsd shows this as under a hundredth of a cent.
  if (scaled === 0n) return negative ? -1e-12 : 1e-12;
  const units = Number(scaled) / 1e6;
  if (!Number.isFinite(units)) return null;
  const usd = units * price;
  if (!Number.isFinite(usd)) return null;
  return negative ? -usd : usd;
}

export type ValuedHolding = {
  amount: bigint | null;
  decimals: number;
  /** "btc" for native bitcoin. Any other value is a token address. */
  token: string;
};

/**
 * Dollar value of every holding.
 * Null while a balance is still unknown, prices have not loaded, or a non-zero
 * holding has no price. A zero balance counts as $0 without a price, so one
 * missing quote cannot hide the rest of the wallet or invent a partial total.
 */
export function walletValueUsd(book: PriceBook | null, holdings: readonly ValuedHolding[]): number | null {
  if (holdings.some((holding) => holding.amount == null)) return null;
  let total = 0;
  for (const holding of holdings) {
    const amount = holding.amount;
    if (amount == null || amount === 0n) continue;
    if (book == null) return null;
    const price = holding.token === "btc" ? btcPrice(book) : tokenPrice(book, holding.token);
    const usd = amountUsd(amount, holding.decimals, price);
    if (usd == null) return null;
    total += usd;
  }
  return Number.isFinite(total) ? total : null;
}

/** Wallet dollars as satoshis at the mempool BTC price. Zero stays zero with no price. */
export function usdToSats(usd: number, btcUsd: number | null): bigint | null {
  if (usd === 0) return 0n;
  if (btcUsd == null || !(btcUsd > 0) || !Number.isFinite(usd)) return null;
  const sats = Math.round((usd / btcUsd) * 1e8);
  if (!Number.isSafeInteger(sats)) return null;
  return BigInt(sats);
}

function btcPrice(book: PriceBook): number | null {
  return book.btc != null && book.btc > 0 ? book.btc : null;
}

/** Caption under a balance. Null while the first price book is still loading. */
export function holdingUsd(
  book: PriceBook | null,
  amount: bigint | null,
  decimals: number,
  token: string,
): string | null {
  if (amount == null) return null;
  if (amount === 0n) return `≈ ${formatUsd(0)}`;
  if (book == null) return null;
  const price = token === "btc"
    ? (book.btc != null && book.btc > 0 ? book.btc : null)
    : tokenPrice(book, token);
  const usd = amountUsd(amount, decimals, price);
  return usd == null ? "Price unavailable" : `≈ ${formatUsd(usd)}`;
}

/** Dollar line for each non-zero leg, plus a total when every leg has a price. */
export function legsUsd(book: PriceBook | null, legs: readonly UsdLeg[]): string | null {
  const live = legs.filter((leg) => leg.amount > 0n);
  if (live.length === 0 || book == null) return null;
  const bits: string[] = [];
  let total = 0;
  let priced = 0;
  for (const leg of live) {
    const usd = amountUsd(leg.amount, leg.decimals, tokenPrice(book, leg.address));
    if (usd == null) {
      bits.push(`${leg.label} price unavailable`);
      continue;
    }
    bits.push(`${leg.label} ≈ ${formatUsd(usd)}`);
    total += usd;
    priced += 1;
  }
  if (live.length > 1 && priced === live.length) bits.push(`Total ≈ ${formatUsd(total)}`);
  return bits.join(" · ");
}

function readPrices(body: unknown): Record<string, number> {
  const prices = (body as { data?: { attributes?: { token_prices?: Record<string, string> } } }).data?.attributes?.token_prices;
  const out: Record<string, number> = {};
  if (!prices) return out;
  for (const [addr, text] of Object.entries(prices)) {
    const price = Number(text);
    if (/^0x[0-9a-f]{40}$/.test(addr.toLowerCase()) && Number.isFinite(price) && price > 0) {
      out[addr.toLowerCase()] = price;
    }
  }
  return out;
}
