import { useEffect, useState } from "react";
import hemiEthIcon from "../assets/hemieth.svg";
import hemiIcon from "../assets/hemi.svg";
import hemiBtcIcon from "../assets/hemibtc.svg";
import vusdIcon from "../assets/vusd.svg";
import vetroIcon from "../assets/vetro.svg";
import wbtcIcon from "../assets/wbtc.svg";
import { formatUnits, parseUnits } from "../lib/format";
import { messageOf } from "../lib/errors";
import {
  positionFeeLine,
  positionSizeLine,
  positionUsdLine,
  readLpPosition,
  type LpPosition,
} from "../lib/lpRewards";
import {
  assetSpec,
  depositSides,
  formatSqrtPrice,
  maxDeposit,
  poolById,
  poolNeedsApproval,
  quoteDeposit,
  quoteWithdraw,
  readPoolMarket,
  type PoolAsset,
  type PoolInfo,
  type PoolMarket,
  type PoolQuote,
  type PoolSide,
  type WithdrawQuote,
} from "../lib/pool";
import { ETH_GAS_RESERVE } from "../lib/swap";
import { useWallet } from "../state";

const ICONS: Record<PoolAsset, string> = {
  eth: hemiEthIcon,
  hemi: hemiIcon,
  vusd: vusdIcon,
  hemibtc: hemiBtcIcon,
  vetro: vetroIcon,
  wbtc: wbtcIcon,
};

const SHARES = [25, 50, 75, 100] as const;

type Mode = "add" | "withdraw";

