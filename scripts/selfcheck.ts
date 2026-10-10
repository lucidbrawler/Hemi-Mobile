import { hex } from "@scure/base";
import { ZeroHash } from "ethers";
import { assertMnemonic, deriveWallet } from "../src/lib/wallet.ts";
import { buildSignedTx, memoScriptHex, tunnelMemo } from "../src/lib/btc.ts";
import { hashOutputRootProof, hashWithdrawal, withdrawalStorageKey } from "../src/lib/ethBridge.ts";
import { btcToSats, satsToBtc } from "../src/lib/format.ts";
import { isPopPublication } from "../src/lib/pop.ts";

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

const popScript = "6a4c50" + "48454d49" + "11".repeat(40);
if (!isPopPublication(popScript)) throw new Error("HEMI OP_RETURN should count as a PoP publication");
if (isPopPublication(script)) throw new Error("tunnel memo must not count as a PoP publication");
if (isPopPublication("0014" + "ab".repeat(20))) throw new Error("witness output is not a PoP publication");

const outputRoot = hashOutputRootProof({
  version: ZeroHash,
  stateRoot: "0xaed9d5353882013dabedfe609c227aa46161dd0a26696d062d667ca0e02936e8",
  messagePasserStorageRoot: "0x83f8c9186ae518ff8dbc6ad26642075972a16c0e70a31bfca01402d42e9746b7",
  latestBlockhash: "0x4d95be6a78e9a210386c967d0b884cbbdbd265bc47d0ec8390cc93e3e6d96122",
});
if (outputRoot !== "0x364791d49846d7036a60fe2a7d0d23e6a71c482b993c8b3d72c0a24f3bdfff77") {
  throw new Error(`output root ${outputRoot}`);
}

const liveWithdrawal = "0xd64438c82353de6ff70d60596e88cbedaf474e383361f5df44ff2fed9890ce41";
const storageKey = withdrawalStorageKey(liveWithdrawal);
if (storageKey !== "0x1ecc66a547f3442ed1f40b6ec6d18bb758d24d10ef9ce3948bac968f3327ae34") {
  throw new Error(`withdrawal slot ${storageKey}`);
}

const synthetic = hashWithdrawal({
  nonce: 1n,
  sender: "0x4200000000000000000000000000000000000007",
  target: "0xF005dFb08377faD44588Af68d0884D272A6fb050",
  value: 5n,
  gasLimit: 200_000n,
  data: "0x",
});
if (synthetic !== "0xd962f497c020341649c558310c90fd4858ff96f37c1d0b43f709acde38dd96dd") {
  throw new Error(`withdrawal hash ${synthetic}`);
}

console.log("selfcheck ok");
console.log(wallet.btcAddress);
console.log(wallet.hemiAddress);
console.log(script.slice(0, 12), ascii);
