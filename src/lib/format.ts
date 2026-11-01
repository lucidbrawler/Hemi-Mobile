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

/**
 * Amount for a balance row. Thousands are grouped, and a long fraction is shortened.
 * Amounts under 1 keep the first significant digits, so 0.003509 stays 0.003509.
 * Send and Max fields keep formatUnits, which is the exact value.
 */
export function formatAmount(amount: bigint, decimals: number): string {
  const neg = amount < 0n;
  const text = formatUnits(neg ? -amount : amount, decimals);
  const [whole, frac = ""] = text.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const shown = trimFraction(frac);
  const body = shown ? `${grouped}.${shown}` : grouped;
  return neg ? `-${body}` : body;
}

function trimFraction(frac: string): string {
  if (!frac) return "";
  if (frac.length <= 6) return frac;
  const head = frac.slice(0, 6).replace(/0+$/, "");
  if (head) return head;
  const sig = frac.search(/[1-9]/);
  if (sig < 0) return "";
  return frac.slice(0, sig + 4).replace(/0+$/, "");
}

/** Visual grouping for a copied address. The clipboard still gets the raw value. */
export function groupAddress(value: string): string {
  if (value.startsWith("0x") && value.length > 2) {
    const chunks = value.slice(2).match(/.{1,4}/g) ?? [value.slice(2)];
    return `0x ${chunks.join(" ")}`;
  }
  const chunks = value.match(/.{1,4}/g);
  return chunks ? chunks.join(" ") : value;
}

export function btcToSats(input: string): bigint | null {
  return parseUnits(input, 8);
}

export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return "—";
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  // Dust below the 6-decimal scale. A rounded $0.0035 reads as a shifted point.
  if (abs > 0 && abs < 0.0000005) return `${sign}<$0.000001`;
  if (abs < 0.1) {
    const text = abs.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    const [whole, frac = ""] = text.split(".");
    const shown = frac.length < 2 ? frac.padEnd(2, "0") : frac;
    return `${sign}$${whole}.${shown}`;
  }
  const digits = abs >= 1000 ? 0 : 2;
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
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

/** Coarse countdown for a veHEMI unlock. Short waits use the same words as formatRemain. */
export function formatLockRemain(endSec: number, now = Date.now()): string {
  const left = endSec * 1000 - now;
  if (left <= 0) return "Unlocked";
  if (left < 48 * 60 * 60 * 1000) return formatRemain(endSec * 1000, now);
  const days = Math.round(left / 86_400_000);
  if (days < 60) return days === 1 ? "About 1 day" : `About ${days} days`;
  const months = Math.round(days / 30.44);
  if (months < 24) return months === 1 ? "About 1 month" : `About ${months} months`;
  const years = Math.max(1, Math.round(months / 12));
  return years === 1 ? "About 1 year" : `About ${years} years`;
}
