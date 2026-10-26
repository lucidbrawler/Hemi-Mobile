import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import btcIcon from "../assets/btc.svg";
import ethIcon from "../assets/eth.svg";
import hemiEthIcon from "../assets/hemieth.svg";
import hemiIcon from "../assets/hemi.svg";
import hemiBtcIcon from "../assets/hemibtc.svg";
import usdtIcon from "../assets/usdt.svg";
import vetroIcon from "../assets/vetro.svg";
import vusdIcon from "../assets/vusd.svg";
import wbtcIcon from "../assets/wbtc.svg";
import { ETH_EXPLORER, HEMIBTC, HEMI_TOKEN, USDT, VETRO_USD, VUSD, WBTC } from "../chain";
import { quoteBtcSendFee } from "../lib/btc";
import { quoteEthereumFee } from "../lib/ethBridge";
import { formatLockRemain, formatUnits, formatUsd, formatWhen, parseUnits, satsToBtc, shortAddr } from "../lib/format";
import { btcAddressUrl, hemiAddressUrl, quoteHemiNativeFee, quoteHemiTokenFee } from "../lib/hemi";
import { messageOf } from "../lib/errors";
import { loadLpRewards, poolsValueUsd, positionFeeLine, positionSizeLine, positionUsdLine, type LpPosition, type LpRewardSnapshot } from "../lib/lpRewards";
import { poolById } from "../lib/pool";
import { WETH, holdingUsd, usdToSats, walletValueUsd, type PriceBook, type ValuedHolding } from "../lib/prices";
import { readStake, stakeExtensions, stakeLockedUsd, stakeRewardLine, stakeRewardTokens, stakeRewardsUsd, type StakePosition } from "../lib/stake";
import { nativeShell } from "../lib/devicePasskey";
import { NATIVE_PASSWORD_ERROR, passwordMeetsBar } from "../lib/password";
import { exportPhrase } from "../lib/sessionVault";
import { useWallet } from "../state";
import { PasswordRules } from "./PasswordRules";
import { MerklOnPosition, useMerklRewards } from "./MerklPosition";
import { PoolSheet } from "./PoolSheet";
import { PositionSheet } from "./PositionSheet";
import { StakeSheet, type StakeFocus } from "./StakeSheet";
import { SwapSheet } from "./SwapSheet";
import { usePrices } from "./usePrices";

type Sheet = null | "receive" | "receive-hemi" | "send-btc" | "send-l1-eth" | "token" | "swap" | "stake" | "stake-rewards" | "pool" | "rewards" | "position" | "phrase" | "passkey" | "2fa";
type HemiAsset = "eth" | "hemi" | "vusd" | "hemibtc" | "vetro" | "wbtc" | "usdt";

const EMPTY_KEY = "hemi-show-empty";

type HemiHolding = {
  asset: HemiAsset;
  icon: string;
  ticker: string;
  detail: string;
  raw: bigint | null;
  decimals: number;
  unit: string;
  token: string;
};

function rowUsd(book: PriceBook | null, row: HemiHolding): number | null {
  if (row.raw == null || row.raw === 0n) return null;
  return walletValueUsd(book, [{ amount: row.raw, decimals: row.decimals, token: row.token }]);
}

function sortHoldings(book: PriceBook | null, rows: HemiHolding[]): HemiHolding[] {
  return rows
    .map((row, index) => ({ row, index, usd: rowUsd(book, row) }))
    .sort((a, b) => {
      const bucket = (item: { row: HemiHolding; usd: number | null }) => {
        if (item.row.raw == null) return 2;
        if (item.row.raw === 0n) return 3;
        if (item.usd == null) return 1;
        return 0;
      };
      const diff = bucket(a) - bucket(b);
      if (diff !== 0) return diff;
      if (a.usd != null && b.usd != null && a.usd !== b.usd) return b.usd - a.usd;
      return a.index - b.index;
    })
    .map((item) => item.row);
}

function portfolioHero(input: {
  usd: number | null;
  loading: boolean;
  asBtc: bigint | null;
  book: PriceBook | null;
  extrasLoading: boolean;
  gap: string | null;
  stakedUsd: number | null;
  pooledUsd: number | null;
}): { amount: string; line: string; note: string | null } {
  const { usd, loading, asBtc, book, extrasLoading, gap, stakedUsd, pooledUsd } = input;
  if (usd == null) {
    return { amount: "—", line: loading ? "—" : "Price unavailable", note: null };
  }
  const btcLine = asBtc == null ? "Bitcoin price unavailable" : `≈ ${satsToBtc(asBtc)} BTC`;
  if (extrasLoading) {
    return { amount: formatUsd(usd), line: btcLine, note: "Checking stake and pools…" };
  }
  if (gap) {
    return { amount: formatUsd(usd), line: btcLine, note: gap };
  }
  if (stakedUsd == null || pooledUsd == null) {
    if (book == null) return { amount: formatUsd(usd), line: btcLine, note: "Checking stake and pools…" };
    return { amount: "—", line: "Price unavailable", note: null };
  }
  if (stakedUsd === 0 && pooledUsd === 0) {
    return { amount: formatUsd(usd), line: btcLine, note: null };
  }
  const total = usd + stakedUsd + pooledUsd;
  const totalSats = usdToSats(total, book?.btc ?? null);
  return {
    amount: formatUsd(total),
    line: totalSats == null ? "Bitcoin price unavailable" : `≈ ${satsToBtc(totalSats)} BTC`,
    note: `Available ${formatUsd(usd)} · Staked ${formatUsd(stakedUsd)} · In pools ${formatUsd(pooledUsd)}`,
  };
}

