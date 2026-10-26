import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { hex } from "@scure/base";
import { HDNodeWallet, Transaction, ZeroHash } from "ethers";
import { BTC_PATH, HEMI_CHAIN_ID, HEMI_PATH } from "../src/chain.ts";
import { passwordMeetsBar } from "../src/lib/password.ts";
import { assertMnemonic, deriveWallet } from "../src/lib/wallet.ts";
import { memoScriptHex, planBtcPsbt, tunnelMemo } from "../src/lib/btc.ts";
import { signBitcoinPhrase, signEvmPhrase } from "../src/lib/phraseSign.ts";
import { clearSession, exportPhrase, getSessionMnemonic, setSession, signBitcoin } from "../src/lib/sessionVault.ts";
import { hashOutputRootProof, hashWithdrawal, withdrawalStorageKey } from "../src/lib/ethBridge.ts";
import { btcToSats, satsToBtc } from "../src/lib/format.ts";
import { isPopPublication } from "../src/lib/pop.ts";
import { merklClaimable, merklPayoutCoversMore, merklPayoutLine, readMerklWallet } from "../src/lib/merklParse.ts";

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
if (!passwordMeetsBar("Abcdefg1")) throw new Error("8 characters with upper, lower, and a digit should pass");
if (passwordMeetsBar("Abcdefgh")) throw new Error("a password missing a number and a symbol should fail");
if (passwordMeetsBar("abcdefgh")) throw new Error("a lowercase password should fail");

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

const seed = mnemonicToSeedSync(phrase);
const node = HDKey.fromMasterSeed(seed).derive(BTC_PATH);
if (!node.privateKey) throw new Error("missing bitcoin key");
let btcSecret = "";
for (const byte of node.privateKey) btcSecret += byte.toString(16).padStart(2, "0");
node.privateKey.fill(0);
seed.fill(0);

const planned = planBtcPsbt({
  publicKey: wallet.btcPublicKey,
  utxos: [{ txid: "11".repeat(32), vout: 0, value: 250_000 }],
  payTo: { address: "1QDhzsteETKuw1M5kWHEjzaAmHSGhpH8zr", amount: 100_000n },
  memo: tunnelMemo(wallet.hemiAddress),
  changeAddress: wallet.btcAddress,
  feeRate: 2,
});
const signed = signBitcoinPhrase(phrase, planned.psbt);
const memoHex = memoScriptHex(wallet.hemiAddress);
if (!signed.hex.includes(memoHex)) throw new Error("signed deposit is missing the OP_RETURN memo");
if (!/^[0-9a-f]{64}$/.test(signed.txid)) throw new Error(`bad txid ${signed.txid}`);
if (signed.hex.toLowerCase().includes(btcSecret)) throw new Error("signed bitcoin transaction contains the private key");

const ethWallet = HDNodeWallet.fromPhrase(phrase, undefined, HEMI_PATH);
const ethSecret = ethWallet.privateKey.replace(/^0x/i, "").toLowerCase();
const unsigned = Transaction.from({
  type: 2,
  chainId: HEMI_CHAIN_ID,
  nonce: 3,
  maxFeePerGas: 20n,
  maxPriorityFeePerGas: 1n,
  gasLimit: 21_000n,
  to: "0x0000000000000000000000000000000000000001",
  value: 5n,
});
unsigned.signature = signEvmPhrase(phrase, unsigned.unsignedSerialized);
if (unsigned.from !== expectedHemi) throw new Error(`recovered signer ${unsigned.from}`);
if (unsigned.serialized.toLowerCase().includes(ethSecret)) throw new Error("signed ethereum transaction contains the private key");

