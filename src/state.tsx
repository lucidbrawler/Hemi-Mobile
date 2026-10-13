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
  depositEth as depositEthTx,
  finalizeWithdrawal,
  proveWithdrawal,
  readL1Eth,
  readWithdrawalStage,
  sendEthereum as sendEthereumTx,
  stageError,
  withdrawEth as withdrawEthTx,
  type WithdrawalFields,
} from "./lib/ethBridge";
import { ETH_EXPLORER, HEMI_TOKEN, USDT, VETRO_USD, VUSD, WBTC } from "./chain";
import { claimPositionFees, withdrawLp, type LpWithdraw } from "./lib/lpRewards";
import { claimMerklRewards } from "./lib/merkl";
import { assetSpec, executePoolDeposit, executePoolIncrease, poolById, type PoolDeposit, type PoolIncrease, type PoolVenue } from "./lib/pool";
import { rememberPending } from "./lib/pending";
import { executeSwap, type SwapAssetId, type SwapOrder } from "./lib/swap";
import { fetchTokenPrices, PRICE_TOKENS, type PriceBook } from "./lib/prices";
import { addHemiToLock, claimStake, extendHemiLock, lockHemi, unlockStake, type StakeExtend } from "./lib/stake";
import { celebrate, pokeBuddy } from "./lib/fx";
import {
  confirmHemiDeposit,
  readBtcConfirmations,
  readDepositAcknowledged,
  quoteVaultFee,
  btcTxUrl,
  hemiTxUrl,
  readErc20,
  type ChainLeg,
  readHemiBalances,
  readVault,
  requireEvmAddress,
  sendErc20,
  sendEth as sendEthTx,
  sendHemiBtc,
  withdrawToBitcoin,
  type VaultQuote,
} from "./lib/hemi";
import { nativePasskeyAvailable, nativeShell } from "./lib/devicePasskey";
import {
  attachPassword2fa,
  forgetWallet,
  hydrateVault,
  inspectWallet,
  listWallets,
  loadByPasskey,
  loadByPassword,
  markEthMove,
  markTunnel,
  pushEthMove,
  pushTunnel,
  readEthMoves,
  readTunnels,
  savePasswordOnly,
  saveWithPasskey,
  walletNameTaken,
  type EthMove,
  type SavedWallet,
  type StoredWithdrawal,
  type TunnelRecord,
  type VaultAuth,
} from "./lib/storage";
import { passkeyBlockReason, passkeySupported } from "./lib/passkey";
import { IDLE_LOCK_MS } from "./lib/lockPolicy";
import { clearSession, publicWallet, requireSession, setSession, type PublicWallet } from "./lib/sessionVault";
import { deriveWallet, type DerivedWallet } from "./lib/wallet";
import { messageOf } from "./lib/errors";

function noteHemi(owner: string, hash: string, title: string, detail: string, legs: ChainLeg[]) {
  rememberPending({
    hash,
    owner,
    when: Date.now(),
    title,
    detail,
    href: hemiTxUrl(hash),
    legs,
    clear: "indexed",
  });
}

function notePool(
  owner: string,
  hash: string,
  title: string,
  order: { poolId: string; amount0: bigint; amount1: bigint },
  sign: bigint,
) {
  const pool = poolById(order.poolId);
  const legs: ChainLeg[] = [];
  if (pool) {
    for (const [asset, amount] of [[pool.token0, order.amount0], [pool.token1, order.amount1]] as const) {
      if (amount === 0n) continue;
      const spec = assetSpec(asset);
      const signed = sign < 0n ? -amount : amount;
      legs.push({ amount: signed.toString(), decimals: spec.decimals, symbol: spec.label });
    }
  }
  rememberPending({
    hash,
    owner,
    when: Date.now(),
    title,
    detail: pool ? `${pool.pairLabel} · Pending` : "Pending",
    href: hemiTxUrl(hash),
    legs,
    clear: "indexed",
  });
}

function swapName(id: SwapAssetId): string {
  switch (id) {
    case "eth": return "ETH";
    case "hemi": return "HEMI";
    case "vusd": return "VUSD";
    case "vetro": return "Vetro";
    case "usdt": return "USDT";
    case "hemibtc": return "hemiBTC";
    case "wbtc": return "WBTC";
  }
}

