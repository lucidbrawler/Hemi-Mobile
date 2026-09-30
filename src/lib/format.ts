const BTC = 100_000_000n;

export function satsToBtc(sats: bigint): string {
  const neg = sats < 0n;
  const v = neg ? -sats : sats;
  const whole = v / BTC;
  const frac = (v % BTC).toString().padStart(8, "0").replace(/0+$/, "");
  const body = frac ? `${whole}.${frac}` : whole.toString();
  return neg ? `-${body}` : body;
}

export function btcToSats(input: string): bigint | null {
  const text = input.trim();
  if (!/^\d+(\.\d{0,8})?$/.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  const sats = BigInt(whole) * BTC + BigInt(frac.padEnd(8, "0"));
  return sats;
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
