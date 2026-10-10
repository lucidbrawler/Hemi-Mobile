export function formatUnits(amount: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const neg = amount < 0n;
  const v = neg ? -amount : amount;
  const whole = v / scale;
  const frac = (v % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  const body = frac ? `${whole}.${frac}` : whole.toString();
  return neg ? `-${body}` : body;
}

export function parseUnits(input: string, decimals: number): bigint | null {
  const text = input.trim();
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
  if (!new RegExp(`^\\d+(\\.\\d{0,${decimals}})?$`).test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

export function satsToBtc(sats: bigint): string {
  return formatUnits(sats, 8);
}

export function btcToSats(input: string): bigint | null {
  return parseUnits(input, 8);
}

export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return "—";
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: amount >= 1000 ? 0 : 2,
  });
}

export function shortAddr(value: string, head = 8, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Rough time remaining until `targetMs`. */
export function formatRemain(targetMs: number, now = Date.now()): string {
  const left = targetMs - now;
  if (left <= 15_000) return "Any moment";
  const minutes = Math.ceil(left / 60_000);
  if (minutes < 60) return minutes === 1 ? "About 1 minute" : `About ${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours < 48) {
    if (rem === 0) return hours === 1 ? "About 1 hour" : `About ${hours} hours`;
    return `About ${hours}h ${rem}m`;
  }
  const days = Math.round(hours / 24);
  return days === 1 ? "About 1 day" : `About ${days} days`;
}