function swapDecimals(id: SwapAssetId): number {
  if (id === "usdt") return 6;
  if (id === "hemibtc" || id === "wbtc") return 8;
  return 18;
}

type Balances = {
  btcSats: bigint | null;
  hemiSats: bigint | null;
  ethWei: bigint | null;
  l1EthWei: bigint | null;
  hemiTokenWei: bigint | null;
  hemiTokenSymbol: string;
  hemiTokenDecimals: number;
  vusdWei: bigint | null;
  vusdSymbol: string;
  vusdDecimals: number;
  vetroWei: bigint | null;
  wbtcSats: bigint | null;
  usdtRaw: bigint | null;
  usd: number | null;
  symbol: string;
  decimals: number;
};

const noAuth: VaultAuth = { saved: false, hasPassword: false, hasPasskey: false, require2fa: false };

type SaveOptions = { twoFactor: boolean; password?: string };
type PasskeyKind = "native" | "web" | "none";

type WalletApi = {
  ready: boolean;
  saved: boolean;
  auth: VaultAuth;
  passkeyReady: boolean;
  passkeyKind: PasskeyKind;
  passkeyNote: string | null;
  wallets: SavedWallet[];
  walletName: string | null;
  wallet: PublicWallet | null;
  balances: Balances;
  prices: PriceBook | null;
  vault: VaultQuote | null;
  tunnels: TunnelRecord[];
  ethMoves: EthMove[];
  refreshing: boolean;
  notice: string | null;
  error: string | null;
  clearFlash: () => void;
  saveWallet: (name: string, mnemonic: string, options: SaveOptions) => Promise<void>;
  unlockPasskey: (name: string) => Promise<void>;
  unlockPassword: (name: string, password: string) => Promise<void>;
  unlock2fa: (name: string, password: string) => Promise<void>;
  enablePasskey: (options: SaveOptions) => Promise<void>;
  enablePassword2fa: (password: string) => Promise<void>;
  removeWallet: (name: string) => Promise<void>;
  lock: () => void;
  refresh: () => Promise<void>;
  feeRate: () => Promise<number>;
  sendBitcoin: (to: string, amount: bigint) => Promise<string>;
  sendEth: (to: string, amount: bigint) => Promise<string>;
  sendEthereum: (to: string, amount: bigint) => Promise<string>;
  sendHemi: (to: string, amount: bigint) => Promise<string>;
  sendHemiToken: (to: string, amount: bigint) => Promise<string>;
  sendVusd: (to: string, amount: bigint) => Promise<string>;
  sendVetro: (to: string, amount: bigint) => Promise<string>;
  sendWbtc: (to: string, amount: bigint) => Promise<string>;
  sendUsdt: (to: string, amount: bigint) => Promise<string>;
  swap: (order: SwapOrder, onPhase?: (phase: "approve" | "swap") => void) => Promise<string>;
  addLiquidity: (order: PoolDeposit, onPhase?: (phase: "approve" | "deposit") => void) => Promise<string>;
  addToPosition: (order: PoolIncrease, onPhase?: (phase: "approve" | "deposit") => void) => Promise<string>;
  withdrawLiquidity: (order: LpWithdraw) => Promise<string>;
  claimLpFees: (venue: PoolVenue, tokenId: bigint) => Promise<string>;
  claimMerkl: (tokens: string[]) => Promise<string>;
  stakeLock: (amount: bigint, durationSec: bigint, onPhase?: (phase: "approve" | "lock") => void) => Promise<string>;
  stakeAdd: (tokenId: bigint, amount: bigint, onPhase?: (phase: "approve" | "add") => void) => Promise<string>;
  stakeExtend: (tokenId: bigint, extend: StakeExtend) => Promise<string>;
  stakeClaim: (tokenId: bigint) => Promise<string>;
  stakeUnlock: (tokenId: bigint, onPhase?: (phase: "record" | "unlock") => void) => Promise<string>;
  deposit: (hemiAddress: string, amount: bigint) => Promise<string>;
  withdraw: (btcAddress: string, amount: bigint) => Promise<string>;
  mintDeposit: (record: TunnelRecord) => Promise<void>;
  vaultFee: (kind: "deposit" | "withdraw", amount: bigint) => Promise<bigint>;
  depositEth: (to: string, amount: bigint) => Promise<string>;
  withdrawEth: (to: string, amount: bigint) => Promise<string>;
  proveEth: (id: string) => Promise<string>;
  finalizeEth: (id: string) => Promise<string>;
  markEth: (id: string, status: EthMove["status"]) => void;
  markBtc: (id: string, status: TunnelRecord["status"]) => void;
};

