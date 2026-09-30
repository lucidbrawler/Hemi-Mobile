import { HDKey } from "@scure/bip32";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { p2wpkh } from "@scure/btc-signer";
import { NETWORK } from "@scure/btc-signer";
import { HDNodeWallet } from "ethers";
import { BTC_PATH, HEMI_PATH } from "../chain.ts";

export type DerivedWallet = {
  mnemonic: string;
  btcAddress: string;
  btcPublicKey: Uint8Array;
  btcPrivateKey: Uint8Array;
  hemiAddress: string;
  hemiPrivateKey: string;
};

export function createMnemonic(): string {
  return generateMnemonic(wordlist, 128);
}

export function assertMnemonic(phrase: string): string {
  const mnemonic = phrase.trim().toLowerCase().replace(/\s+/g, " ");
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error("That recovery phrase is not a valid 12 or 24 word BIP39 phrase.");
  }
  return mnemonic;
}

export function deriveWallet(phrase: string): DerivedWallet {
  const mnemonic = assertMnemonic(phrase);
  const seed = mnemonicToSeedSync(mnemonic);
  const btc = HDKey.fromMasterSeed(seed).derive(BTC_PATH);
  if (!btc.privateKey || !btc.publicKey) throw new Error("Could not derive the Bitcoin key.");
  const payment = p2wpkh(btc.publicKey, NETWORK);
  if (!payment.address) throw new Error("Could not encode the Bitcoin address.");

  const hemi = HDNodeWallet.fromPhrase(mnemonic, undefined, HEMI_PATH);
  return {
    mnemonic,
    btcAddress: payment.address,
    btcPublicKey: btc.publicKey,
    btcPrivateKey: btc.privateKey,
    hemiAddress: hemi.address,
    hemiPrivateKey: hemi.privateKey,
  };
}
