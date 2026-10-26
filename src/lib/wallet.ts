import { generateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { publicChains } from "./phraseSign.ts";

/** Public data for a phrase the user is creating or importing. No private keys. */
export type DerivedWallet = {
  mnemonic: string;
  btcAddress: string;
  btcPublicKey: Uint8Array;
  hemiAddress: string;
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
  const pubs = publicChains(mnemonic);
  return {
    mnemonic,
    btcAddress: pubs.btcAddress,
    btcPublicKey: pubs.btcPublicKey,
    hemiAddress: pubs.hemiAddress,
  };
}
