/**
 * Derive a chain key, sign once, and wipe the derived bytes.
 * The caller passes the phrase. This module does not keep it.
 * JavaScript strings cannot be wiped, so the phrase stays with the caller.
 */
import { HDKey, HARDENED_OFFSET } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { NETWORK, Transaction, p2wpkh } from "@scure/btc-signer";
import { HDNodeWallet, Transaction as EvmTx } from "ethers";
import { BTC_PATH, HEMI_PATH } from "../chain.ts";

export type ChainPublic = {
  btcAddress: string;
  btcPublicKey: Uint8Array;
  hemiAddress: string;
};

function wipe(bytes: Uint8Array | undefined): void {
  bytes?.fill(0);
}

function normalize(phrase: string): string {
  const mnemonic = phrase.trim().toLowerCase().replace(/\s+/g, " ");
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error("That recovery phrase is not a valid 12 or 24 word BIP39 phrase.");
  }
  return mnemonic;
}

/** Walk the path so every parent key can be wiped, not only the final child. */
function deriveBtc(mnemonic: string): { privateKey: Uint8Array; publicKey: Uint8Array; address: string } {
  const seed = mnemonicToSeedSync(mnemonic);
  const held: HDKey[] = [];
  try {
    let node = HDKey.fromMasterSeed(seed);
    held.push(node);
    for (const part of BTC_PATH.slice(2).split("/")) {
      const hardened = part.endsWith("'");
      const index = Number(hardened ? part.slice(0, -1) : part);
      node = node.deriveChild(index + (hardened ? HARDENED_OFFSET : 0));
      held.push(node);
    }
    if (!node.privateKey || !node.publicKey) throw new Error("Could not derive the Bitcoin key.");
    const payment = p2wpkh(node.publicKey, NETWORK);
    if (!payment.address) throw new Error("Could not encode the Bitcoin address.");
    return {
      privateKey: Uint8Array.from(node.privateKey),
      publicKey: Uint8Array.from(node.publicKey),
      address: payment.address,
    };
  } finally {
    for (const node of held) node.wipePrivateData();
    wipe(seed);
  }
}

/** Public Bitcoin and Hemi data. Derived private keys are wiped before return. */
export function publicChains(phrase: string): ChainPublic {
  const mnemonic = normalize(phrase);
  const btc = deriveBtc(mnemonic);
  try {
    const hemi = HDNodeWallet.fromPhrase(mnemonic, undefined, HEMI_PATH);
    return {
      btcAddress: btc.address,
      btcPublicKey: btc.publicKey,
      hemiAddress: hemi.address,
    };
  } finally {
    wipe(btc.privateKey);
  }
}

/** EIP-155 signature for an unsigned transaction. The chain id is already in the transaction. */
export function signEvmPhrase(phrase: string, unsignedSerialized: string): string {
  const wallet = HDNodeWallet.fromPhrase(normalize(phrase), undefined, HEMI_PATH);
  const tx = EvmTx.from(unsignedSerialized);
  tx.signature = wallet.signingKey.sign(tx.unsignedHash);
  const signature = tx.signature?.serialized;
  if (!signature) throw new Error("Could not sign the transaction.");
  return signature;
}

/** Sign a native-segwit PSBT from planBtcPsbt and wipe the Bitcoin key. */
export function signBitcoinPhrase(phrase: string, psbt: Uint8Array): { hex: string; txid: string } {
  const keys = deriveBtc(normalize(phrase));
  try {
    const tx = Transaction.fromPSBT(psbt, { allowUnknownOutputs: true });
    tx.sign(keys.privateKey);
    tx.finalize();
    return { hex: tx.hex, txid: tx.id };
  } finally {
    wipe(keys.privateKey);
  }
}