function poolsKnown(snapshot: LpRewardSnapshot | null): boolean {
  if (snapshot == null) return false;
  return snapshot.positions.every((position) => position.liquidity === 0n || position.amountsKnown);
}

export function Home() {
  const w = useWallet();
  const wallet = w.wallet!;
  const [sheet, setSheet] = useState<Sheet>(null);
  const [managed, setManaged] = useState<LpPosition | null>(null);
  const [managedMode, setManagedMode] = useState<"add" | "withdraw">("add");
  const [lpReload, setLpReload] = useState(0);
  const [stakeReload, setStakeReload] = useState(0);
  const [stakeFocus, setStakeFocus] = useState<StakeFocus | null>(null);
  const [tokenAsset, setTokenAsset] = useState<HemiAsset>("hemibtc");
  const [tokenMode, setTokenMode] = useState<"send" | "receive">("send");
  const [stakePositions, setStakePositions] = useState<StakePosition[] | null>(null);
  const [stakeError, setStakeError] = useState<string | null>(null);
  const [lpSnapshot, setLpSnapshot] = useState<LpRewardSnapshot | null>(null);
  const [lpError, setLpError] = useState<string | null>(null);
  const [showEmpty, setShowEmpty] = useState(() => {
    try {
      return localStorage.getItem(EMPTY_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [loadedFor, setLoadedFor] = useState(wallet.hemiAddress);
  if (loadedFor !== wallet.hemiAddress) {
    setLoadedFor(wallet.hemiAddress);
    setStakePositions(null);
    setStakeError(null);
    setLpSnapshot(null);
    setLpError(null);
  }
  function closePool() {
    setSheet(null);
    setLpReload((value) => value + 1);
  }
  function openPosition(row: LpPosition, mode: "add" | "withdraw") {
    setManaged(row);
    setManagedMode(mode);
    setSheet("position");
  }
  function closePosition() {
    setSheet(null);
    setLpReload((value) => value + 1);
  }
  function closeStake() {
    setSheet(null);
    setStakeFocus(null);
    setStakeReload((value) => value + 1);
  }
  function openStake(focus: StakeFocus | null) {
    setStakeFocus(focus);
    setSheet(focus ? "stake-rewards" : "stake");
  }
  function openToken(asset: HemiAsset, mode: "send" | "receive") {
    setTokenAsset(asset);
    setTokenMode(mode);
    setSheet("token");
  }
  function toggleEmpty() {
    setShowEmpty((current) => {
      const next = !current;
      try {
        localStorage.setItem(EMPTY_KEY, next ? "1" : "0");
      } catch {
        // The list still toggles for this visit when storage is blocked.
      }
      return next;
    });
  }
  useEffect(() => {
    let cancel = false;
    setStakeError(null);
    setLpError(null);
    void readStake(wallet.hemiAddress).then(
      (next) => { if (!cancel) setStakePositions(next); },
      (err: unknown) => { if (!cancel) setStakeError(messageOf(err)); },
    );
    void loadLpRewards(wallet.hemiAddress).then(
      (next) => { if (!cancel) setLpSnapshot(next); },
      (err: unknown) => { if (!cancel) setLpError(messageOf(err)); },
    );
    return () => { cancel = true; };
  }, [wallet.hemiAddress, stakeReload, lpReload]);
  const btc = w.balances.btcSats;
  const hemi = w.balances.hemiSats;
  const book = w.prices;
  const holdings: ValuedHolding[] = [
    { amount: btc, decimals: 8, token: "btc" },
    { amount: w.balances.l1EthWei, decimals: 18, token: WETH },
    { amount: w.balances.ethWei, decimals: 18, token: WETH },
    { amount: w.balances.hemiTokenWei, decimals: w.balances.hemiTokenDecimals, token: HEMI_TOKEN },
    { amount: w.balances.vusdWei, decimals: w.balances.vusdDecimals, token: VUSD },
    { amount: hemi, decimals: w.balances.decimals, token: HEMIBTC },
    { amount: w.balances.vetroWei, decimals: 18, token: VETRO_USD },
    { amount: w.balances.wbtcSats, decimals: 8, token: WBTC },
    { amount: w.balances.usdtRaw, decimals: 6, token: USDT },
  ];
  const usd = walletValueUsd(book, holdings);
  const loading = usd == null && (book == null || holdings.some((holding) => holding.amount == null));
  const asBtc = usd == null ? null : usdToSats(usd, book?.btc ?? null);
  const stakeWaiting = stakePositions == null && stakeError == null;
  const poolsWaiting = lpSnapshot == null && lpError == null;
  const extrasLoading = stakeWaiting || poolsWaiting;
  const stakeMissing = stakePositions == null && stakeError != null;
  const knownPools = poolsKnown(lpSnapshot);
  const gapParts = [
    stakeMissing ? "Stake did not load" : null,
    lpSnapshot == null && lpError != null ? "Pools did not load" : null,
    lpSnapshot != null && !knownPools ? "Pool amounts did not load" : null,
  ].filter((part): part is string => part != null);
  const stakedUsd = stakePositions == null
    ? null
    : walletValueUsd(book, stakePositions.map((position) => ({ amount: position.amount, decimals: 18, token: HEMI_TOKEN })));
  const pooledUsd = lpSnapshot == null || !knownPools ? null : poolsValueUsd(book, lpSnapshot.positions);
  const hero = portfolioHero({
    usd,
    loading,
    asBtc,
    book,
    extrasLoading,
    gap: gapParts.length === 0 ? null : gapParts.join(" · "),
    stakedUsd,
    pooledUsd,
  });
  const hemiRows = sortHoldings(book, [
    {
      asset: "eth",
      icon: hemiEthIcon,
      ticker: "ETH",
      detail: "On Hemi · gas",
      raw: w.balances.ethWei,
      decimals: 18,
      unit: "ETH",
      token: WETH,
    },
    {
      asset: "hemi",
      icon: hemiIcon,
      ticker: w.balances.hemiTokenSymbol,
      detail: `ERC-20 · ${w.balances.hemiTokenDecimals} decimals · ${shortAddr(HEMI_TOKEN, 6, 4)}`,
      raw: w.balances.hemiTokenWei,
      decimals: w.balances.hemiTokenDecimals,
      unit: w.balances.hemiTokenSymbol,
      token: HEMI_TOKEN,
    },
    {
      asset: "vusd",
      icon: vusdIcon,
      ticker: w.balances.vusdSymbol,
      detail: `Stablecoin · ${w.balances.vusdDecimals} decimals · ${shortAddr(VUSD, 6, 4)}`,
      raw: w.balances.vusdWei,
      decimals: w.balances.vusdDecimals,
      unit: w.balances.vusdSymbol,
      token: VUSD,
    },
    {
      asset: "hemibtc",
      icon: hemiBtcIcon,
      ticker: w.balances.symbol,
      detail: `ERC-20 · ${w.balances.decimals} decimals · ${shortAddr(HEMIBTC, 6, 4)}`,
      raw: hemi,
      decimals: w.balances.decimals,
      unit: w.balances.symbol,
      token: HEMIBTC,
    },
    {
      asset: "vetro",
      icon: vetroIcon,
      ticker: "Vetro",
      detail: `Vetro USD · 18 decimals · ${shortAddr(VETRO_USD, 6, 4)}`,
      raw: w.balances.vetroWei,
      decimals: 18,
      unit: "Vetro",
      token: VETRO_USD,
    },
    {
      asset: "wbtc",
      icon: wbtcIcon,
      ticker: "WBTC",
      detail: `Wrapped BTC · 8 decimals · ${shortAddr(WBTC, 6, 4)}`,
      raw: w.balances.wbtcSats,
      decimals: 8,
      unit: "WBTC",
      token: WBTC,
    },
    {
      asset: "usdt",
      icon: usdtIcon,
      ticker: "USDT",
      detail: `Stablecoin · 6 decimals · ${shortAddr(USDT, 6, 4)}`,
      raw: w.balances.usdtRaw,
      decimals: 6,
      unit: "USDT",
      token: USDT,
    },
  ]);
  const anyHeld = hemiRows.some((row) => row.raw != null && row.raw > 0n);
  const hasEmpty = hemiRows.some((row) => row.raw === 0n);
  const visibleRows = hemiRows.filter((row) => showEmpty || !anyHeld || row.raw == null || row.raw > 0n);

  return (
    <div>
      <section className="hero">
        <div className="kicker">
          <span>Total</span>
          <button className="ghost" type="button" onClick={() => { void w.refresh(); setLpReload((value) => value + 1); setStakeReload((value) => value + 1); }} disabled={w.refreshing}>
            {w.refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        <div className="balance">{hero.amount}</div>
        <div className="sub">{hero.line}</div>
        {hero.note && <div className="sub">{hero.note}</div>}
        <div className="meta">{w.walletName ? `${w.walletName} · ` : ""}Hemi mainnet · chain 43111 · Bitcoin and Ethereum</div>
      </section>

      <AssetRow
        icon={btcIcon}
        ticker="BTC"
        detail={`Native · ${shortAddr(wallet.btcAddress, 10, 6)}`}
        amount={btc == null ? "—" : satsToBtc(btc)}
        unit="BTC"
        usd={holdingUsd(book, btc, 8, "btc")}
        onClick={() => setSheet("send-btc")}
      />
      <AssetRow
        icon={ethIcon}
        ticker="ETH"
        detail={`Native · On Ethereum · ${shortAddr(wallet.hemiAddress, 10, 6)}`}
        amount={w.balances.l1EthWei == null ? "—" : formatUnits(w.balances.l1EthWei, 18)}
        unit="ETH"
        usd={holdingUsd(book, w.balances.l1EthWei, 18, WETH)}
        onClick={() => setSheet("send-l1-eth")}
      />

      <section className="card hemi-wallet">
        <div className="kicker"><span>Hemi wallet</span></div>
        <p className="hint">
          HEMI, VUSD, Vetro, WBTC, USDT, ETH, and bitcoin you tunnel as {w.balances.symbol} live on this Hemi address.
        </p>
        <CopyAddress address={wallet.hemiAddress} />
        {visibleRows.map((row) => (
          <Holding
            key={row.asset}
            icon={row.icon}
            ticker={row.ticker}
            detail={row.detail}
            amount={row.raw == null ? "—" : formatUnits(row.raw, row.decimals)}
            unit={row.unit}
            usd={holdingUsd(book, row.raw, row.decimals, row.token)}
            onClick={() => openToken(row.asset, "send")}
          />
        ))}
        <div className="actions">
          <button className="ghost" type="button" onClick={() => openStake(null)}>Stake HEMI</button>
          <button className="ghost" type="button" onClick={() => setSheet("pool")}>Add liquidity</button>
          {anyHeld && hasEmpty && (
            <button className="ghost" type="button" onClick={toggleEmpty}>{showEmpty ? "Hide empty" : "Show empty"}</button>
          )}
        </div>
      </section>

      <LiquidityCard
        owner={wallet.hemiAddress}
        snapshot={lpSnapshot}
        error={lpError}
        reloadKey={lpReload}
        onRewards={() => setSheet("rewards")}
        onOpen={openPosition}
      />

      <StakeCard
        positions={stakePositions}
        error={stakeError}
        onRewards={() => { setStakeFocus(null); setSheet("stake-rewards"); }}
        onManage={(tokenId, action) => openStake({ tokenId, action })}
      />

      <section className="card secure">
        <div className="kicker"><span>Unlock</span></div>
        <b>{w.auth.require2fa ? "Password + passkey" : w.auth.hasPasskey ? "Passkey" : "Password"}</b>
        <p className="fine">
          {w.auth.require2fa
            ? "Every login asks for the password, then the passkey."
            : w.auth.hasPasskey
              ? "The passkey opens this wallet. Add a password if you want a second factor."
              : "A password is saved. Enable a passkey to make that the unlock, and keep the password as 2FA if you want both."}
        </p>
        <p className="fine">The wallet locks when you leave the app, and after 5 minutes with no taps. Screenshots are blocked on the phone.</p>
        {w.auth.hasPasskey && !w.auth.require2fa && (
          <button className="ghost" type="button" onClick={() => setSheet("2fa")}>Add password 2FA</button>
        )}
        {!w.auth.hasPasskey && w.passkeyReady && (
          <button className="btn primary" type="button" onClick={() => setSheet("passkey")}>Enable passkey</button>
        )}
        <div className="actions">
          <button className="ghost" type="button" onClick={() => setSheet("phrase")}>Phrase</button>
          <button className="ghost" type="button" onClick={w.lock}>Lock</button>
        </div>
      </section>

      <div className="dock-spacer" aria-hidden="true" />
      <div className="dock">
        <button className="ghost" type="button" onClick={() => setSheet("receive")}>Receive</button>
        <button className="btn primary" type="button" onClick={() => setSheet("swap")}>Swap</button>
        <button className="ghost" type="button" onClick={() => openToken("eth", "send")}>Send</button>
      </div>

      {sheet === "receive" && <Receive initial="btc" onClose={() => setSheet(null)} />}
      {sheet === "receive-hemi" && <Receive initial="hemi" onClose={() => setSheet(null)} />}
      {sheet === "send-btc" && (
        <Send
          title="Send Bitcoin"
          unit="BTC"
          decimals={8}
          balance={btc}
          onClose={() => setSheet(null)}
          onSubmit={(to, amount) => w.sendBitcoin(to, amount)}
          quoteFee={(_to, amount) => quoteBtcSendFee(wallet.btcAddress, amount)}
          feeUnit="BTC"
          feeDecimals={8}
          placeholder="bc1…"
          initialMode="send"
          receive={{
            title: "Receive Bitcoin",
            address: wallet.btcAddress,
            explorer: btcAddressUrl(wallet.btcAddress),
            note: "Native segwit Bitcoin. Do not send hemiBTC here.",
          }}
        />
      )}
      {sheet === "send-l1-eth" && (
        <Send
          title="Send ETH on Ethereum"
          unit="ETH"
          decimals={18}
          balance={w.balances.l1EthWei}
          onClose={() => setSheet(null)}
          onSubmit={(to, amount) => w.sendEthereum(to, amount)}
          placeholder="0x…"
          hint="The amount is what the address receives. The Ethereum network fee is extra and comes out of this balance."
          quoteFee={(to, amount) => quoteEthereumFee(wallet.hemiAddress, to, amount)}
          feeUnit="ETH"
          feeDecimals={18}
          initialMode="send"
          receive={{
            title: "Receive ETH on Ethereum",
            address: wallet.hemiAddress,
            explorer: `${ETH_EXPLORER}/address/${wallet.hemiAddress}`,
            note: "Native ETH on Ethereum. This is the same address as the Hemi wallet, on Ethereum.",
          }}
        />
      )}
      {sheet === "token" && (
        <TokenSheet initial={tokenAsset} start={tokenMode} onClose={() => setSheet(null)} />
      )}
      {sheet === "swap" && <SwapSheet onClose={() => setSheet(null)} />}
      {(sheet === "stake" || sheet === "stake-rewards") && (
        <StakeSheet initialMode={sheet === "stake-rewards" ? "rewards" : "lock"} focus={stakeFocus} onClose={closeStake} />
      )}
      {(sheet === "pool" || sheet === "rewards") && (
        <PoolSheet initialMode={sheet === "rewards" ? "rewards" : "deposit"} onClose={closePool} />
      )}
      {sheet === "position" && managed && (
        <PositionSheet position={managed} initialMode={managedMode} onClose={closePosition} />
      )}
      {sheet === "phrase" && <Phrase onClose={() => setSheet(null)} />}
      {sheet === "passkey" && <EnablePasskey onClose={() => setSheet(null)} />}
      {sheet === "2fa" && <Enable2fa onClose={() => setSheet(null)} />}
    </div>
  );
}

async function writeClipboard(value: string) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const area = document.createElement("textarea");
    area.value = value;
    area.readOnly = true;
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) throw new Error("copy failed");
  }
}

function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      className="addr copy"
      type="button"
      onClick={() => {
        void writeClipboard(address).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        }).catch(() => setCopied(false));
      }}
    >
      {address}
      <small>{copied ? "Copied" : "Copy"}</small>
    </button>
  );
}

