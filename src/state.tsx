import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  fetchBtcBalance,
  fetchBtcPrice,
  fetchFeeRate,
  fetchUtxos,
  buildSignedTx,
  broadcastTx,
  tunnelMemo,
  assertBtcAddress,
} from "./lib/btc";
import {
  confirmHemiDeposit,
  readBtcConfirmations,
  quoteVaultFee,
  readHemiBalances,
  readVault,
  requireEvmAddress,
  sendHemiBtc,
  withdrawToBitcoin,
  type VaultQuote,
} from "./lib/hemi";
import {
  forgetVault,
  hasVault,
  loadMnemonic,
  markTunnel,
  pushTunnel,
  readTunnels,
  saveMnemonic,
  type TunnelRecord,
} from "./lib/storage";
import { createMnemonic, deriveWallet, type DerivedWallet } from "./lib/wallet";
import { messageOf } from "./lib/errors";

type Balances = {
  btcSats: bigint | null;
  hemiSats: bigint | null;
  ethWei: bigint | null;
  usd: number | null;
};

type WalletApi = {
  ready: boolean;
  saved: boolean;
  wallet: DerivedWallet | null;
  balances: Balances;
  vault: VaultQuote | null;
  tunnels: TunnelRecord[];
  refreshing: boolean;
  notice: string | null;
  error: string | null;
  clearFlash: () => void;
  create: (password: string) => Promise<string>;
  importPhrase: (phrase: string, password: string) => Promise<void>;
  unlock: (password: string) => Promise<void>;
  lock: () => void;
  wipe: () => void;
  refresh: () => Promise<void>;
  feeRate: () => Promise<number>;
  sendBitcoin: (to: string, amount: bigint) => Promise<string>;
  sendHemi: (to: string, amount: bigint) => Promise<string>;
  deposit: (hemiAddress: string, amount: bigint) => Promise<string>;
  withdraw: (btcAddress: string, amount: bigint) => Promise<string>;
  mintDeposit: (record: TunnelRecord) => Promise<void>;
  vaultFee: (kind: "deposit" | "withdraw", amount: bigint) => Promise<bigint>;
};

const Ctx = createContext<WalletApi | null>(null);

const emptyBalances: Balances = { btcSats: null, hemiSats: null, ethWei: null, usd: null };

