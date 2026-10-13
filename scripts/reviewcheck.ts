import { webcrypto } from "node:crypto";
import { estimateSpend } from "../src/lib/btc.ts";
import { requireEthAddress } from "../src/lib/ethBridge.ts";
import { IDLE_LOCK_MS, shouldAutoLock } from "../src/lib/lockPolicy.ts";
import { assertNativePassword, passwordMeetsBar } from "../src/lib/password.ts";
import { amountsForLiquidity, bandRange, depositSides, fullRange, quoteWithdraw, sqrtPriceAtTick } from "../src/lib/pool.ts";
import { stakeExtensions, stakeUnlockAt, stakeWeight } from "../src/lib/stake.ts";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

class MemoryStorage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  key(index: number) { return [...this.map.keys()][index] ?? null; }
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null; }
  setItem(key: string, value: string) { this.map.set(key, String(value)); }
  removeItem(key: string) { this.map.delete(key); }
  clear() { this.map.clear(); }
}

Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });

const phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const password = "Abcdefg1";

function fail(message: string): never {
  throw new Error(message);
}

if (IDLE_LOCK_MS !== 5 * 60 * 1000) fail("idle lock should be 5 minutes");
if (!shouldAutoLock({ visibility: "hidden", idleMs: 0 })) fail("leaving the app should lock");
if (shouldAutoLock({ visibility: "visible", idleMs: IDLE_LOCK_MS - 1 })) fail("the wallet should stay open before 5 minutes");
if (!shouldAutoLock({ visibility: "visible", idleMs: IDLE_LOCK_MS })) fail("5 minutes idle should lock");

if (!passwordMeetsBar(password)) fail("phone password bar rejected a Good password");
let weak = false;
try { assertNativePassword("abcdefgh"); } catch { weak = true; }
if (!weak) fail("a lowercase password should fail the phone bar");

const storage = await import("../src/lib/storage.ts");

const imported = storage.planSecretImport(
  new Set([storage.LEGACY_KEY]),
  [
    { key: storage.LEGACY_KEY, value: "already" },
    { key: "hemi-btc-wallet-v1:Main", value: "blob" },
    { key: "hemi-btc-tunnel-history-v1", value: "not-a-secret" },
    { key: "hemi-btc-wallet-names-v1", value: null },
  ],
);
if (imported.length !== 1 || imported[0].key !== "hemi-btc-wallet-v1:Main" || imported[0].value !== "blob") {
  fail(`secret import plan ${JSON.stringify(imported)}`);
}

const fresh = storage.planLegacyMigration(
  () => false,
  (key) => (key === storage.LEGACY_KEY ? "{\"v\":1}" : null),
);
if (!fresh.dropLegacy || fresh.mainValue !== "{\"v\":1}" || !fresh.namesJson?.includes("Main")) {
  fail(`legacy plan should create Main: ${JSON.stringify(fresh)}`);
}
const kept = storage.planLegacyMigration(
  (key) => key.endsWith("Main"),
  (key) => (key === storage.LEGACY_KEY ? "{\"v\":1}" : null),
);
if (!kept.dropLegacy || kept.mainValue != null) fail("an existing Main wallet should not be overwritten");

await storage.savePasswordOnly("Review", phrase, password, "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
if (await storage.loadByPassword("Review", password) !== phrase) fail("password unlock did not return the phrase");
let wrong = false;
try { await storage.loadByPassword("Review", "Abcdefg2"); } catch (err) {
  wrong = err instanceof Error && err.message === "Wrong password.";
}
if (!wrong) fail("a wrong password should be rejected");
const info = storage.inspectWallet("Review");
if (!info.hasPassword || info.hasPasskey || info.require2fa) fail(`unexpected auth ${JSON.stringify(info)}`);
let needsPasskey = false;
try { await storage.attachPassword2fa("Review", phrase, password); } catch (err) {
  needsPasskey = err instanceof Error && err.message === "Enable a passkey before turning on 2FA.";
}
if (!needsPasskey) fail("2FA should require a passkey first");
if (!storage.walletNameTaken("review")) fail("wallet names should match ignoring case");
await storage.forgetWallet("Review");
if (storage.walletNameTaken("Review") || storage.listWallets().length !== 0) fail("forget should remove the wallet");

const range = fullRange(60);
if (range.tickLower >= range.tickUpper || range.tickLower % 60 !== 0 || range.tickUpper % 60 !== 0) {
  fail(`full range ${range.tickLower}..${range.tickUpper}`);
}
const band = bandRange(0, 60, 10);
if (!(band.tickLower <= 0 && band.tickUpper > 0)) fail(`band should contain tick 0: ${band.tickLower}..${band.tickUpper}`);
const sqrt = sqrtPriceAtTick(0);
if (depositSides(sqrt, band) !== "both") fail("price inside the band should take both tokens");
const amounts = amountsForLiquidity(sqrt, band, 1_000_000n);
if (amounts.amount0 <= 0n || amounts.amount1 <= 0n) fail("liquidity inside the band should hold both tokens");
const half = quoteWithdraw(sqrt, band, 1_000_000n, 50);
if (half.liquidityOut !== 500_000n) fail(`50% withdraw removed ${half.liquidityOut}`);
let badShare = false;
try { quoteWithdraw(sqrt, band, 1_000_000n, 0); } catch { badShare = true; }
if (!badShare) fail("a zero share should be rejected");

const now = 1_700_000_000;
const unlock = stakeUnlockAt(now, 7 * 24 * 3600);
if (unlock <= now) fail("a stake unlock should land after now");
if (stakeWeight(0n, unlock, now) !== 0n) fail("an empty lock has no weight");
if (stakeWeight(1_000_000_000_000_000_000n, now, now) !== 0n) fail("an ended lock has no weight");
if (stakeWeight(1_000_000_000_000_000_000n, unlock, now) <= 0n) fail("a live lock should have weight");
if (stakeExtensions(now, now).length !== 0) fail("an ended lock has no extensions");
if (stakeExtensions(now, unlock).length === 0) fail("a short lock should offer more time");

const fee = estimateSpend([{ txid: "11".repeat(32), vout: 0, value: 100_000 }], 10_000n, 2, false);
if (fee <= 0n || fee >= 10_000n) fail(`spend fee ${fee}`);

const checksum = requireEthAddress("0x9858effd232b4033e47d90003d41ec34ecaeda94");
if (checksum !== "0x9858EfFD232B4033E47d90003D41EC34EcaEda94") fail(`checksum ${checksum}`);
let badAddress = false;
try { requireEthAddress("not-an-address"); } catch { badAddress = true; }
if (!badAddress) fail("a bad address should be rejected");

console.log("reviewcheck ok");