function RowBody({
  icon,
  ticker,
  detail,
  amount,
  unit,
  usd,
}: {
  icon: string;
  ticker: string;
  detail: string;
  amount: string;
  unit: string;
  usd?: string | null;
}) {
  return (
    <>
      <img className="coin" src={icon} alt="" />
      <span>
        <b>{ticker}</b>
        <small>{detail}</small>
      </span>
      <span className="amt">
        {amount}
        <span>{unit}</span>
        {usd ? <span className="usd">{usd}</span> : null}
      </span>
    </>
  );
}

function AssetRow({
  onClick,
  ...row
}: {
  icon: string;
  ticker: string;
  detail: string;
  amount: string;
  unit: string;
  usd?: string | null;
  onClick?: () => void;
}) {
  if (onClick) {
    return (
      <button className="card asset" type="button" onClick={onClick}>
        <RowBody {...row} />
      </button>
    );
  }
  return (
    <div className="card asset">
      <RowBody {...row} />
    </div>
  );
}

function Holding({
  onClick,
  ...row
}: {
  icon: string;
  ticker: string;
  detail: string;
  amount: string;
  unit: string;
  usd?: string | null;
  onClick: () => void;
}) {
  return (
    <button className="holding" type="button" onClick={onClick}>
      <RowBody {...row} />
    </button>
  );
}

