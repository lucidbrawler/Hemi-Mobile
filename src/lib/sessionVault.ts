import { publicChains, signBitcoinPhrase, signEvmPhrase, type ChainPublic } from "./phraseSign.ts";
import { assertMnemonic } from "./wallet.ts";

/** Fields the screens can render. The phrase stays in this module. */
export type PublicWallet = {
  btcAddress: string;
  hemiAddress: string;
};

/**
 * The only holder of the recovery phrase while the wallet is unlocked.
 * Screens and chain code ask for a public address or a signature.
 * The phrase leaves only through exportPhrase, which the reveal screen
 * and the passkey or password re-save ask for.
 */
type Secret = ChainPublic & { mnemonic: string };

let secret: Secret | null = null;

export function setSession(phrase: string): PublicWallet {
  const mnemonic = assertMnemonic(phrase);
  const pubs = publicChains(mnemonic);
  if (secret?.btcPublicKey) secret.btcPublicKey.fill(0);
  secret = { mnemonic, ...pubs };
  return { btcAddress: pubs.btcAddress, hemiAddress: pubs.hemiAddress };
}

export function clearSession(): void {
  if (secret) {
    secret.mnemonic = "";
    secret.btcPublicKey.fill(0);
  }
  secret = null;
}

/** Explicit reveal or re-save. This is the only way to read the phrase back. */
export function exportPhrase(): string {
  const phrase = secret?.mnemonic;
  if (!phrase) throw new Error("Unlock the wallet first.");
  return phrase;
}

/** Always empty. Chain code asks the signer instead of reading the phrase. */
export function getSessionMnemonic(): string {
  return "";
}

export function requirePublic(): ChainPublic {
  if (!secret?.mnemonic) throw new Error("Unlock the wallet first.");
  return {
    btcAddress: secret.btcAddress,
    btcPublicKey: secret.btcPublicKey,
    hemiAddress: secret.hemiAddress,
  };
}

export function signEvm(unsignedSerialized: string): string {
  if (!secret?.mnemonic) throw new Error("Unlock the wallet first.");
  const signature = signEvmPhrase(secret.mnemonic, unsignedSerialized);
  if (!signature) throw new Error("Could not sign the transaction.");
  return signature;
}

export function signBitcoin(psbt: Uint8Array): { hex: string; txid: string } {
  if (!secret?.mnemonic) throw new Error("Unlock the wallet first.");
  if (psbt.length === 0) throw new Error("Bad Bitcoin transaction.");
  const signed = signBitcoinPhrase(secret.mnemonic, psbt);
  if (!signed.hex || !/^[0-9a-f]{64}$/i.test(signed.txid)) {
    throw new Error("Could not sign the Bitcoin transaction.");
  }
  return signed;
}