const Ctx = createContext<WalletApi | null>(null);

const emptyBalances: Balances = {
  btcSats: null,
  hemiSats: null,
  ethWei: null,
  l1EthWei: null,
  hemiTokenWei: null,
  hemiTokenSymbol: "HEMI",
  hemiTokenDecimals: 18,
  vusdWei: null,
  vusdSymbol: "VUSD",
  vusdDecimals: 18,
  vetroWei: null,
  wbtcSats: null,
  usdtRaw: null,
  usd: null,
  symbol: "hemiBTC",
  decimals: 8,
};

export function WalletProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState(false);
  const [auth, setAuth] = useState<VaultAuth>(noAuth);
  const [passkeyReady, setPasskeyReady] = useState(false);
  const [passkeyKind, setPasskeyKind] = useState<PasskeyKind>("none");
  const [passkeyNote, setPasskeyNote] = useState<string | null>(null);
  const [wallets, setWallets] = useState<SavedWallet[]>([]);
  const [walletName, setWalletName] = useState<string | null>(null);
  const [wallet, setWallet] = useState<PublicWallet | null>(null);
  const [balances, setBalances] = useState<Balances>(emptyBalances);
  const [prices, setPrices] = useState<PriceBook | null>(null);
  const [vault, setVault] = useState<VaultQuote | null>(null);
  const [tunnels, setTunnels] = useState<TunnelRecord[]>([]);
  const [ethMoves, setEthMoves] = useState<EthMove[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reloadWallets = useCallback(() => {
    const rows = listWallets();
    setWallets(rows);
    setSaved(rows.length > 0);
    return rows;
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        await hydrateVault();
      } catch (err) {
        if (!live) return;
        setError(messageOf(err));
        return;
      }
      const native = await nativePasskeyAvailable();
      const kind: PasskeyKind = native ? "native" : passkeySupported() ? "web" : "none";
      if (!live) return;
      setPasskeyKind(kind);
      setPasskeyReady(kind !== "none");
      setPasskeyNote(
        kind === "none"
          ? nativeShell()
            ? "This phone has no fingerprint or face the app can use. A password can save the wallet here."
            : passkeyBlockReason()
          : null,
      );
      reloadWallets();
      setTunnels(readTunnels());
      setEthMoves(readEthMoves());
      setReady(true);
    })();
    return () => {
      live = false;
    };
  }, [reloadWallets]);

  const lockWallet = useCallback(() => {
    clearSession();
    setWallet(null);
    setWalletName(null);
    setAuth(noAuth);
    setBalances(emptyBalances);
    setPrices(null);
  }, []);

  useEffect(() => {
    if (!wallet) return;
    let timer = window.setTimeout(() => lockWallet(), IDLE_LOCK_MS);
    const bump = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => lockWallet(), IDLE_LOCK_MS);
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") lockWallet();
    };
    window.addEventListener("pointerdown", bump, true);
    window.addEventListener("keydown", bump);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", bump, true);
      window.removeEventListener("keydown", bump);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [wallet, lockWallet]);

  const refresh = useCallback(async () => {
    if (!wallet) return;
    setRefreshing(true);
    setError(null);
    const priceTask = fetchTokenPrices(PRICE_TOKENS);
    try {
      const [btcSats, hemi, usd, nextVault, l1EthWei, hemiToken, vusd, vetro, wbtc, usdt] = await Promise.all([
        fetchBtcBalance(wallet.btcAddress),
        readHemiBalances(wallet.hemiAddress),
        fetchBtcPrice().catch(() => null),
        readVault().catch(() => null),
        readL1Eth(wallet.hemiAddress).catch(() => null),
        readErc20(wallet.hemiAddress, HEMI_TOKEN, "HEMI", 18).catch(() => null),
        readErc20(wallet.hemiAddress, VUSD, "VUSD", 18).catch(() => null),
        readErc20(wallet.hemiAddress, VETRO_USD, "Vetro", 18).catch(() => null),
        readErc20(wallet.hemiAddress, WBTC, "WBTC", 8).catch(() => null),
        readErc20(wallet.hemiAddress, USDT, "USDT", 6).catch(() => null),
      ]);
      setBalances({
        btcSats,
        hemiSats: hemi.hemiSats,
        ethWei: hemi.ethWei,
        l1EthWei,
        hemiTokenWei: hemiToken?.raw ?? null,
        hemiTokenSymbol: hemiToken?.symbol ?? "HEMI",
        hemiTokenDecimals: hemiToken?.decimals ?? 18,
        vusdWei: vusd?.raw ?? null,
        vusdSymbol: vusd?.symbol ?? "VUSD",
        vusdDecimals: vusd?.decimals ?? 18,
        vetroWei: vetro?.raw ?? null,
        wbtcSats: wbtc?.raw ?? null,
        usdtRaw: usdt?.raw ?? null,
        usd,
        symbol: hemi.symbol,
        decimals: hemi.decimals,
      });
      const byAddress = await priceTask.catch(() => null);
      setPrices({
        byAddress: byAddress ?? {},
        btc: usd != null && Number.isFinite(usd) && usd > 0 ? usd : null,
      });
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

  const open = useCallback(async (name: string, mnemonic: string) => {
    const derived = deriveWallet(mnemonic);
    setSession(derived);
    setWalletName(name);
    setWallet(publicWallet(derived));
    setAuth(inspectWallet(name));
    reloadWallets();
    setNotice(null);
    setError(null);
  }, [reloadWallets]);

  const api = useMemo<WalletApi>(() => {
    function requireWallet(): DerivedWallet {
      return requireSession();
    }

    return {
      ready,
      saved,
      auth,
      passkeyReady,
      passkeyKind,
      passkeyNote,
      wallets,
      walletName,
      wallet,
      balances,
      prices,
      vault,
      tunnels,
      ethMoves,
      refreshing,
      notice,
      error,
      clearFlash: () => {
        setNotice(null);
        setError(null);
      },
      async saveWallet(name, mnemonic, options) {
        if (walletNameTaken(name)) throw new Error("A wallet with that name is already on this device.");
        const derived = deriveWallet(mnemonic);
        const native = passkeyKind === "native";
        if (passkeyReady) {
          await saveWithPasskey(name, derived.mnemonic, derived.btcAddress, {
            password: options.twoFactor ? options.password : undefined,
            require2fa: options.twoFactor,
            native,
          });
        } else {
          if (!options.password) throw new Error("Set a password. Passkey is not available here.");
          await savePasswordOnly(name, derived.mnemonic, options.password, derived.btcAddress);
        }
        await open(name.trim().replace(/\s+/g, " "), derived.mnemonic);
      },
      async unlockPasskey(name) {
        const row = inspectWallet(name);
        if (row.require2fa) throw new Error("Enter the password, then confirm the passkey.");
        if (!row.hasPasskey) throw new Error("This wallet has no passkey.");
        await open(name, await loadByPasskey(name));
      },
      async unlockPassword(name, password) {
        const row = inspectWallet(name);
        if (row.require2fa) throw new Error("This wallet unlocks with the password and the passkey together.");
        if (row.hasPasskey && !row.hasPassword) throw new Error("Unlock this wallet with the passkey.");
        await open(name, await loadByPassword(name, password));
      },
      async unlock2fa(name, password) {
        const row = inspectWallet(name);
        if (!row.require2fa) throw new Error("2FA is not on for this wallet.");
        const fromPassword = await loadByPassword(name, password);
        const fromPasskey = await loadByPasskey(name);
        if (fromPassword !== fromPasskey) {
          throw new Error("Password and passkey unlocked different phrases. Import the phrase and save again.");
        }
        await open(name, fromPasskey);
      },
      async enablePasskey(options) {
        const current = requireWallet();
        if (!walletName) throw new Error("Unlock the wallet first.");
        if (options.twoFactor && auth.hasPassword) {
          if (!options.password) throw new Error("Enter the wallet password to keep it as 2FA.");
          const got = await loadByPassword(walletName, options.password);
          if (got !== current.mnemonic) throw new Error("Wrong password.");
        }
        await saveWithPasskey(walletName, current.mnemonic, current.btcAddress, {
          password: options.twoFactor ? options.password : undefined,
          require2fa: options.twoFactor,
          native: passkeyKind === "native",
          existingPassword: options.twoFactor && auth.hasPassword,
        });
        setAuth(inspectWallet(walletName));
        reloadWallets();
        setNotice(options.twoFactor ? "Next unlock: password, then passkey." : "Next unlock: passkey.");
      },
      async enablePassword2fa(password) {
        const current = requireWallet();
        if (!walletName) throw new Error("Unlock the wallet first.");
        await attachPassword2fa(walletName, current.mnemonic, password);
        setAuth(inspectWallet(walletName));
        reloadWallets();
        setNotice("2FA is on. Next unlock asks for the password, then the passkey.");
      },
      async removeWallet(name) {
        await forgetWallet(name);
        if (walletName && walletName.toLowerCase() === name.trim().toLowerCase()) lockWallet();
        reloadWallets();
        setNotice(null);
      },
      lock() {
        lockWallet();
      },
      refresh,
      feeRate: fetchFeeRate,
      async sendBitcoin(to, amount) {
        pokeBuddy();
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
        rememberPending({
          hash: txid,
          owner: current.btcAddress,
          when: Date.now(),
          title: "Bitcoin sent",
          detail: "Pending",
          href: btcTxUrl(txid),
          legs: [{ amount: (-amount).toString(), decimals: 8, symbol: "BTC" }],
          clear: "indexed",
        });
        setNotice(`Bitcoin sent. ${txid.slice(0, 10)}…`);
        celebrate("Sent.");
        await refresh();
        return txid;
      },
      async sendEth(to, amount) {
        pokeBuddy();
        const current = requireWallet();
        const hash = await sendEthTx(current.hemiPrivateKey, to, amount);
        noteHemi(current.hemiAddress, hash, "ETH sent", "Pending", [{ amount: (-amount).toString(), decimals: 18, symbol: "ETH" }]);
        setNotice(`ETH sent. ${hash.slice(0, 10)}…`);
        celebrate("Sent.");
        await refresh();
        return hash;
      },
      async sendEthereum(to, amount) {
        pokeBuddy();
        const current = requireWallet();
        const hash = await sendEthereumTx(current.hemiPrivateKey, to, amount);
        rememberPending({
          hash,
          owner: current.hemiAddress,
          when: Date.now(),
          title: "ETH sent",
          detail: "Pending · Ethereum",
          href: `${ETH_EXPLORER}/tx/${hash}`,
          legs: [{ amount: (-amount).toString(), decimals: 18, symbol: "ETH" }],
          clear: "mined",
        });
        setNotice(`ETH sent on Ethereum. ${hash.slice(0, 10)}…`);
        celebrate("Sent.");
        await refresh();
        return hash;
      },
      async sendHemi(to, amount) {
        pokeBuddy();
        const current = requireWallet();
        const hash = await sendHemiBtc(current.hemiPrivateKey, to, amount);
        noteHemi(current.hemiAddress, hash, "hemiBTC sent", "Pending", [{ amount: (-amount).toString(), decimals: 8, symbol: "hemiBTC" }]);
        setNotice(`hemiBTC sent. ${hash.slice(0, 10)}…`);
        celebrate("Sent.");
        await refresh();
        return hash;
      },
      async sendHemiToken(to, amount) {
        pokeBuddy();
        const current = requireWallet();
        const hash = await sendErc20(current.hemiPrivateKey, HEMI_TOKEN, to, amount);
        noteHemi(current.hemiAddress, hash, "HEMI sent", "Pending", [{ amount: (-amount).toString(), decimals: 18, symbol: "HEMI" }]);
        setNotice(`HEMI sent. ${hash.slice(0, 10)}…`);
        celebrate("Sent.");
        await refresh();
        return hash;
      },
      async sendVusd(to, amount) {
        pokeBuddy();
        const current = requireWallet();
        const hash = await sendErc20(current.hemiPrivateKey, VUSD, to, amount);
        noteHemi(current.hemiAddress, hash, "VUSD sent", "Pending", [{ amount: (-amount).toString(), decimals: 18, symbol: "VUSD" }]);
        setNotice(`VUSD sent. ${hash.slice(0, 10)}…`);
        celebrate("Sent.");
        await refresh();
        return hash;
      },
      async sendVetro(to, amount) {
        pokeBuddy();
        const current = requireWallet();
        const hash = await sendErc20(current.hemiPrivateKey, VETRO_USD, to, amount);
        noteHemi(current.hemiAddress, hash, "Vetro sent", "Pending", [{ amount: (-amount).toString(), decimals: 18, symbol: "Vetro" }]);
        setNotice(`Vetro sent. ${hash.slice(0, 10)}…`);
        celebrate("Sent.");
        await refresh();
        return hash;
      },
      async sendWbtc(to, amount) {
        pokeBuddy();
        const current = requireWallet();
        const hash = await sendErc20(current.hemiPrivateKey, WBTC, to, amount);
        noteHemi(current.hemiAddress, hash, "WBTC sent", "Pending", [{ amount: (-amount).toString(), decimals: 8, symbol: "WBTC" }]);
        setNotice(`WBTC sent. ${hash.slice(0, 10)}…`);
        celebrate("Sent.");
        await refresh();
        return hash;
      },
      async sendUsdt(to, amount) {
        pokeBuddy();
        const current = requireWallet();
        const hash = await sendErc20(current.hemiPrivateKey, USDT, to, amount);
        noteHemi(current.hemiAddress, hash, "USDT sent", "Pending", [{ amount: (-amount).toString(), decimals: 6, symbol: "USDT" }]);
        setNotice(`USDT sent. ${hash.slice(0, 10)}…`);
        celebrate("Sent.");
        await refresh();
        return hash;
      },
      async swap(order, onPhase) {
        pokeBuddy();
        const current = requireWallet();
        const hash = await executeSwap(current.hemiPrivateKey, current.hemiAddress, order, onPhase);
        noteHemi(current.hemiAddress, hash, "Swap", `${swapName(order.sell)} → ${swapName(order.buy)} · Pending`, [
          { amount: (-order.amountIn).toString(), decimals: swapDecimals(order.sell), symbol: swapName(order.sell) },
        ]);
        setNotice(`Swapped. ${hash.slice(0, 10)}…`);
        celebrate("Swapped.");
        await refresh();
        return hash;
      },
      async addLiquidity(order, onPhase) {
        pokeBuddy("Depositing.");
        const current = requireWallet();
        const hash = await executePoolDeposit(current.hemiPrivateKey, current.hemiAddress, order, onPhase);
        notePool(current.hemiAddress, hash, "Add liquidity", order, -1n);
        setNotice(`Liquidity deposited. ${hash.slice(0, 10)}…`);
        celebrate("Deposited.");
        await refresh();
        return hash;
      },
      async addToPosition(order, onPhase) {
        pokeBuddy("Depositing.");
        const current = requireWallet();
        const hash = await executePoolIncrease(current.hemiPrivateKey, current.hemiAddress, order, onPhase);
        notePool(current.hemiAddress, hash, "Add liquidity", order, -1n);
        setNotice(`Added to the position. ${hash.slice(0, 10)}…`);
        celebrate("Deposited.");
        await refresh();
        return hash;
      },
      async withdrawLiquidity(order) {
        pokeBuddy("Withdrawing.");
        const current = requireWallet();
        const hash = await withdrawLp(current.hemiPrivateKey, order);
        notePool(current.hemiAddress, hash, "Withdraw liquidity", order, 1n);
        setNotice(`Liquidity withdrawn. ${hash.slice(0, 10)}…`);
        celebrate("Withdrawn.");
        await refresh();
        return hash;
      },
      async claimLpFees(venue, tokenId) {
        const current = requireWallet();
        const hash = await claimPositionFees(current.hemiPrivateKey, venue, tokenId);
        noteHemi(current.hemiAddress, hash, "Claim rewards", "Pending", []);
        setNotice(`Rewards claimed. ${hash.slice(0, 10)}…`);
        await refresh();
        return hash;
      },
      async claimMerkl(tokens) {
        const current = requireWallet();
        const hash = await claimMerklRewards(current.hemiPrivateKey, tokens);
        noteHemi(current.hemiAddress, hash, "Claim rewards", "Pending", []);
        setNotice(`Rewards claimed. ${hash.slice(0, 10)}…`);
        await refresh();
        return hash;
      },
      async stakeLock(amount, durationSec, onPhase) {
        pokeBuddy();
        const current = requireWallet();
        const hash = await lockHemi(current.hemiPrivateKey, amount, durationSec, onPhase);
        noteHemi(current.hemiAddress, hash, "HEMI locked", "Pending", [{ amount: (-amount).toString(), decimals: 18, symbol: "HEMI" }]);
        setNotice(`HEMI locked. ${hash.slice(0, 10)}…`);
        await refresh();
        return hash;
      },
      async stakeAdd(tokenId, amount, onPhase) {
        pokeBuddy("Adding.");
        const current = requireWallet();
        const hash = await addHemiToLock(current.hemiPrivateKey, tokenId, amount, onPhase);
        noteHemi(current.hemiAddress, hash, "HEMI added", "Pending", [{ amount: (-amount).toString(), decimals: 18, symbol: "HEMI" }]);
        setNotice(`HEMI added to the lock. ${hash.slice(0, 10)}…`);
        celebrate("Added.");
        await refresh();
        return hash;
      },
      async stakeExtend(tokenId, extend) {
        pokeBuddy("Extending.");
        const current = requireWallet();
        const hash = await extendHemiLock(current.hemiPrivateKey, tokenId, extend);
        rememberPending({
          hash,
          owner: current.hemiAddress,
          when: Date.now(),
          title: "Lock extended",
          detail: "Pending",
          href: hemiTxUrl(hash),
          legs: [],
          clear: "mined",
        });
        setNotice(`Lock extended. ${hash.slice(0, 10)}…`);
        celebrate("Extended.");
        await refresh();
        return hash;
      },
      async stakeClaim(tokenId) {
        const current = requireWallet();
        const hash = await claimStake(current.hemiPrivateKey, tokenId);
        noteHemi(current.hemiAddress, hash, "Claim rewards", "Pending", []);
        setNotice(`Rewards claimed. ${hash.slice(0, 10)}…`);
        await refresh();
        return hash;
      },
      async stakeUnlock(tokenId, onPhase) {
        pokeBuddy();
        const current = requireWallet();
        const hash = await unlockStake(current.hemiPrivateKey, tokenId, onPhase);
        noteHemi(current.hemiAddress, hash, "HEMI unlocked", "Pending", []);
        setNotice(`HEMI unlocked. ${hash.slice(0, 10)}…`);
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
        const live = vault ?? (await readVault());
        setVault(live);
        const already = await readDepositAcknowledged(live.stateAddress, record.txHash).catch(() => false);
        if (already) {
          setTunnels(markTunnel(record.id, "minted"));
          setNotice("The vault already minted hemiBTC for this deposit.");
          await refresh();
          return;
        }
        if (record.outputIndex == null) throw new Error("This deposit has no output index.");
        const confs = await readBtcConfirmations(record.txHash);
        const need = live.confirmations;
        if (confs < need) {
          throw new Error(`${confs} of ${need} Bitcoin confirmations so far.`);
        }
        try {
          await confirmHemiDeposit(current.hemiPrivateKey, record.txHash, record.outputIndex);
        } catch (err) {
          const acked = await readDepositAcknowledged(live.stateAddress, record.txHash).catch(() => false);
          if (!acked) throw err;
          setTunnels(markTunnel(record.id, "minted"));
          setNotice("The vault already minted hemiBTC for this deposit.");
          await refresh();
          return;
        }
        setTunnels(markTunnel(record.id, "minted"));
        setNotice("Mint submitted. hemiBTC shows up after the Hemi transaction confirms.");
        await refresh();
      },
      async vaultFee(kind, amount) {
        const live = vault ?? (await readVault());
        setVault(live);
        return quoteVaultFee(live.stateAddress, kind, amount);
      },
      async depositEth(to, amount) {
        const current = requireWallet();
        const hash = await depositEthTx(current.hemiPrivateKey, to, amount);
        setEthMoves(pushEthMove({
          id: hash,
          direction: "to-hemi",
          createdAt: Date.now(),
          amountWei: amount.toString(),
          from: current.hemiAddress,
          to: requireEvmAddress(to),
          txHash: hash,
          hemiWeiBefore: balances.ethWei == null ? undefined : balances.ethWei.toString(),
          status: "submitted",
        }));
        setNotice("Deposit submitted on Ethereum. Hemi credits that address after the next derived blocks.");
        await refresh();
        return hash;
      },
      async withdrawEth(to, amount) {
        const current = requireWallet();
        const sent = await withdrawEthTx(current.hemiPrivateKey, to, amount);
        setEthMoves(pushEthMove({
          id: sent.hash,
          direction: "to-ethereum",
          createdAt: Date.now(),
          amountWei: amount.toString(),
          from: current.hemiAddress,
          to: requireEvmAddress(to),
          txHash: sent.hash,
          l2Block: sent.l2Block,
          withdrawal: storedWithdrawal(sent.withdrawal, sent.withdrawalHash),
          status: "submitted",
        }));
        setNotice("Withdrawal submitted on Hemi. Prove it on Ethereum once an output includes this block.");
        await refresh();
        return sent.hash;
      },
      async proveEth(id) {
        const current = requireWallet();
        const move = readEthMoves().find((row) => row.id === id);
        const fields = move ? withdrawalFields(move) : null;
        if (!move || !fields || move.l2Block == null) throw new Error("This withdrawal has no exit message.");
        const stage = await readWithdrawalStage(fields, move.l2Block);
        if (stage.kind !== "ready-to-prove") throw new Error(stageError(stage));
        const hash = await proveWithdrawal(current.hemiPrivateKey, fields, stage.output);
        setEthMoves(markEthMove(id, "proven"));
        setNotice("Proof submitted on Ethereum. Finalize after the waiting period.");
        await refresh();
        return hash;
      },
      async finalizeEth(id) {
        const current = requireWallet();
        const move = readEthMoves().find((row) => row.id === id);
        const fields = move ? withdrawalFields(move) : null;
        if (!move || !fields || move.l2Block == null) throw new Error("This withdrawal has no exit message.");
        const stage = await readWithdrawalStage(fields, move.l2Block);
        if (stage.kind !== "ready-to-finalize") throw new Error(stageError(stage));
        const hash = await finalizeWithdrawal(current.hemiPrivateKey, fields);
        setEthMoves(markEthMove(id, "finalized"));
        setNotice("Finalized. The ETH is on the Ethereum address from the withdrawal.");
        await refresh();
        return hash;
      },
      markEth(id, status) {
        setEthMoves(markEthMove(id, status));
      },
      markBtc(id, status) {
        setTunnels(markTunnel(id, status));
      },
    };
  }, [ready, saved, auth, passkeyReady, passkeyKind, passkeyNote, wallets, walletName, wallet, balances, prices, vault, tunnels, ethMoves, refreshing, notice, error, open, refresh, reloadWallets, lockWallet]);

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

function storedWithdrawal(tx: WithdrawalFields, hash: string): StoredWithdrawal {
  return {
    nonce: tx.nonce.toString(),
    sender: tx.sender,
    target: tx.target,
    value: tx.value.toString(),
    gasLimit: tx.gasLimit.toString(),
    data: tx.data,
    hash,
  };
}

export function withdrawalFields(move: EthMove): WithdrawalFields | null {
  const row = move.withdrawal;
  if (!row) return null;
  return {
    nonce: BigInt(row.nonce),
    sender: row.sender,
    target: row.target,
    value: BigInt(row.value),
    gasLimit: BigInt(row.gasLimit),
    data: row.data,
  };
}

export function useWallet(): WalletApi {
  const value = useContext(Ctx);
  if (!value) throw new Error("WalletProvider is missing.");
  return value;
}