function lockStatus(position: StakePosition, nowSec: number): string {
  if (position.expired) return "Unlocked";
  if (position.end <= 0) return "Unlocks —";
  const longest = stakeExtensions(nowSec, position.end).length === 0;
  const text = `Unlocks ${formatWhen(position.end * 1000)} · ${formatLockRemain(position.end)}`;
  return longest ? `${text} · Longest lock` : text;
}

function StakeCard({
  positions,
  error,
  onRewards,
  onManage,
}: {
  positions: StakePosition[] | null;
  error: string | null;
  onRewards: () => void;
  onManage: (tokenId: string, action: "add" | "extend") => void;
}) {
  const book = usePrices(stakeRewardTokens(positions));
  const rows = positions ?? [];
  const nowSec = Math.floor(Date.now() / 1000);

  return (
    <section className="card stake-home">
      <div className="kicker"><span>Staked HEMI</span></div>
      {positions == null && !error && <p className="fine">Loading positions…</p>}
      {error && <p className="fine">{error}</p>}
      {positions != null && rows.length === 0 && (
        <p className="fine">No staked HEMI in this wallet yet.</p>
      )}
      <div className="lp-list">
        {rows.map((position) => {
          const lockedUsd = stakeLockedUsd(position, book);
          const rewardUsd = stakeRewardsUsd(position.rewards, book);
          return (
            <div className="lp-pos" key={position.tokenId}>
              <b>{formatUnits(position.amount, 18)} HEMI</b>
              {lockedUsd && <span className="usd">{lockedUsd}</span>}
              <small>
                {position.weight == null ? "Weight unavailable" : `${formatUnits(position.weight, 18)} veHEMI`}
                {" · "}
                {lockStatus(position, nowSec)}
              </small>
              <span>{stakeRewardLine(position)}</span>
              {rewardUsd && <span className="usd">{rewardUsd}</span>}
              {!position.expired && (
                <div className="actions">
                  <button className="ghost" type="button" onClick={() => onManage(position.tokenId, "add")}>Add HEMI</button>
                  {stakeExtensions(nowSec, position.end).length > 0 && (
                    <button className="ghost" type="button" onClick={() => onManage(position.tokenId, "extend")}>Add time</button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="actions">
        <button className="ghost" type="button" onClick={onRewards}>Rewards</button>
      </div>
    </section>
  );
}

function LiquidityCard({
  owner,
  snapshot,
  error,
  reloadKey,
  onRewards,
  onOpen,
}: {
  owner: string;
  snapshot: LpRewardSnapshot | null;
  error: string | null;
  reloadKey: number;
  onRewards: () => void;
  onOpen: (position: LpPosition, mode: "add" | "withdraw") => void;
}) {
  const book = useWallet().prices;

  const positions = snapshot?.positions ?? [];
  const merkl = useMerklRewards(owner, reloadKey);
  const noGas = useWallet().balances.ethWei === 0n;
  const poolCounts = new Map<string, number>();
  for (const position of positions) {
    const pool = poolById(position.poolId)?.pool.toLowerCase();
    if (!pool) continue;
    poolCounts.set(pool, (poolCounts.get(pool) ?? 0) + 1);
  }

  return (
    <section className="card liquidity">
      <div className="kicker"><span>Liquidity</span></div>
      {snapshot == null && !error && <p className="fine">Loading positions…</p>}
      {error && <p className="fine">{error}</p>}
      {snapshot != null && positions.length === 0 && (
        <p className="fine">No liquidity positions in this wallet yet.</p>
      )}
      {snapshot?.truncated && <p className="fine">Showing the first 30 positions on each venue.</p>}
      {merkl.data && !merkl.data.rewardsReady && positions.length > 0 && (
        <p className="fine">Merkl rewards did not load.</p>
      )}
      <div className="lp-list">
        {positions.map((position) => {
          const sizeUsd = positionUsdLine(position, book, "size");
          const feeUsd = positionUsdLine(position, book, "fees");
          const pool = poolById(position.poolId)?.pool ?? null;
          const id = `${position.venue}-${position.tokenId}`;
          return (
          <div className="lp-pos" key={id}>
            <b>{position.pairLabel}{position.feeLabel ? ` · ${position.feeLabel}` : ""}</b>
            <small>{position.venueLabel} · {position.inRange ? "In range" : "Out of range"}</small>
            <small>{position.lowerPrice} – {position.upperPrice} {position.priceUnit}</small>
            <small>{positionSizeLine(position)}</small>
            {sizeUsd && <span className="usd">{sizeUsd}</span>}
            <span>{positionFeeLine(position)}</span>
            {feeUsd && <span className="usd">{feeUsd}</span>}
            <MerklOnPosition
              id={id}
              pool={pool}
              inRange={position.inRange}
              shared={(poolCounts.get(pool?.toLowerCase() ?? "") ?? 0) > 1}
              merkl={merkl}
              noGas={noGas}
            />
            <div className="actions">
              <button className="ghost" type="button" onClick={() => onOpen(position, "add")}>Add</button>
              <button className="ghost" type="button" onClick={() => onOpen(position, "withdraw")}>Withdraw</button>
            </div>
          </div>
          );
        })}
      </div>
      <div className="actions">
        <button className="ghost" type="button" onClick={onRewards}>Rewards</button>
      </div>
    </section>
  );
}

function Receive({ onClose, initial }: { onClose: () => void; initial: "btc" | "hemi" }) {
  const wallet = useWallet().wallet!;
  const [which, setWhich] = useState<"btc" | "eth" | "hemi">(initial === "btc" ? "btc" : "hemi");
  const address = which === "btc" ? wallet.btcAddress : wallet.hemiAddress;
  const card = which === "btc"
    ? {
        title: "Receive Bitcoin",
        address,
        explorer: btcAddressUrl(address),
        note: "Native segwit Bitcoin. Do not send hemiBTC here.",
      }
    : which === "eth"
      ? {
          title: "Receive ETH on Ethereum",
          address,
          explorer: `${ETH_EXPLORER}/address/${address}`,
          note: "Native ETH on Ethereum. This is the same address as the Hemi wallet, on Ethereum.",
        }
      : {
          title: "Receive on Hemi",
          address,
          explorer: hemiAddressUrl(address),
          note: "This address receives ETH, HEMI, VUSD, Vetro, WBTC, USDT, and hemiBTC on Hemi.",
        };

  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>{card.title}</h2>
        <div className="choice">
          <button className={which === "btc" ? "on" : ""} type="button" onClick={() => setWhich("btc")}>Bitcoin</button>
          <button className={which === "eth" ? "on" : ""} type="button" onClick={() => setWhich("eth")}>Ethereum</button>
          <button className={which === "hemi" ? "on" : ""} type="button" onClick={() => setWhich("hemi")}>Hemi</button>
        </div>
        <AddressCard address={card.address} explorer={card.explorer} note={card.note} />
        <button className="ghost wide" type="button" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

function AddressCard({ address, explorer, note }: { address: string; explorer: string; note: string }) {
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    setCopied(false);
    void QRCode.toDataURL(address, { margin: 1, width: 360, color: { dark: "#111111", light: "#ffffff" } }).then((url) => {
      if (live) setQr(url);
    });
    return () => {
      live = false;
    };
  }, [address]);

  return (
    <>
      {qr && <img className="qr" src={qr} alt="" />}
      <div className="addr">{address}</div>
      <div className="actions">
        <button
          className="btn primary"
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(address);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <a className="btn" href={explorer} target="_blank" rel="noreferrer">Explorer</a>
      </div>
      <p className="foot">{note}</p>
    </>
  );
}

function TokenSheet({
  initial,
  start,
  onClose,
}: {
  initial: HemiAsset;
  start: "send" | "receive";
  onClose: () => void;
}) {
  const w = useWallet();
  const wallet = w.wallet!;
  const [asset, setAsset] = useState<HemiAsset>(initial);
  const b = w.balances;
  const options: { id: HemiAsset; label: string }[] = [
    { id: "eth", label: "ETH" },
    { id: "hemi", label: b.hemiTokenSymbol },
    { id: "vusd", label: b.vusdSymbol },
    { id: "vetro", label: "Vetro" },
    { id: "usdt", label: "USDT" },
    { id: "wbtc", label: "WBTC" },
    { id: "hemibtc", label: b.symbol },
  ];
  const specs: Record<HemiAsset, {
    title: string;
    receiveTitle: string;
    unit: string;
    decimals: number;
    balance: bigint | null;
    gas?: bigint | null;
    token?: string;
    hint: string;
    note: string;
    submit: (to: string, amount: bigint) => Promise<string>;
  }> = {
    eth: {
      title: "Send ETH on Hemi",
      receiveTitle: "Receive ETH on Hemi",
      unit: "ETH",
      decimals: 18,
      balance: b.ethWei,
      hint: "The network fee comes out of this Hemi ETH balance.",
      note: "Send Hemi-network ETH to this address. It also receives HEMI, VUSD, Vetro, WBTC, USDT, and hemiBTC.",
      submit: w.sendEth,
    },
    hemi: {
      title: `Send ${b.hemiTokenSymbol}`,
      receiveTitle: `Receive ${b.hemiTokenSymbol}`,
      unit: b.hemiTokenSymbol,
      decimals: b.hemiTokenDecimals,
      balance: b.hemiTokenWei,
      gas: b.ethWei,
      token: HEMI_TOKEN,
      hint: "HEMI moves on Hemi. Gas is paid in Hemi ETH.",
      note: "HEMI on Hemi. This address is not an Ethereum token contract.",
      submit: w.sendHemiToken,
    },
    vusd: {
      title: `Send ${b.vusdSymbol}`,
      receiveTitle: `Receive ${b.vusdSymbol}`,
      unit: b.vusdSymbol,
      decimals: b.vusdDecimals,
      balance: b.vusdWei,
      gas: b.ethWei,
      token: VUSD,
      hint: "VUSD moves on Hemi. Gas is paid in Hemi ETH.",
      note: "Official VUSD on Hemi. This is not Vetro USD.",
      submit: w.sendVusd,
    },
    vetro: {
      title: "Send Vetro",
      receiveTitle: "Receive Vetro",
      unit: "Vetro",
      decimals: 18,
      balance: b.vetroWei,
      gas: b.ethWei,
      token: VETRO_USD,
      hint: "Vetro USD moves on Hemi. Gas is paid in Hemi ETH. This is not VUSD.",
      note: "Vetro USD on Hemi. The contract symbol is VUSD, and it is a different token from the VUSD row.",
      submit: w.sendVetro,
    },
    usdt: {
      title: "Send USDT",
      receiveTitle: "Receive USDT",
      unit: "USDT",
      decimals: 6,
      balance: b.usdtRaw,
      gas: b.ethWei,
      token: USDT,
      hint: "USDT moves on Hemi. Gas is paid in Hemi ETH.",
      note: "USDT on Hemi. 6 decimals.",
      submit: w.sendUsdt,
    },
    wbtc: {
      title: "Send WBTC",
      receiveTitle: "Receive WBTC",
      unit: "WBTC",
      decimals: 8,
      balance: b.wbtcSats,
      gas: b.ethWei,
      token: WBTC,
      hint: "WBTC moves on Hemi. Gas is paid in Hemi ETH. This is not hemiBTC or native Bitcoin.",
      note: "Wrapped BTC on Hemi. Send WBTC to this address. This is not hemiBTC or native Bitcoin.",
      submit: w.sendWbtc,
    },
    hemibtc: {
      title: `Send ${b.symbol}`,
      receiveTitle: `Receive ${b.symbol}`,
      unit: b.symbol,
      decimals: b.decimals,
      balance: b.hemiSats,
      gas: b.ethWei,
      token: HEMIBTC,
      hint: "hemiBTC moves on Hemi. Gas is paid in Hemi ETH. Do not paste a Bitcoin address here.",
      note: "hemiBTC on Hemi. Do not send native Bitcoin to this address.",
      submit: w.sendHemi,
    },
  };
  const spec = specs[asset];

  return (
    <Send
      title={spec.title}
      unit={spec.unit}
      decimals={spec.decimals}
      balance={spec.balance}
      placeholder="0x…"
      gas={spec.gas}
      hint={spec.hint}
      quoteFee={(to, amount) => spec.token
        ? quoteHemiTokenFee(wallet.hemiAddress, spec.token, to, amount)
        : quoteHemiNativeFee(wallet.hemiAddress, to, amount)}
      feeUnit="ETH"
      feeDecimals={18}
      onClose={onClose}
      onSubmit={(to, amount) => spec.submit(to, amount)}
      initialMode={start}
      assets={options}
      asset={asset}
      onAsset={setAsset}
      receive={{
        title: spec.receiveTitle,
        address: wallet.hemiAddress,
        explorer: hemiAddressUrl(wallet.hemiAddress),
        note: spec.note,
      }}
    />
  );
}

function Send({
  title,
  unit,
  decimals,
  balance,
  placeholder,
  gas,
  hint,
  quoteFee,
  feeUnit,
  feeDecimals,
  onClose,
  onSubmit,
  initialMode = "send",
  assets,
  asset,
  onAsset,
  receive,
}: {
  title: string;
  unit: string;
  decimals: number;
  balance: bigint | null;
  placeholder: string;
  gas?: bigint | null;
  hint?: string;
  quoteFee?: (to: string, amount: bigint) => Promise<bigint | null>;
  feeUnit?: string;
  feeDecimals?: number;
  onClose: () => void;
  onSubmit: (to: string, amount: bigint) => Promise<string>;
  initialMode?: "send" | "receive";
  assets?: { id: HemiAsset; label: string }[];
  asset?: HemiAsset;
  onAsset?: (asset: HemiAsset) => void;
  receive?: { title: string; address: string; explorer: string; note: string };
}) {
  const [mode, setMode] = useState<"send" | "receive">(initialMode);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  const [fee, setFee] = useState<bigint | null>(null);
  const [feePending, setFeePending] = useState(false);
  const quoteRef = useRef(quoteFee);
  quoteRef.current = quoteFee;
  const parsed = parseUnits(amount, decimals);
  const blocked = gas != null && gas === 0n;
  const feeScale = feeDecimals ?? decimals;

  useEffect(() => {
    setAmount("");
    setError(null);
    setSure(false);
  }, [unit, decimals]);

  useEffect(() => {
    const quote = quoteRef.current;
    if (!quote || parsed == null || parsed <= 0n || to.trim().length < 6) {
      setFee(null);
      setFeePending(false);
      return;
    }
    let cancel = false;
    setFee(null);
    setFeePending(true);
    const timer = window.setTimeout(() => {
      void quote(to.trim(), parsed).then(
        (next) => {
          if (cancel) return;
          setFee(next);
          setFeePending(false);
        },
        () => {
          if (cancel) return;
          setFee(null);
          setFeePending(false);
        },
      );
    }, 400);
    return () => {
      cancel = true;
      window.clearTimeout(timer);
    };
  }, [to, parsed, unit, decimals]);

  return (
    <div className="sheet-back" onClick={onClose}>
      <form
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (parsed == null || parsed <= 0n) {
            setError(`Enter an amount with up to ${decimals} decimals.`);
            return;
          }
          if (balance != null && parsed > balance) {
            setError(`Only ${formatUnits(balance, decimals)} ${unit} is in this wallet.`);
            return;
          }
          setBusy(true);
          setError(null);
          void onSubmit(to.trim(), parsed)
            .then(() => onClose())
            .catch((err) => setError(messageOf(err)))
            .finally(() => setBusy(false));
        }}
      >
        <h2>{mode === "receive" && receive ? receive.title : title}</h2>
        {assets && onAsset && (
          <div className="choice">
            {assets.map((item) => (
              <button key={item.id} className={item.id === asset ? "on" : ""} type="button" onClick={() => onAsset(item.id)}>
                {item.label}
              </button>
            ))}
          </div>
        )}
        {receive && (
          <div className="choice">
            <button className={mode === "send" ? "on" : ""} type="button" onClick={() => setMode("send")}>Send</button>
            <button className={mode === "receive" ? "on" : ""} type="button" onClick={() => setMode("receive")}>Receive</button>
          </div>
        )}
        {mode === "receive" && receive ? (
          <AddressCard address={receive.address} explorer={receive.explorer} note={receive.note} />
        ) : (
        <>
        <label className="field">
          <span>To</span>
          <input value={to} placeholder={placeholder} onChange={(e) => setTo(e.target.value)} spellCheck={false} />
        </label>
        <label className="field">
          <span>Amount · {balance == null ? "…" : `${formatUnits(balance, decimals)} free`}</span>
          <input inputMode="decimal" value={amount} placeholder="0.00" onChange={(e) => setAmount(e.target.value)} />
        </label>
        {hint && <p className="hint">{hint}</p>}
        {quoteFee && parsed != null && parsed > 0n && (
          <div className="rowline">
            <span>Network fee</span>
            <b>{to.trim().length < 6 || feePending ? "…" : fee == null ? "—" : `${formatUnits(fee, feeScale)} ${feeUnit ?? unit}`}</b>
          </div>
        )}
        {blocked && <p className="fine">This Hemi address has no ETH for gas. Receive a small amount of ETH first.</p>}
        <label className="check">
          <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
          <span>Broadcast this on mainnet.</span>
        </label>
        {error && <p className="banner bad">{error}</p>}
        <button className="btn primary wide" disabled={busy || blocked || !sure} type="submit">
          {busy ? "Sending…" : "Send"}
        </button>
        </>
        )}
      </form>
    </div>
  );
}

function EnablePasskey({ onClose }: { onClose: () => void }) {
  const w = useWallet();
  const [twoFactor, setTwoFactor] = useState(w.auth.hasPassword);
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const known = w.auth.hasPassword;
  const native = nativeShell();
  const passwordReady = !twoFactor || (known
    ? password.length > 0
    : native ? passwordMeetsBar(password) : password.length >= 8);

  return (
    <div className="sheet-back" onClick={onClose}>
      <form
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (twoFactor && !known && !passwordReady) {
            setError(native ? NATIVE_PASSWORD_ERROR : "Password must be at least 8 characters.");
            return;
          }
          if (twoFactor && known && !password) {
            setError("Enter the wallet password.");
            return;
          }
          if (twoFactor && !known && password !== again) {
            setError("Passwords do not match.");
            return;
          }
          setBusy(true);
          setError(null);
          void w.enablePasskey({ twoFactor, password: twoFactor ? password : undefined })
            .then(() => onClose())
            .catch((err) => setError(messageOf(err)))
            .finally(() => setBusy(false));
        }}
      >
        <h2>Enable passkey</h2>
        <p className="hint">
          {native
            ? "The phone asks for a fingerprint or face. That becomes the unlock."
            : "The browser asks you to create a passkey. That becomes the unlock."}
        </p>
        <label className="check">
          <input type="checkbox" checked={twoFactor} onChange={(e) => setTwoFactor(e.target.checked)} />
          <span>{known ? "Keep the password as 2FA" : "Also require a password (2FA)"}</span>
        </label>
        {twoFactor && (
          <>
            <label className="field">
              <span>{known ? "Current password" : "Password"}</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={known ? "current-password" : "new-password"} />
            </label>
            {!known && (
              <label className="field">
                <span>Confirm password</span>
                <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
              </label>
            )}
            {native && !known && <PasswordRules password={password} />}
          </>
        )}
        {error && <p className="banner bad">{error}</p>}
        <button className="btn primary wide" disabled={busy || !passwordReady} type="submit">
          {busy ? "Waiting for passkey…" : twoFactor ? "Enable passkey with 2FA" : "Enable passkey"}
        </button>
      </form>
    </div>
  );
}

function Enable2fa({ onClose }: { onClose: () => void }) {
  const w = useWallet();
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const native = nativeShell();
  const passwordReady = native ? passwordMeetsBar(password) : password.length >= 8;

  return (
    <div className="sheet-back" onClick={onClose}>
      <form
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!passwordReady) {
            setError(native ? NATIVE_PASSWORD_ERROR : "Password must be at least 8 characters.");
            return;
          }
          if (password !== again) {
            setError("Passwords do not match.");
            return;
          }
          setBusy(true);
          setError(null);
          void w.enablePassword2fa(password)
            .then(() => onClose())
            .catch((err) => setError(messageOf(err)))
            .finally(() => setBusy(false));
        }}
      >
        <h2>Password 2FA</h2>
        <p className="hint">After this, unlock asks for the password and then the passkey.</p>
        <label className="field">
          <span>Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </label>
        <label className="field">
          <span>Confirm password</span>
          <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
        </label>
        {native && <PasswordRules password={password} />}
        {error && <p className="banner bad">{error}</p>}
        <button className="btn primary wide" disabled={busy || !passwordReady} type="submit">
          {busy ? "Saving…" : "Turn on 2FA"}
        </button>
      </form>
    </div>
  );
}

function Phrase({ onClose }: { onClose: () => void }) {
  const [phrase, setPhrase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>Recovery phrase</h2>
        <p className="fine">Anyone with these words can move the Bitcoin, the hemiBTC, the HEMI, the VUSD, and the ETH.</p>
        {phrase ? (
          <ol className="words">
            {phrase.split(" ").map((word, index) => (
              <li key={`${word}-${index}`}>
                <i>{index + 1}</i>
                {word}
              </li>
            ))}
          </ol>
        ) : (
          <button
            className="btn primary wide"
            type="button"
            onClick={() => {
              try {
                setPhrase(exportPhrase());
                setError(null);
              } catch (err) {
                setError(messageOf(err));
              }
            }}
          >
            Show phrase
          </button>
        )}
        {error && <p className="banner bad">{error}</p>}
        <button className="ghost wide" style={{ marginTop: 8 }} type="button" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
