import { useEffect, useMemo, useState } from "react";
import hemiEthIcon from "../assets/hemieth.svg";
import hemiIcon from "../assets/hemi.svg";
import hemiBtcIcon from "../assets/hemibtc.svg";
import vusdIcon from "../assets/vusd.svg";
import vetroIcon from "../assets/vetro.svg";
import wbtcIcon from "../assets/wbtc.svg";
import { formatUnits, parseUnits } from "../lib/format";
import { messageOf } from "../lib/errors";
import { celebrate, pokeBuddy } from "../lib/fx";
import {
  loadLpRewards,
  positionFeeLine,
  type LpPosition,
  type LpRewardSnapshot,
} from "../lib/lpRewards";
import { loadMerklIncentive, type MerklIncentive } from "../lib/merkl";
import { loadPoolPriceSeries } from "../lib/poolChart";
import { estimateFeeApr, loadFeeAprInputs, type FeeAprEstimate, type FeeAprInputs } from "../lib/poolApr";
import {
  DEFAULT_POOL_ID,
  POOLS,
  assetSpec,
  bandRange,
  depositSides,
  formatSqrtPrice,
  formatTickPrice,
  fullRange,
  maxDeposit,
  poolById,
  poolNeedsApproval,
  quoteDeposit,
  readPoolMarket,
  ticksFromPrices,
  type PoolAsset,
  type PoolInfo,
  type PoolMarket,
  type PoolQuote,
  type PoolSide,
  type PoolVenue,
  type TickRange,
} from "../lib/pool";
import { ETH_GAS_RESERVE } from "../lib/swap";
import { useWallet } from "../state";
import { RangeChart } from "./RangeChart";

const ICONS: Record<PoolAsset, string> = {
  eth: hemiEthIcon,
  hemi: hemiIcon,
  vusd: vusdIcon,
  hemibtc: hemiBtcIcon,
  vetro: vetroIcon,
  wbtc: wbtcIcon,
};

const RANGE_PRESETS = [
  { id: "full", label: "Full" },
  { id: "1", label: "±1%" },
  { id: "5", label: "±5%" },
  { id: "15", label: "±15%" },
  { id: "50", label: "±50%" },
  { id: "custom", label: "Custom" },
] as const;

type RangePreset = (typeof RANGE_PRESETS)[number]["id"];
type SheetMode = "deposit" | "rewards";