setSession(phrase);
if (getSessionMnemonic() !== "") throw new Error("the session handed the phrase to a caller");
if (exportPhrase() !== phrase) throw new Error("reveal did not return the saved phrase");
const viaSession = signBitcoin(planned.psbt);
if (viaSession.txid !== signed.txid) throw new Error("session signer disagreed with the phrase signer");
if (viaSession.hex.toLowerCase().includes(btcSecret)) throw new Error("session signature contains the private key");
clearSession();
let locked = false;
try {
  exportPhrase();
} catch {
  locked = true;
}
if (!locked) throw new Error("a locked wallet still exported the phrase");
if (getSessionMnemonic() !== "") throw new Error("a locked wallet leaked the phrase");

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

const pool = "0x7e8b925b43dbb364def5e44e93e9f8fbc02cfc21";
const usdc = "0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA";
const proof = `0x${"ab".repeat(32)}`;
const merkl = readMerklWallet(
  [{
    status: "LIVE",
    apr: 171.05,
    earliestCampaignEnd: 1_790_000_000,
    explorerAddress: pool,
    rewardsRecord: { breakdowns: [{ token: { symbol: "USDC.e" } }] },
  }, {
    status: "LIVE",
    apr: 10,
    identifier: "not-a-pool",
  }],
  {
    opportunities: [
      {
        opportunity: { explorerAddress: pool, status: "LIVE", apr: 171.05 },
        tokens: [{
          token: { address: usdc, symbol: "USDC.e", decimals: 6 },
          claimable: "5000000",
          pending: "1000",
        }],
      },
      {
        opportunity: { explorerAddress: "0x6153ef0abfe8fa881a2492743dfc34ec594868d1", status: "PAST" },
        tokens: [{
          token: { address: usdc, symbol: "USDC.e", decimals: 6 },
          claimable: "3000000",
          pending: "0",
        }],
      },
    ],
  },
  [{
    rewards: [{
      token: { address: usdc, symbol: "USDC.e", decimals: 6 },
      amount: "10000000",
      claimed: "2000000",
      pending: "1000",
      proofs: [proof],
    }],
  }],
);
const hemiVetro = merkl.byPool.get(pool);
if (!hemiVetro || hemiVetro.apr !== 171.05) throw new Error("merkl apr missing");
if (hemiVetro.tokens[0]?.claimable !== 5_000_000n) throw new Error("merkl pool slice");
if (hemiVetro.tokens[0]?.pending !== 1000n) throw new Error("merkl pending");
if (merkl.byPool.has("not-a-pool")) throw new Error("merkl kept a non-address");
const other = merkl.byPool.get("0x6153ef0abfe8fa881a2492743dfc34ec594868d1");
if (!other || other.apr != null) throw new Error("ended campaign should keep the amount without an APR");
if (!merkl.rewardsReady) throw new Error("merkl feeds were ready");
const paying = merklClaimable(hemiVetro, merkl.claims);
if (paying.length !== 1 || paying[0]?.amount !== 10_000_000n) throw new Error("claim passes the cumulative amount");
if (merklPayoutLine(hemiVetro, merkl.claims) !== "8 USDC.e") throw new Error("payout is the whole token");
if (!merklPayoutCoversMore(hemiVetro, merkl.claims)) throw new Error("payout should include the other pool");

const settled = readMerklWallet(null, {
  opportunities: [{
    opportunity: { explorerAddress: pool },
    tokens: [{
      token: { address: usdc, symbol: "USDC.e", decimals: 6 },
      claimable: "5000000",
      pending: "0",
    }],
  }],
}, [{
  rewards: [{
    token: { address: usdc, symbol: "USDC.e", decimals: 6 },
    amount: "5000000",
    claimed: "5000000",
    pending: "0",
    proofs: [],
  }],
}]);
const afterClaim = settled.byPool.get(pool);
if (afterClaim) throw new Error("a fully claimed pool with no campaign should drop off the card");
if (settled.claims[0]?.proofs?.length !== 0) throw new Error("an empty proof list is valid");

const broken = readMerklWallet(null, null, null);
if (broken.rewardsReady || broken.byPool.size !== 0) throw new Error("missing merkl feeds");

console.log("selfcheck ok");
console.log(wallet.btcAddress);
console.log(wallet.hemiAddress);
console.log(script.slice(0, 12), ascii);
