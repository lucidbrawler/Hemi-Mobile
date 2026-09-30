import { hex } from "@scure/base";
import { assertMnemonic, deriveWallet } from "../src/lib/wallet.ts";
import { buildSignedTx, memoScriptHex, tunnelMemo } from "../src/lib/btc.ts";
import { btcToSats, satsToBtc } from "../src/lib/format.ts";

const phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
assertMnemonic(phrase);
const wallet = deriveWallet(phrase);

const expectedBtc = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const expectedHemi = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";

if (wallet.btcAddress !== expectedBtc) {
  throw new Error(`BTC address ${wallet.btcAddress} !== ${expectedBtc}`);
}
if (wallet.hemiAddress !== expectedHemi) {
  throw new Error(`Hemi address ${wallet.hemiAddress} !== ${expectedHemi}`);
}

const memo = tunnelMemo(expectedHemi);
if (memo.length !== 40) throw new Error(`memo length ${memo.length}`);
const ascii = new TextDecoder().decode(memo);
if (ascii !== expectedHemi.slice(2).toUpperCase()) throw new Error(`memo ${ascii}`);

const script = memoScriptHex(expectedHemi);
if (!script.startsWith("6a28")) throw new Error(`op_return ${script}`);
const pushed = hex.decode(script).slice(2);
if (new TextDecoder().decode(pushed) !== ascii) throw new Error("push mismatch");

if (btcToSats("0.0001") !== 10000n) throw new Error("sats parse");
if (satsToBtc(10000n) !== "0.0001") throw new Error("sats format");
if (btcToSats("0.000100001") !== null) throw new Error("too many decimals should fail");

const built = buildSignedTx({
  publicKey: wallet.btcPublicKey,
  privateKey: wallet.btcPrivateKey,
  utxos: [{ txid: "11".repeat(32), vout: 0, value: 250_000 }],
  payTo: { address: "1QDhzsteETKuw1M5kWHEjzaAmHSGhpH8zr", amount: 100_000n },
  memo: tunnelMemo(wallet.hemiAddress),
  changeAddress: wallet.btcAddress,
  feeRate: 2,
});
const memoHex = memoScriptHex(wallet.hemiAddress);
if (!built.hex.includes(memoHex)) throw new Error("signed deposit is missing the OP_RETURN memo");
if (!/^[0-9a-f]{64}$/.test(built.txid)) throw new Error(`bad txid ${built.txid}`);
if (built.outputIndex !== 0) throw new Error("vault payment should be vout 0");

console.log("selfcheck ok");
console.log(wallet.btcAddress);
console.log(wallet.hemiAddress);
console.log(script.slice(0, 12), ascii);