export function PoolSheet({ onClose, initialMode = "deposit" }: { onClose: () => void; initialMode?: SheetMode }) {
  const w = useWallet();
  const wallet = w.wallet!;
  const [mode, setMode] = useState<SheetMode>(initialMode);
  const [poolId, setPoolId] = useState(DEFAULT_POOL_ID);
  const [preset, setPreset] = useState<RangePreset>("full");
  const [lowText, setLowText] = useState("");
  const [highText, setHighText] = useState("");
  const [market, setMarket] = useState<PoolMarket | null>(null);
  const [marketFor, setMarketFor] = useState(DEFAULT_POOL_ID);
  const [driver, setDriver] = useState<PoolSide>("token0");
  const [text0, setText0] = useState("");
  const [text1, setText1] = useState("");
  const [quote, setQuote] = useState<PoolQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [needsApproval, setNeedsApproval] = useState(false);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState<"approve" | "deposit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aprInputs, setAprInputs] = useState<FeeAprInputs | null>(null);
  const [aprState, setAprState] = useState<"loading" | "ready" | "missing">("loading");
  const [merkl, setMerkl] = useState<MerklIncentive | null>(null);
  const [merklState, setMerklState] = useState<"loading" | "ready" | "missing">("loading");

  const pool = poolById(poolId) ?? POOLS[0];
  // Drop the previous pool's price before paint. Its square root with this pair's decimals
  // stretches the log scale and the candles disappear.
  if (marketFor !== pool.id) {
    setMarketFor(pool.id);
    setMarket(null);
  }
  const spec0 = assetSpec(pool.token0);
  const spec1 = assetSpec(pool.token1);
  const typed = driver === "token0" ? text0 : text1;
  const typedDecimals = driver === "token0" ? spec0.decimals : spec1.decimals;
  const parsed = parseUnits(typed, typedDecimals);
  const free0 = freeOf(pool.token0, w.balances);
  const free1 = freeOf(pool.token1, w.balances);
  const range = useMemo(() => {
    if (!market) return null;
    if (preset === "full") return fullRange(market.spacing);
    if (preset === "custom") return ticksFromPrices(lowText, highText, spec0.decimals, spec1.decimals, market.spacing);
    return bandRange(market.tick, market.spacing, Number(preset));
  }, [market, preset, lowText, highText, spec0.decimals, spec1.decimals]);
  const sides = market && range ? depositSides(market.sqrtPriceX96, range) : "both";
  const bounds = market ? fullRange(market.spacing) : null;
  const isFull = range != null && bounds != null && range.tickLower === bounds.tickLower && range.tickUpper === bounds.tickUpper;
  const customInvalid = preset === "custom" && lowText.trim() !== "" && highText.trim() !== "" && market != null && range == null;
  const noGas = pool.token0 !== "eth" && pool.token1 !== "eth" && w.balances.ethWei === 0n;
  const over0 = quote != null && free0 != null && quote.amount0 > free0;
  const over1 = quote != null && free1 != null && quote.amount1 > free1;
  const ready = mode === "deposit" && busy == null && !noGas && !over0 && !over1 && sure && quote != null && parsed != null && parsed > 0n
    && (driver === "token0" ? quote.amount0 : quote.amount1) === parsed;

  useEffect(() => {
    setPreset("full");
    setLowText("");
    setHighText("");
    setMarket(null);
    let cancel = false;
    void readPoolMarket(pool).then(
      (next) => { if (!cancel) setMarket(next); },
      (err: unknown) => { if (!cancel) setError(messageOf(err)); },
    );
    return () => { cancel = true; };
  }, [pool]);

  useEffect(() => {
    let cancel = false;
    setAprState("loading");
    setAprInputs(null);
    // Candles first. The fee estimate uses the same host, and that host allows about 10 calls a minute.
    void loadPoolPriceSeries(pool.pool, assetSpec(pool.token0).address, assetSpec(pool.token1).address);
    void (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const next = await loadFeeAprInputs(pool);
        if (cancel) return;
        if (next) {
          setAprInputs(next);
          setAprState("ready");
          return;
        }
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 8_000));
      }
      if (!cancel) setAprState("missing");
    })();
    return () => { cancel = true; };
  }, [pool]);

  useEffect(() => {
    let cancel = false;
    setMerklState("loading");
    setMerkl(null);
    void loadMerklIncentive(pool.pool).then(
      (next) => {
        if (cancel) return;
        setMerkl(next);
        setMerklState("ready");
      },
      () => {
        if (!cancel) setMerklState("missing");
      },
    );
    return () => { cancel = true; };
  }, [pool.pool]);

  useEffect(() => {
    setSure(false);
    setQuote(null);
    setError(null);
    setNeedsApproval(false);
    if (driver === "token0") setText1("");
    else setText0("");
    if (!range || parsed == null || parsed <= 0n) {
      setLoading(false);
      return;
    }
    const ticks = range;
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
  }, [pool, driver, parsed, range, spec0.decimals, spec1.decimals]);

  useEffect(() => {
    if (!quote) {
      setNeedsApproval(false);
      return;
    }
    let cancel = false;
    void poolNeedsApproval(wallet.hemiAddress, pool, quote.amount0, quote.amount1)
      .then((needed) => { if (!cancel) setNeedsApproval(needed); })
      .catch(() => { if (!cancel) setNeedsApproval(false); });
    return () => { cancel = true; };
  }, [quote, pool, wallet.hemiAddress]);

  const venuePools = POOLS.filter((item) => item.venue === pool.venue);
  const pairs: PoolInfo[] = [];
  for (const item of venuePools) {
    if (!pairs.some((row) => row.pair === item.pair)) pairs.push(item);
  }
  const fees = venuePools.filter((item) => item.pair === pool.pair);

  function pickVenue(next: PoolVenue) {
    const rows = POOLS.filter((item) => item.venue === next);
    const match = rows.find((item) => item.pair === pool.pair && item.preferred)
      ?? rows.find((item) => item.pair === pool.pair)
      ?? rows.find((item) => item.preferred)
      ?? rows[0];
    setPoolId(match.id);
  }

  function pickPair(pair: string) {
    const rows = venuePools.filter((item) => item.pair === pair);
    const match = rows.find((item) => item.preferred) ?? rows[0];
    setPoolId(match.id);
  }

  function pickPreset(next: RangePreset) {
    if (next === "custom" && market) {
      const seed = preset === "full" || !range ? bandRange(market.tick, market.spacing, 15) : range;
      setLowText(formatTickPrice(seed.tickLower, spec0.decimals, spec1.decimals));
      setHighText(formatTickPrice(seed.tickUpper, spec0.decimals, spec1.decimals));
    }
    setPreset(next);
  }

  function edit(side: PoolSide, value: string) {
    setDriver(side);
    if (side === "token0") setText0(value);
    else setText1(value);
  }

  function fill(side: PoolSide) {
    if (free0 == null || free1 == null || !range) return;
    setError(null);
    void maxDeposit(pool, side, free0, free1, range).then(
      (fitted) => {
        const amount = side === "token0" ? fitted.amount0 : fitted.amount1;
        const decimals = side === "token0" ? spec0.decimals : spec1.decimals;
        edit(side, formatUnits(amount, decimals));
      },
      (err: unknown) => setError(messageOf(err)),
    );
  }

  function onDragPrice(side: "low" | "high", price: number) {
    const text = formatDragPrice(price);
    if (!text || !market || !range) return;
    if (preset !== "custom") {
      setLowText(formatTickPrice(range.tickLower, spec0.decimals, spec1.decimals));
      setHighText(formatTickPrice(range.tickUpper, spec0.decimals, spec1.decimals));
    }
    setPreset("custom");
    if (side === "low") setLowText(text);
    else setHighText(text);
  }

  const apr = market && range && aprInputs
    ? estimateFeeApr(market, range, aprInputs, spec0.decimals, spec1.decimals)
    : null;
  const aprWaiting = aprState === "loading" || (aprState === "ready" && (!market || !range));

  const buttonLabel = busy === "approve"
    ? "Approving…"
    : busy === "deposit"
      ? "Depositing…"
      : parsed == null || parsed <= 0n
        ? "Enter an amount"
        : noGas
          ? "Need ETH for gas"
          : customInvalid
            ? "Widen the range"
            : !market || !range
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
                        ? "Approve and deposit"
                        : "Deposit";

  return (
    <div className="sheet-back" onClick={onClose}>
      <form
        className="sheet swap-sheet"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (mode !== "deposit" || !ready || !quote || parsed == null || parsed <= 0n) return;
          if ((driver === "token0" ? quote.amount0 : quote.amount1) !== parsed) {
            setError("Wait for the amounts to update.");
            return;
          }
          if (over0 || over1) {
            setError(shortfall(pool, quote, free0, free1));
            return;
          }
          setBusy("deposit");
          setError(null);
          void w.addLiquidity({
            poolId: pool.id,
            driver,
            amount: parsed,
            amount0: quote.amount0,
            amount1: quote.amount1,
            tickLower: quote.tickLower,
            tickUpper: quote.tickUpper,
          }, setBusy)
            .then(() => onClose())
            .catch((err: unknown) => setError(messageOf(err)))
            .finally(() => setBusy(null));
        }}
      >
        <div className="swap-top">
          <h2>{mode === "rewards" ? "Rewards" : "Add liquidity"}</h2>
          {mode === "deposit" && (
            <span className="swap-spot">{pool.venue === "sushi" ? "Sushi" : "BrownFi"}</span>
          )}
        </div>
        <div className="rowline">
          <span>View</span>
          <div className="swap-routes">
            <button type="button" className={mode === "deposit" ? "on" : ""} onClick={() => setMode("deposit")}>Deposit</button>
            <button type="button" className={mode === "rewards" ? "on" : ""} onClick={() => setMode("rewards")}>Rewards</button>
          </div>
        </div>

        {mode === "rewards" ? (
          <RewardsPanel owner={wallet.hemiAddress} ethWei={w.balances.ethWei} />
        ) : (
          <>
            <div className="swap-pair">
              <span>{pool.pairLabel}{pool.feeLabel ? ` · ${pool.feeLabel}` : ""}</span>
              <b>{market ? `1 ${spec0.label} = ${formatSqrtPrice(market.sqrtPriceX96, spec0.decimals, spec1.decimals)} ${spec1.label}` : "Reading the pool…"}</b>
            </div>

            <div className="rowline">
              <span>Venue</span>
              <div className="swap-routes">
                <button type="button" className={pool.venue === "sushi" ? "on" : ""} onClick={() => pickVenue("sushi")}>Sushi</button>
                <button type="button" className={pool.venue === "brownfi" ? "on" : ""} onClick={() => pickVenue("brownfi")}>BrownFi</button>
              </div>
            </div>
            <div className="rowline">
              <span>Pool</span>
              <div className="swap-routes">
                {pairs.map((item) => (
                  <button key={item.pair} type="button" className={item.pair === pool.pair ? "on" : ""} onClick={() => pickPair(item.pair)}>
                    {item.pairLabel}
                  </button>
                ))}
              </div>
            </div>
            {fees.length > 1 && (
              <div className="rowline">
                <span>Fee</span>
                <div className="swap-routes">
                  {fees.map((item) => (
                    <button key={item.id} type="button" className={item.id === pool.id ? "on" : ""} onClick={() => setPoolId(item.id)}>
                      {item.feeLabel}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="rowline">
              <span>Range</span>
              <div className="swap-routes">
                {RANGE_PRESETS.map((item) => (
                  <button key={item.id} type="button" className={preset === item.id ? "on" : ""} onClick={() => pickPreset(item.id)}>
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            {market && range && (
              <RangeChart
                pool={pool.pool}
                token0={spec0.address}
                token1={spec1.address}
                full={isFull}
                low={priceNumber(formatTickPrice(range.tickLower, spec0.decimals, spec1.decimals))}
                high={priceNumber(formatTickPrice(range.tickUpper, spec0.decimals, spec1.decimals))}
                current={priceNumber(formatSqrtPrice(market.sqrtPriceX96, spec0.decimals, spec1.decimals))}
                lowText={formatTickPrice(range.tickLower, spec0.decimals, spec1.decimals)}
                highText={formatTickPrice(range.tickUpper, spec0.decimals, spec1.decimals)}
                nowText={formatSqrtPrice(market.sqrtPriceX96, spec0.decimals, spec1.decimals)}
                unit={`${spec1.label} per ${spec0.label}`}
                custom={preset === "custom"}
                onChange={onDragPrice}
              />
            )}
            <div className="rowline range-apr">
              <span>Fee APR</span>
              <b>{aprValue(aprWaiting, aprState, apr)}</b>
            </div>
            <div className="rowline">
              <span>Merkl APR</span>
              <b>{merklValue(merklState, merkl)}</b>
            </div>
            {merkl && (
              <div className="rowline">
                <span>Combined APR</span>
                <b>{combinedValue(aprWaiting, apr, merkl)}</b>
              </div>
            )}
            <p className="fine">{aprNote(aprWaiting, aprState, apr)}</p>
            <p className="fine">{merklNote(merklState, merkl, apr?.inRange ?? null)}</p>
            {preset === "custom" && (
              <div className="range-prices">
                <label>
                  <span>Min {spec1.label} per {spec0.label}</span>
                  <input
                    inputMode="decimal"
                    value={lowText}
                    placeholder="0"
                    aria-label="Minimum price"
                    onChange={(event) => { setPreset("custom"); setLowText(event.target.value); }}
                  />
                </label>
                <label>
                  <span>Max {spec1.label} per {spec0.label}</span>
                  <input
                    inputMode="decimal"
                    value={highText}
                    placeholder="0"
                    aria-label="Maximum price"
                    onChange={(event) => { setPreset("custom"); setHighText(event.target.value); }}
                  />
                </label>
              </div>
            )}

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

            <p className="fine swap-path">
              {rangeNote(range, isFull, sides, spec0.label, spec1.label, spec0.decimals, spec1.decimals)}
              {customInvalid ? " Those prices are in the same tick. Widen the range." : ""}
              {venueNote(pool)}
            </p>
            {loading && <p className="fine">Reading the pool price…</p>}
            {noGas && <p className="fine">This Hemi address has no ETH for gas. Receive a small amount of ETH first.</p>}
            {(over0 || over1) && quote && <p className="fine">{shortfall(pool, quote, free0, free1)}</p>}
            {quote && (
              <label className="check">
                <input type="checkbox" checked={sure} onChange={(event) => setSure(event.target.checked)} />
                <span>{depositClause(quote, spec0.label, spec1.label, spec0.decimals, spec1.decimals)}</span>
              </label>
            )}
            {error && <p className="banner bad">{error}</p>}
            <button className={ready || busy != null ? "btn primary wide" : "btn wide swap-wait"} type="submit" disabled={!ready}>
              {buttonLabel}
            </button>
          </>
        )}
      </form>
    </div>
  );
}

function RewardsPanel({ owner, ethWei }: { owner: string; ethWei: bigint | null }) {
  const w = useWallet();
  const [snapshot, setSnapshot] = useState<LpRewardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const noGas = ethWei === 0n;

  useEffect(() => {
    let cancel = false;
    setSnapshot(null);
    void loadLpRewards(owner).then(
      (next) => { if (!cancel) setSnapshot(next); },
      (err: unknown) => { if (!cancel) setError(messageOf(err)); },
    );
    return () => { cancel = true; };
  }, [owner, reloadKey]);

  const positions = snapshot?.positions ?? [];
  const owed = positions.filter((position) => position.feesKnown && (position.fee0 > 0n || position.fee1 > 0n));
  const canClaimFees = owed.length > 0 && sure && !noGas && !busy;

  async function claimFees(rows: LpPosition[]) {
    if (rows.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    pokeBuddy("Claiming.");
    try {
      for (const position of rows) {
        await w.claimLpFees(position.venue, BigInt(position.tokenId));
      }
      celebrate("Rewards claimed.");
      setSure(false);
      setReloadKey((value) => value + 1);
    } catch (err) {
      setError(messageOf(err));
      setReloadKey((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }

  const feeLabel = busy
    ? "Claiming…"
    : snapshot == null
      ? "Checking rewards…"
      : owed.length === 0
        ? "No fees yet"
        : noGas
          ? "Need ETH for gas"
          : !sure
            ? "Confirm on mainnet"
            : owed.length > 1
              ? "Claim all fees"
              : "Claim fees";

  return (
    <div>
      <p className="fine">
        Trading fees accrue on each position. A claim sends whatever the position has earned to this wallet.
      </p>
      {snapshot == null && !error && <p className="empty">Loading positions…</p>}
      {snapshot != null && positions.length === 0 && (
        <p className="empty">No liquidity positions in this wallet yet. A deposit creates one, and its trading fees show up here.</p>
      )}
      {owed.length > 0 && (
        <label className="check">
          <input type="checkbox" checked={sure} onChange={(event) => setSure(event.target.checked)} />
          <span>Broadcast this claim on mainnet.</span>
        </label>
      )}
      {snapshot?.truncated && <p className="fine">Showing the first 30 positions on each venue.</p>}
      <div className="list">
        {positions.map((position) => {
          const fees = feeLine(position);
          const hasFees = position.feesKnown && (position.fee0 > 0n || position.fee1 > 0n);
          return (
            <div className="card stake-pos" key={`${position.venue}-${position.tokenId}`}>
              <div className="rowline">
                <span>{position.venueLabel}</span>
                <b>{position.pairLabel}{position.feeLabel ? ` · ${position.feeLabel}` : ""}</b>
              </div>
              <div className="rowline">
                <span>Range</span>
                <b>{position.lowerPrice} – {position.upperPrice}</b>
              </div>
              <div className="rowline">
                <span>{position.priceUnit}</span>
                <b>{position.inRange ? "In range" : "Out of range"}</b>
              </div>
              <div className="rowline">
                <span>Fees</span>
                <b>{fees}</b>
              </div>
              {hasFees && (
                <div className="actions">
                  <button
                    className="ghost"
                    type="button"
                    disabled={!sure || noGas || busy}
                    onClick={() => void claimFees([position])}
                  >
                    {busy ? "Claiming…" : !sure ? "Confirm on mainnet" : noGas ? "Need ETH for gas" : "Claim"}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {owed.length > 1 && (
        <button
          className={canClaimFees ? "btn primary wide" : "btn wide swap-wait"}
          type="button"
          disabled={!canClaimFees}
          onClick={() => void claimFees(owed)}
        >
          {feeLabel}
        </button>
      )}

      {error && <p className="banner bad">{error}</p>}
      {noGas && owed.length > 0 && (
        <p className="fine">This Hemi address has no ETH for gas. Receive a small amount of ETH first.</p>
      )}
    </div>
  );
}

function aprValue(waiting: boolean, state: "loading" | "ready" | "missing", apr: FeeAprEstimate | null): string {
  if (waiting) return "…";
  if (state === "missing" || apr == null) return "Unavailable";
  return formatApr(apr.percent);
}

function aprNote(waiting: boolean, state: "loading" | "ready" | "missing", apr: FeeAprEstimate | null): string {
  if (waiting) return "Estimating the fee APR from the last 24 hours of volume.";
  if (state === "missing" || apr == null) return "The fee APR needs this pool's trading volume, and that feed did not load.";
  if (!apr.inRange) return "The price is outside this range, so it earns no trading fees until the price moves inside.";
  const share = apr.lpShare > 0 && apr.lpShare < 1
    ? ` Liquidity providers keep ${Math.round(apr.lpShare * 100)}% of the swap fee.`
    : "";
  return `Estimate from the last 24 hours of volume if the price stays inside this range. It leaves out price movement.${share}`;
}

function merklValue(state: "loading" | "ready" | "missing", incentive: MerklIncentive | null): string {
  if (state === "loading") return "…";
  if (state === "missing") return "Unavailable";
  if (!incentive) return "None";
  return formatIncentive(incentive.apr);
}

function combinedValue(waiting: boolean, apr: FeeAprEstimate | null, incentive: MerklIncentive): string {
  if (waiting) return "…";
  if (apr == null) return "Unavailable";
  const fee = apr.inRange ? apr.percent : 0;
  const bonus = apr.inRange ? incentive.apr : 0;
  return formatIncentive(fee + bonus);
}

function merklNote(state: "loading" | "ready" | "missing", incentive: MerklIncentive | null, inRange: boolean | null): string {
  if (state === "loading") return "Loading the Merkl incentive.";
  if (state === "missing") return "The Merkl incentive feed did not load.";
  if (!incentive) return "This pool has no live Merkl campaign.";
  const until = incentive.endsAt > 0 ? ` The campaign runs through ${campaignDate(incentive.endsAt)}.` : "";
  if (inRange === false) return `Merkl pays ${incentive.reward} while the price is inside this range.${until}`;
  return `Combined APR is the fee APR plus Merkl's ${incentive.reward} incentive. It pays while the price is inside this range.${until}`;
}

function formatIncentive(percent: number): string {
  if (!Number.isFinite(percent) || percent < 0) return "Unavailable";
  if (percent === 0) return "0%";
  if (percent >= 10000) return ">10,000%";
  if (percent >= 10) return `${percent.toFixed(2)}%`;
  return formatApr(percent);
}

function campaignDate(unix: number): string {
  const date = new Date(unix * 1000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

function formatApr(percent: number): string {
  if (percent === 0) return "0%";
  if (percent < 0.0001) return "<0.0001%";
  if (percent < 0.01) {
    const digits = percent < 0.001 ? 4 : 3;
    return `${percent.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "")}%`;
  }
  if (percent >= 10000) return ">10,000%";
  if (percent >= 100) return `${percent.toFixed(0)}%`;
  if (percent >= 10) return `${percent.toFixed(1)}%`;
  return `${percent.toFixed(2)}%`;
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
      ? `Only ${formatUnits(free0, 18)} ETH can be deposited. 0.0003 ETH stays for gas.`
      : `Only ${formatUnits(free0, spec0.decimals)} ${spec0.label} is in this wallet.`;
  }
  if (free1 != null && quote.amount1 > free1) {
    return pool.token1 === "eth"
      ? `Only ${formatUnits(free1, 18)} ETH can be deposited. 0.0003 ETH stays for gas.`
      : `Only ${formatUnits(free1, spec1.decimals)} ${spec1.label} is in this wallet.`;
  }
  return "Not enough in this wallet.";
}

function venueNote(pool: PoolInfo): string {
  const vetro = pool.token0 === "vetro" || pool.token1 === "vetro";
  const wbtc = pool.token0 === "wbtc" || pool.token1 === "wbtc";
  const parts = [
    vetro ? "BrownFi calls this token VUSD. It is Vetro USD, not the official VUSD in this wallet." : "",
    wbtc ? "WBTC is Wrapped BTC. The deposit uses the WBTC held by this address." : "",
  ].filter(Boolean);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function rangeNote(
  range: TickRange | null,
  full: boolean,
  sides: "both" | "token0" | "token1",
  label0: string,
  label1: string,
  dec0: number,
  dec1: number,
): string {
  if (!range) return "Reading the pool…";
  if (full) return "Full range. The position stays active at every price, so both tokens go in, and this wallet receives a new position NFT.";
  const low = formatTickPrice(range.tickLower, dec0, dec1);
  const high = formatTickPrice(range.tickUpper, dec0, dec1);
  const where = sides === "token0"
    ? `The price is below this range, so the deposit is only ${label0}.`
    : sides === "token1"
      ? `The price is above this range, so the deposit is only ${label1}.`
      : "Both tokens go in while the price stays inside.";
  return `From ${low} to ${high} ${label1} per ${label0}. ${where} This wallet receives a new position NFT.`;
}

function depositClause(quote: PoolQuote, label0: string, label1: string, dec0: number, dec1: number): string {
  const used = [
    quote.amount0 > 0n ? `${formatUnits(quote.amount0, dec0)} ${label0}` : "",
    quote.amount1 > 0n ? `${formatUnits(quote.amount1, dec1)} ${label1}` : "",
  ].filter(Boolean);
  const mins = [
    quote.min0 > 0n ? `${formatUnits(quote.min0, dec0)} ${label0}` : "",
    quote.min1 > 0n ? `${formatUnits(quote.min1, dec1)} ${label1}` : "",
  ].filter(Boolean);
  return `Broadcast this deposit on mainnet. It uses up to ${used.join(" and ")}. It reverts if the pool takes less than ${mins.join(" or ")}.`;
}

function feeLine(position: LpPosition): string {
  return positionFeeLine(position);
}

function priceNumber(text: string): number {
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function formatDragPrice(price: number): string {
  if (!Number.isFinite(price) || price <= 0) return "";
  const digits = price >= 100 ? 6 : 10;
  return price.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}
