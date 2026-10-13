import type { DerivedWallet } from "./wallet";

/** Fields the screens can render. The phrase and private keys stay out of React state. */
export type PublicWallet = Pick<DerivedWallet, "btcAddress" | "hemiAddress">;

let session: DerivedWallet | null = null;

export function setSession(wallet: DerivedWallet): void {
  session = wallet;
}

export function clearSession(): void {
  session = null;
}

export function requireSession(): DerivedWallet {
  if (!session) throw new Error("Unlock the wallet first.");
  return session;
}

export function getSessionMnemonic(): string {
  const phrase = session?.mnemonic;
  if (!phrase) throw new Error("Unlock the wallet first.");
  return phrase;
}

export function publicWallet(wallet: DerivedWallet): PublicWallet {
  return { btcAddress: wallet.btcAddress, hemiAddress: wallet.hemiAddress };
}