export function PositionSheet({
  position,
  initialMode,
  onClose,
}: {
  position: LpPosition;
  initialMode: Mode;
  onClose: () => void;
}) {
  const w = useWallet();
  const wallet = w.wallet!;
  const [mode, setMode] = useState<Mode>(initialMode);
  const [source, setSource] = useState(position);
  const [gone, setGone] = useState(false);
  const [market, setMarket] = useState<PoolMarket | null>(null);
  const [driver, setDriver] = useState<PoolSide>("token0");
  const [text0, setText0] = useState("");
  const [text1, setText1] = useState("");
  const [quote, setQuote] = useState<PoolQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [needsApproval, setNeedsApproval] = useState(false);
  const [percent, setPercent] = useState(100);
  const [withdrawQuote, setWithdrawQuote] = useState<WithdrawQuote | null>(null);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState<"approve" | "add" | "withdraw" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pool = poolById(source.poolId);
  const spec0 = pool ? assetSpec(pool.token0) : null;
  const spec1 = pool ? assetSpec(pool.token1) : null;
  const typed = driver === "token0" ? text0 : text1;
  const parsed = spec0 && spec1 ? parseUnits(typed, driver === "token0" ? spec0.decimals : spec1.decimals) : null;
  const free0 = pool ? freeOf(pool.token0, w.balances) : null;
  const free1 = pool ? freeOf(pool.token1, w.balances) : null;
  const sides = market && pool ? depositSides(market.sqrtPriceX96, { tickLower: source.tickLower, tickUpper: source.tickUpper }) : "both";
  const noGas = w.balances.ethWei === 0n;
  const over0 = quote != null && free0 != null && quote.amount0 > free0;
  const over1 = quote != null && free1 != null && quote.amount1 > free1;
  const addReady = mode === "add" && pool != null && spec0 != null && spec1 != null && busy == null && !gone && !noGas && !over0 && !over1 && sure && quote != null && parsed != null && parsed > 0n
    && (driver === "token0" ? quote.amount0 : quote.amount1) === parsed;
  const withdrawReady = mode === "withdraw" && busy == null && !gone && !noGas && sure && withdrawQuote != null && source.liquidity > 0n;

  useEffect(() => {
    let cancel = false;
    void readLpPosition(wallet.hemiAddress, position.venue, BigInt(position.tokenId)).then(
      (next) => {
        if (cancel) return;
        if (!next) setGone(true);
        else {
          setGone(false);
          setSource(next);
        }
      },
      (err: unknown) => { if (!cancel) setError(messageOf(err)); },
    );
    return () => { cancel = true; };
  }, [wallet.hemiAddress, position.venue, position.tokenId]);

  useEffect(() => {
    if (!pool) return;
    let cancel = false;
    setMarket(null);
    void readPoolMarket(pool).then(
      (next) => { if (!cancel) setMarket(next); },
      (err: unknown) => { if (!cancel) setError(messageOf(err)); },
    );
    return () => { cancel = true; };
  }, [pool]);

  useEffect(() => {
    if (mode !== "add" || !pool || !spec0 || !spec1) return;
    setSure(false);
    setQuote(null);
    setError(null);
    setNeedsApproval(false);
    if (driver === "token0") setText1("");
    else setText0("");
    if (gone || parsed == null || parsed <= 0n) {
      setLoading(false);
      return;
    }
    const ticks = { tickLower: source.tickLower, tickUpper: source.tickUpper };
    let cancel = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void quoteDeposit(pool, driver, parsed, ticks).then(
        (next) => {
          if (cancel) return;
          setQuote(next);
          setLoading(false);
          const other = driver === "token0" ? next.amount1 : next.amount0;
          const decimals = driver === "token0" ? spec1.decimals : spec0.decimals;
          if (driver === "token0") setText1(formatUnits(other, decimals));
          else setText0(formatUnits(other, decimals));
        },
        (err: unknown) => {
          if (cancel) return;
          setQuote(null);
          setLoading(false);
          setError(messageOf(err));
        },
      );
    }, 350);
    return () => {
      cancel = true;
      window.clearTimeout(timer);
    };
  }, [mode, gone, pool, driver, parsed, source.tickLower, source.tickUpper, spec0, spec1]);

  useEffect(() => {
    if (!pool || !quote || mode !== "add") {
      setNeedsApproval(false);
      return;
    }
    let cancel = false;
    void poolNeedsApproval(wallet.hemiAddress, pool, quote.amount0, quote.amount1)
      .then((needed) => { if (!cancel) setNeedsApproval(needed); })
      .catch(() => { if (!cancel) setNeedsApproval(false); });
    return () => { cancel = true; };
  }, [pool, quote, mode, wallet.hemiAddress]);

  useEffect(() => {
    if (mode !== "withdraw") return;
    setSure(false);
    setError(null);
    if (gone || !market) {
      setWithdrawQuote(null);
      return;
    }
    try {
      setWithdrawQuote(quoteWithdraw(
        market.sqrtPriceX96,
        { tickLower: source.tickLower, tickUpper: source.tickUpper },
        source.liquidity,
        percent,
      ));
    } catch (err) {
      setWithdrawQuote(null);
      setError(messageOf(err));
    }
  }, [mode, gone, market, percent, source.liquidity, source.tickLower, source.tickUpper]);

  function setView(next: Mode) {
    setMode(next);
    setSure(false);
    setError(null);
  }

  function edit(side: PoolSide, value: string) {
    setDriver(side);
    if (side === "token0") setText0(value);
    else setText1(value);
  }

  function fill(side: PoolSide) {
    if (!pool || free0 == null || free1 == null) return;
    setError(null);
    void maxDeposit(pool, side, free0, free1, { tickLower: source.tickLower, tickUpper: source.tickUpper }).then(
      (fitted) => {
        const amount = side === "token0" ? fitted.amount0 : fitted.amount1;
        const decimals = side === "token0" ? spec0?.decimals ?? 18 : spec1?.decimals ?? 18;
        edit(side, formatUnits(amount, decimals));
      },
      (err: unknown) => setError(messageOf(err)),
    );
  }

  function pickShare(next: number) {
    setPercent(next);
    setSure(false);
    setError(null);
  }

  const addLabel = busy === "approve"
    ? "Approving…"
    : busy === "add"
      ? "Adding…"
      : gone
        ? "Position unavailable"
        : parsed == null || parsed <= 0n
          ? "Enter an amount"
          : noGas
            ? "Need ETH for gas"
            : !market
              ? "Reading the pool…"
              : loading
                ? "Reading the pool…"
                : !quote
                  ? "Enter an amount"
                  : over0 || over1
                    ? "Not enough in this wallet"
                    : !sure
                      ? "Confirm on mainnet"
                      : needsApproval
                        ? "Approve and add"
                        : "Add to position";

  const withdrawLabel = busy === "withdraw"
    ? "Withdrawing…"
    : gone
      ? "Position unavailable"
      : source.liquidity <= 0n
        ? "Nothing to withdraw"
        : noGas
          ? "Need ETH for gas"
          : !market || !withdrawQuote
            ? "Reading the pool…"
            : !sure
              ? "Confirm on mainnet"
              : percent === 100
                ? "Withdraw all"
                : `Withdraw ${percent}%`;

  return (
    <div className="sheet-back" onClick={onClose}>
      <form
        className="sheet swap-sheet"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!pool || gone) return;
          if (mode === "add") {
            if (!addReady || !quote || parsed == null || parsed <= 0n) return;
            if ((driver === "token0" ? quote.amount0 : quote.amount1) !== parsed) {
              setError("Wait for the amounts to update.");
              return;
            }
            if (over0 || over1) {
              setError("Not enough in this wallet.");
              return;
            }
            setBusy("add");
            setError(null);
            void w.addToPosition({
              poolId: pool.id,
              tokenId: BigInt(source.tokenId),
              driver,
              amount: parsed,
              amount0: quote.amount0,
              amount1: quote.amount1,
              tickLower: source.tickLower,
              tickUpper: source.tickUpper,
            }, (phase) => setBusy(phase === "approve" ? "approve" : "add"))
              .then(() => onClose())
              .catch((err: unknown) => setError(messageOf(err)))
              .finally(() => setBusy(null));
            return;
          }
          if (!withdrawReady || !withdrawQuote) return;
          setBusy("withdraw");
          setError(null);
          void w.withdrawLiquidity({
            poolId: source.poolId,
            venue: source.venue,
            tokenId: BigInt(source.tokenId),
            percent: withdrawQuote.percent,
            liquidity: withdrawQuote.liquidity,
            liquidityOut: withdrawQuote.liquidityOut,
            amount0: withdrawQuote.amount0,
            amount1: withdrawQuote.amount1,
            min0: withdrawQuote.min0,
            min1: withdrawQuote.min1,
            tickLower: source.tickLower,
            tickUpper: source.tickUpper,
          })
            .then(() => onClose())
            .catch((err: unknown) => setError(messageOf(err)))
            .finally(() => setBusy(null));
        }}
      >
        <div className="swap-top">
          <h2>{mode === "withdraw" ? "Withdraw" : "Add to position"}</h2>
          <span className="swap-spot">{source.venueLabel}</span>
        </div>
        <div className="rowline">
          <span>View</span>
          <div className="swap-routes">
            <button type="button" className={mode === "add" ? "on" : ""} onClick={() => setView("add")}>Add</button>
            <button type="button" className={mode === "withdraw" ? "on" : ""} onClick={() => setView("withdraw")}>Withdraw</button>
          </div>
        </div>

        {gone || !pool || !spec0 || !spec1 ? (
          <p className="empty">This position is no longer in this wallet.</p>
        ) : (
          <>
            <div className="swap-pair">
              <span>{source.pairLabel}{source.feeLabel ? ` · ${source.feeLabel}` : ""}</span>
              <b>{market ? `1 ${spec0.label} = ${formatSqrtPrice(market.sqrtPriceX96, spec0.decimals, spec1.decimals)} ${spec1.label}` : "Reading the pool…"}</b>
            </div>
            <div className="rowline">
              <span>Range</span>
              <b>{source.lowerPrice} – {source.upperPrice}</b>
            </div>
            <div className="rowline">
              <span>{source.priceUnit}</span>
              <b>{source.inRange ? "In range" : "Out of range"}</b>
            </div>
            <p className="fine">{positionSizeLine(source)}. Fees {positionFeeLine(source)}.</p>
            {positionUsdLine(source, w.prices, "size") && <p className="fine">{positionUsdLine(source, w.prices, "size")}</p>}
            {positionUsdLine(source, w.prices, "fees") && <p className="fine">Fees {positionUsdLine(source, w.prices, "fees")}.</p>}

            {mode === "add" ? (
              <>
                <p className="fine">This adds to the same position. The price range stays the same.</p>
                <div className="pool-stack">
                  <AmountPanel
                    label={spec0.label}
                    icon={ICONS[pool.token0]}
                    text={text0}
                    free={free0}
                    decimals={spec0.decimals}
                    held={pool.token0 === "eth" ? heldEth(w.balances.ethWei, free0) : 0n}
                    showMax={sides !== "token1" && free0 != null && free0 > 0n}
                    onChange={(value) => edit("token0", value)}
                    onMax={() => fill("token0")}
                  />
                  <AmountPanel
                    label={spec1.label}
                    icon={ICONS[pool.token1]}
                    text={text1}
                    free={free1}
                    decimals={spec1.decimals}
                    held={pool.token1 === "eth" ? heldEth(w.balances.ethWei, free1) : 0n}
                    showMax={sides !== "token0" && free1 != null && free1 > 0n}
                    onChange={(value) => edit("token1", value)}
                    onMax={() => fill("token1")}
                  />
                </div>
                <p className="fine">
                  {sides === "token0"
                    ? `The price is below this range, so adding takes only ${spec0.label}.`
                    : sides === "token1"
                      ? `The price is above this range, so adding takes only ${spec1.label}.`
                      : "Both tokens go in while the price stays inside the range."}
                </p>
                {loading && <p className="fine">Reading the pool price…</p>}
                {(over0 || over1) && quote && <p className="fine">{shortfall(pool, quote, free0, free1)}</p>}
                {quote && (
                  <label className="check">
                    <input type="checkbox" checked={sure} onChange={(event) => setSure(event.target.checked)} />
                    <span>{addClause(quote, spec0.label, spec1.label, spec0.decimals, spec1.decimals)}</span>
                  </label>
                )}
                {noGas && <p className="fine">This Hemi address has no ETH for gas. Receive a small amount of ETH first.</p>}
                {error && <p className="banner bad">{error}</p>}
                <button className={addReady || busy != null ? "btn primary wide" : "btn wide swap-wait"} type="submit" disabled={!addReady}>
                  {addLabel}
                </button>
              </>
            ) : (
              <>
                <div className="rowline">
                  <span>Share</span>
                  <div className="swap-routes">
                    {SHARES.map((share) => (
                      <button key={share} type="button" className={percent === share ? "on" : ""} onClick={() => pickShare(share)}>
                        {share === 100 ? "All" : `${share}%`}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="rowline">
                  <span>{spec0.label}</span>
                  <b>{withdrawQuote ? formatUnits(withdrawQuote.amount0, spec0.decimals) : "…"}</b>
                </div>
                <div className="rowline">
                  <span>{spec1.label}</span>
                  <b>{withdrawQuote ? formatUnits(withdrawQuote.amount1, spec1.decimals) : "…"}</b>
                </div>
                <p className="fine">
                  {percent === 100
                    ? "Removing all of it closes the position. Trading fees already earned come out with the tokens."
                    : "That share comes back to this wallet. Trading fees already earned come out too. The rest of the position stays open."}
                </p>
                {source.liquidity <= 0n && <p className="fine">This position has no liquidity left. Trading fees are claimed from Rewards.</p>}
                {withdrawQuote && source.liquidity > 0n && (
                  <label className="check">
                    <input type="checkbox" checked={sure} onChange={(event) => setSure(event.target.checked)} />
                    <span>{withdrawClause(withdrawQuote, spec0.label, spec1.label, spec0.decimals, spec1.decimals)}</span>
                  </label>
                )}
                {noGas && source.liquidity > 0n && <p className="fine">This Hemi address has no ETH for gas. Receive a small amount of ETH first.</p>}
                {error && <p className="banner bad">{error}</p>}
                <button className={withdrawReady || busy != null ? "btn primary wide" : "btn wide swap-wait"} type="submit" disabled={!withdrawReady}>
                  {withdrawLabel}
                </button>
              </>
            )}
          </>
        )}
      </form>
    </div>
  );
}

function AmountPanel({
  label,
  icon,
  text,
  free,
  decimals,
  held,
  showMax,
  onChange,
  onMax,
}: {
  label: string;
  icon: string;
  text: string;
  free: bigint | null;
  decimals: number;
  held: bigint;
  showMax: boolean;
  onChange: (value: string) => void;
  onMax: () => void;
}) {
  return (
    <div className="swap-panel">
      <div className="swap-panel-top">
        <span>{label}</span>
        <div className="swap-bal">
          <span>Available <b>{free == null ? "…" : `${formatUnits(free, decimals)} ${label}`}</b></span>
          {held > 0n && <span className="swap-hold">For gas <b>{formatUnits(held, 18)} ETH</b></span>}
        </div>
      </div>
      <div className="swap-panel-row">
        <input
          inputMode="decimal"
          value={text}
          placeholder="0"
          aria-label={label}
          onChange={(event) => onChange(event.target.value)}
        />
        {showMax && (
          <button className="swap-max" type="button" onClick={onMax}>Max</button>
        )}
        <span className="swap-pill pool-pill"><img src={icon} alt="" />{label}</span>
      </div>
    </div>
  );
}

function freeOf(id: PoolAsset, balances: ReturnType<typeof useWallet>["balances"]): bigint | null {
  const balance = id === "eth" ? balances.ethWei
    : id === "hemi" ? balances.hemiTokenWei
      : id === "vusd" ? balances.vusdWei
        : id === "vetro" ? balances.vetroWei
          : id === "wbtc" ? balances.wbtcSats
            : balances.hemiSats;
  if (balance == null) return null;
  if (id !== "eth") return balance;
  return balance > ETH_GAS_RESERVE ? balance - ETH_GAS_RESERVE : 0n;
}

function heldEth(balance: bigint | null, free: bigint | null): bigint {
  if (balance == null || free == null || balance <= free) return 0n;
  return balance - free;
}

function shortfall(pool: PoolInfo, quote: PoolQuote, free0: bigint | null, free1: bigint | null): string {
  const spec0 = assetSpec(pool.token0);
  const spec1 = assetSpec(pool.token1);
  if (free0 != null && quote.amount0 > free0) {
    return pool.token0 === "eth"
      ? `Only ${formatUnits(free0, 18)} ETH can be added. 0.0003 ETH stays for gas.`
      : `Only ${formatUnits(free0, spec0.decimals)} ${spec0.label} is in this wallet.`;
  }
  if (free1 != null && quote.amount1 > free1) {
    return pool.token1 === "eth"
      ? `Only ${formatUnits(free1, 18)} ETH can be added. 0.0003 ETH stays for gas.`
      : `Only ${formatUnits(free1, spec1.decimals)} ${spec1.label} is in this wallet.`;
  }
  return "Not enough in this wallet.";
}

function listed(amount0: bigint, amount1: bigint, label0: string, label1: string, dec0: number, dec1: number): string {
  const parts = [
    amount0 > 0n ? `${formatUnits(amount0, dec0)} ${label0}` : "",
    amount1 > 0n ? `${formatUnits(amount1, dec1)} ${label1}` : "",
  ].filter(Boolean);
  return parts.join(" and ");
}

function addClause(quote: PoolQuote, label0: string, label1: string, dec0: number, dec1: number): string {
  const used = listed(quote.amount0, quote.amount1, label0, label1, dec0, dec1);
  const mins = listed(quote.min0, quote.min1, label0, label1, dec0, dec1);
  return `Broadcast this on mainnet. It adds up to ${used} to this position. It reverts if the pool takes less than ${mins}.`;
}

function withdrawClause(quote: WithdrawQuote, label0: string, label1: string, dec0: number, dec1: number): string {
  const share = quote.percent === 100 ? "all of this position" : `${quote.percent}% of this position`;
  const got = listed(quote.amount0, quote.amount1, label0, label1, dec0, dec1);
  const mins = listed(quote.min0, quote.min1, label0, label1, dec0, dec1);
  const received = got ? ` About ${got} comes back.` : " The tokens round to less than this wallet can show.";
  const floor = mins ? ` It reverts if the pool returns less than ${mins}.` : "";
  const close = quote.percent === 100 ? " The position is closed." : "";
  return `Broadcast this withdrawal on mainnet. It removes ${share}.${received} Trading fees on the position come out too.${floor}${close}`;
}
