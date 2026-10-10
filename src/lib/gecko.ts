/**
 * GeckoTerminal JSON.
 * The public API allows about 10 calls a minute, and a 429 leaves out
 * Access-Control-Allow-Origin, so the browser rejects it instead of exposing
 * the status. Calls are spaced, a hidden rejection sets a short cooldown, and
 * a success is reused for a minute. The same URL shares one in-flight request.
 */

const MIN_GAP = 700;
const COOL_MS = 8_000;
const FRESH_MS = 60_000;

let nextSlot = 0;
let coolUntil = 0;

const fresh = new Map<string, { at: number; body: unknown }>();
const inflight = new Map<string, Promise<unknown | null>>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reserve(): Promise<void> {
  const now = Date.now();
  const start = Math.max(now, nextSlot, coolUntil);
  nextSlot = start + MIN_GAP;
  return delay(start - now);
}

export function geckoJson(url: string): Promise<unknown | null> {
  const saved = fresh.get(url);
  if (saved && Date.now() - saved.at < FRESH_MS) return Promise.resolve(saved.body);
  const existing = inflight.get(url);
  if (existing) return existing;
  const promise = readJson(url).finally(() => {
    if (inflight.get(url) === promise) inflight.delete(url);
  });
  inflight.set(url, promise);
  return promise;
}

async function readJson(url: string): Promise<unknown | null> {
  await reserve();
  try {
    const response = await fetch(url);
    if (response.ok) {
      coolUntil = 0;
      const body: unknown = await response.json();
      fresh.set(url, { at: Date.now(), body });
      return body;
    }
    if (response.status !== 429 && response.status < 500) return null;
  } catch {
    // A rate-limit response from this host has no CORS header.
  }
  coolUntil = Math.max(coolUntil, Date.now() + COOL_MS);
  return null;
}