export function WalletProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState(false);
  const [wallet, setWallet] = useState<DerivedWallet | null>(null);
  const [balances, setBalances] = useState<Balances>(emptyBalances);
  const [vault, setVault] = useState<VaultQuote | null>(null);
  const [tunnels, setTunnels] = useState<TunnelRecord[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSaved(hasVault());
    setTunnels(readTunnels());
    setReady(true);
  }, []);

  const refresh = useCallback(async () => {
    if (!wallet) return;
    setRefreshing(true);
    setError(null);
    try {
      const [btcSats, hemi, usd, nextVault] = await Promise.all([
        fetchBtcBalance(wallet.btcAddress),
        readHemiBalances(wallet.hemiAddress),
        fetchBtcPrice().catch(() => null),
        readVault().catch(() => null),
      ]);
      setBalances({ btcSats, hemiSats: hemi.hemiSats, ethWei: hemi.ethWei, usd });
      if (nextVault) setVault(nextVault);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setRefreshing(false);
    }
  }, [wallet]);

  useEffect(() => {
    if (!wallet) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [wallet, refresh]);

  const open = useCallback(async (mnemonic: string) => {
    setWallet(deriveWallet(mnemonic));
    setSaved(true);
    setNotice(null);
    setError(null);
  }, []);

  const api = useMemo<WalletApi>(() => {
    function requireWallet(): DerivedWallet {
      if (!wallet) throw new Error("Unlock the wallet first.");
      return wallet;
    }

    return {
      ready,
      saved,
      wallet,
      balances,
      vault,
      tunnels,
      refreshing,
      notice,
      error,
      clearFlash: () => {
        setNotice(null);
        setError(null);
      },
      async create(password: string) {
        const mnemonic = createMnemonic();
        await saveMnemonic(password, mnemonic);
        await open(mnemonic);
        return mnemonic;
      },
      async importPhrase(phrase: string, password: string) {
        const derived = deriveWallet(phrase);
        await saveMnemonic(password, derived.mnemonic);
        await open(derived.mnemonic);
      },
      async unlock(password: string) {
        const mnemonic = await loadMnemonic(password);
        await open(mnemonic);
      },
      lock() {
        setWallet(null);
        setBalances(emptyBalances);
      },
      wipe() {
        forgetVault();
        setWallet(null);
        setSaved(false);
        setBalances(emptyBalances);
        setNotice(null);
      },
      refresh,
      feeRate: fetchFeeRate,
      async sendBitcoin(to, amount) {
        const current = requireWallet();
        const dest = assertBtcAddress(to);
        const utxos = await fetchUtxos(current.btcAddress);
        const feeRate = await fetchFeeRate();
        const built = buildSignedTx({
          publicKey: current.btcPublicKey,
          privateKey: current.btcPrivateKey,
          utxos,
          payTo: { address: dest, amount },
          changeAddress: current.btcAddress,
          feeRate,
        });
        const txid = await broadcastTx(built.hex);
        setNotice(`Bitcoin sent. ${txid.slice(0, 10)}…`);
        await refresh();
        return txid;
      },
      async sendHemi(to, amount) {
        const current = requireWallet();
        const hash = await sendHemiBtc(current.hemiPrivateKey, to, amount);
        setNotice(`hemiBTC sent. ${hash.slice(0, 10)}…`);
        await refresh();
        return hash;
      },
      async deposit(hemiAddress, amount) {
        const current = requireWallet();
        const live = vault ?? (await readVault());
        if (!live.accepting) throw new Error("The Bitcoin vault is not accepting deposits.");
        if (amount < live.minDepositSats) {
          throw new Error(`Minimum deposit is ${live.minDepositSats.toString()} sats.`);
        }
        const dest = requireEvmAddress(hemiAddress);
        const fee = await quoteVaultFee(live.stateAddress, "deposit", amount);
        const utxos = await fetchUtxos(current.btcAddress);
        const feeRate = await fetchFeeRate();
        const built = buildSignedTx({
          publicKey: current.btcPublicKey,
          privateKey: current.btcPrivateKey,
          utxos,
          payTo: { address: live.custodyAddress, amount },
          memo: tunnelMemo(dest),
          changeAddress: current.btcAddress,
          feeRate,
        });
        const txid = await broadcastTx(built.hex);
        const net = amount > fee ? amount - fee : 0n;
        setTunnels(
          pushTunnel({
            id: txid,
            direction: "to-hemi",
            createdAt: Date.now(),
            grossSats: amount.toString(),
            vaultFeeSats: fee.toString(),
            netSats: net.toString(),
            btcAddress: current.btcAddress,
            hemiAddress: dest,
            txHash: txid,
            outputIndex: built.outputIndex,
            status: "broadcast",
          }),
        );
        setNotice("Deposit is on Bitcoin. hemiBTC mints after the vault sees enough confirmations.");
        await refresh();
        return txid;
      },
      async withdraw(btcAddress, amount) {
        const current = requireWallet();
        const live = vault ?? (await readVault());
        if (amount < live.minWithdrawSats) {
          throw new Error(`Minimum withdrawal is ${live.minWithdrawSats.toString()} sats.`);
        }
        const dest = assertBtcAddress(btcAddress);
        const fee = await quoteVaultFee(live.stateAddress, "withdraw", amount);
        const hash = await withdrawToBitcoin(current.hemiPrivateKey, dest, amount);
        const net = amount > fee ? amount - fee : 0n;
        setTunnels(
          pushTunnel({
            id: hash,
            direction: "to-bitcoin",
            createdAt: Date.now(),
            grossSats: amount.toString(),
            vaultFeeSats: fee.toString(),
            netSats: net.toString(),
            btcAddress: dest,
            hemiAddress: current.hemiAddress,
            txHash: hash,
            status: "broadcast",
          }),
        );
        setNotice("Withdrawal submitted on Hemi. Bitcoin pays out after the vault finalizes it.");
        await refresh();
        return hash;
      },
      async mintDeposit(record) {
        const current = requireWallet();
        if (record.outputIndex == null) throw new Error("This deposit has no output index.");
        const confs = await readBtcConfirmations(record.txHash);
        const need = vault?.confirmations ?? 4;
        if (confs < need) {
          throw new Error(`${confs} of ${need} Bitcoin confirmations so far.`);
        }
        await confirmHemiDeposit(current.hemiPrivateKey, record.txHash, record.outputIndex);
        setTunnels(markTunnel(record.id, "minted"));
        setNotice("Mint submitted. hemiBTC shows up after the Hemi transaction confirms.");
        await refresh();
      },
      async vaultFee(kind, amount) {
        const live = vault ?? (await readVault());
        setVault(live);
        return quoteVaultFee(live.stateAddress, kind, amount);
      },
    };
  }, [ready, saved, wallet, balances, vault, tunnels, refreshing, notice, error, open, refresh]);

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletApi {
  const value = useContext(Ctx);
  if (!value) throw new Error("WalletProvider is missing.");
  return value;
}
