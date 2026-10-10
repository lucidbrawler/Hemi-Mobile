import { geckoJson } from "./gecko";

export type PriceCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const cache = new Map<string, PriceCandle[]>();
const pending = new Map<string, Promise<PriceCandle[] | null>>();

/**
 * Recent pool prices as token1 per token0, the same direction as the range prices.
 * GeckoTerminal's candle is the base token priced in the quote token, so a reversed
 * pair is inverted. A missing feed returns null and the range levels still draw.
 */
const THIN_SERIES = 8;

export function loadPoolPriceSeries(pool: string, token0: string, token1: string): Promise<PriceCandle[] | null> {
  const key = `${pool.toLowerCase()}|${token0.toLowerCase()}|${token1.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const existing = pending.get(key);
  if (existing) return existing;
  const promise = readPoolSeries(key, pool, token0, token1).finally(() => {
    if (pending.get(key) === promise) pending.delete(key);
  });
  pending.set(key, promise);
  return promise;
}

async function readPoolSeries(
  key: string,
  pool: string,
  token0: string,
  token1: string,
): Promise<PriceCandle[] | null> {
  try {
    const hour = await readSeries(pool, token0, token1, "hour", 72);
    // A pool that barely trades has two hourly bars. Daily history is the longer picture.
    // A failed hour request is left alone. Another call would hit the same limit.
    let candles = hour;
    if (hour && hour.length < THIN_SERIES) {
      const day = await readSeries(pool, token0, token1, "day", 90);
      if (day && day.length > hour.length) candles = day;
    }
    if (candles) cache.set(key, candles);
    return candles;
  } catch {
    return null;
  }
}

async function readSeries(
  pool: string,
  token0: string,
  token1: string,
  frame: "hour" | "day",
  limit: number,
): Promise<PriceCandle[] | null> {
  const url = `https://api.geckoterminal.com/api/v2/networks/hemi/pools/${pool.toLowerCase()}/ohlcv/${frame}?aggregate=1&limit=${limit}&currency=token`;
  const body = await geckoJson(url);
  return body ? candlesFromOhlcv(body, token0, token1) : null;
}

/** Maps a GeckoTerminal OHLCV body onto token1 per token0. Returns null when the pair does not match. */
export function candlesFromOhlcv(body: unknown, token0: string, token1: string): PriceCandle[] | null {
  if (!body || typeof body !== "object") return null;
  const root = body as {
    data?: { attributes?: { ohlcv_list?: unknown } };
    meta?: { base?: { address?: string }; quote?: { address?: string } };
  };
  const rows = root.data?.attributes?.ohlcv_list;
  const base = root.meta?.base?.address?.toLowerCase() ?? "";
  const quote = root.meta?.quote?.address?.toLowerCase() ?? "";
  const left = token0.toLowerCase();
  const right = token1.toLowerCase();
  if (!Array.isArray(rows) || !base || !quote) return null;
  const invert = base === right && quote === left;
  if (!invert && !(base === left && quote === right)) return null;
  const candles: PriceCandle[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const time = Math.floor(Number(row[0]));
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    const volume = Number(row[5]);
    if (!Number.isFinite(time) || !(open > 0) || !(high > 0) || !(low > 0) || !(close > 0) || high < low) continue;
    const toPrice = (value: number) => (invert ? 1 / value : value);
    const nextHigh = toPrice(invert ? low : high);
    const nextLow = toPrice(invert ? high : low);
    const next = {
      time,
      open: Math.min(nextHigh, Math.max(nextLow, toPrice(open))),
      high: nextHigh,
      low: nextLow,
      close: Math.min(nextHigh, Math.max(nextLow, toPrice(close))),
      volume: Number.isFinite(volume) && volume > 0 ? volume : 0,
    };
    if (next.low > 0 && next.high >= next.low && next.close > 0) candles.push(next);
  }
  return uniqueCandles(candles);
}

/** Gecko repeats an hour. The chart rejects a series that is not strictly ascending. */
function uniqueCandles(candles: PriceCandle[]): PriceCandle[] | null {
  const sorted = candles.slice().sort((a, b) => a.time - b.time);
  const unique: PriceCandle[] = [];
  for (const candle of sorted) {
    const previous = unique.at(-1);
    if (previous && previous.time >= candle.time) continue;
    unique.push(candle);
  }
  return unique.length >= 2 ? unique : null;
}
