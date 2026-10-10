import { useEffect, useRef, useState } from "react";
import hemiEthIcon from "../assets/hemieth.svg";
import hemiIcon from "../assets/hemi.svg";
import hemiBtcIcon from "../assets/hemibtc.svg";
import usdtIcon from "../assets/usdt.svg";
import vetroIcon from "../assets/vetro.svg";
import vusdIcon from "../assets/vusd.svg";
import wbtcIcon from "../assets/wbtc.svg";
import { formatUnits, parseUnits } from "../lib/format";
import { hemiProvider } from "../lib/hemi";
import { messageOf } from "../lib/errors";
import {
  ETH_GAS_RESERVE,
  quoteSwaps,
  routerNeedsApproval,
  type SwapAssetId,
  type SwapQuote,
  type SwapRow,
  type SwapVenue,
} from "../lib/swap";
import { useWallet } from "../state";

const ASSETS: { id: SwapAssetId; label: string; decimals: number; icon: string }[] = [
  { id: "eth", label: "ETH", decimals: 18, icon: hemiEthIcon },
  { id: "hemi", label: "HEMI", decimals: 18, icon: hemiIcon },
  { id: "vusd", label: "VUSD", decimals: 18, icon: vusdIcon },
  { id: "vetro", label: "Vetro", decimals: 18, icon: vetroIcon },
  { id: "usdt", label: "USDT", decimals: 6, icon: usdtIcon },
  { id: "hemibtc", label: "hemiBTC", decimals: 8, icon: hemiBtcIcon },
  { id: "wbtc", label: "WBTC", decimals: 8, icon: wbtcIcon },
];

export function SwapSheet({ onClose }: { onClose: () => void }) {
  const w = useWallet();
  const wallet = w.wallet!;
  const [sell, setSell] = useState<SwapAssetId>("hemi");
  const [buy, setBuy] = useState<SwapAssetId>("vusd");
  const [amount, setAmount] = useState("");
  const [rows, setRows] = useState<SwapRow[]>([]);
  const [venue, setVenue] = useState<SwapVenue | null>(null);
  const picked = useRef(false);
  const [loading, setLoading] = useState(false);
  const [needsApproval, setNeedsApproval] = useState(false);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState<"approve" | "swap" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<"sell" | "buy" | null>(null);
  const [feeWei, setFeeWei] = useState<bigint | null>(null);
  const [feePending, setFeePending] = useState(false);

  const sellSpec = ASSETS.find((asset) => asset.id === sell)!;
  const buySpec = ASSETS.find((asset) => asset.id === buy)!;
  const balance = balanceOf(sell, w.balances);
  const free = sell === "eth" && balance != null
    ? (balance > ETH_GAS_RESERVE ? balance - ETH_GAS_RESERVE : 0n)
    : balance;
  const held = sell === "eth" && balance != null && free != null && balance > free ? balance - free : 0n;
  const parsed = parseUnits(amount, sellSpec.decimals);
  const noGas = sell !== "eth" && w.balances.ethWei === 0n;
  const chosen = rows.find((row): row is SwapQuote => "amountOut" in row && row.venue === venue) ?? null;
  const spot = chosen && parsed != null ? payPerReceive(parsed, chosen.amountOut, buySpec.decimals) : null;
  const worst = chosen && parsed != null ? payPerReceive(parsed, chosen.minOut, buySpec.decimals) : null;
  const ready = busy == null && !noGas && sure && chosen != null && parsed != null && parsed > 0n;

  useEffect(() => {
    setSure(false);
    setError(null);
  }, [sell, buy, amount, venue]);

  useEffect(() => {
    if (parsed == null || parsed <= 0n) {
      setRows([]);
      setLoading(false);
      return;
    }
    let cancel = false;
    setRows([]);
    setLoading(true);
    const timer = window.setTimeout(() => {
      void quoteSwaps(sell, buy, parsed, wallet.hemiAddress).then((next) => {
        if (cancel) return;
        setRows(next);
        setLoading(false);
        const readyRows = next.filter((row): row is SwapQuote => "amountOut" in row);
        const best = readyRows.reduce<SwapQuote | null>((win, row) => (win == null || row.amountOut > win.amountOut ? row : win), null);
        setVenue((current) => {
          if (picked.current && current && readyRows.some((row) => row.venue === current)) return current;
          return best?.venue ?? current;
        });
      });
    }, 350);
    return () => {
      cancel = true;
      window.clearTimeout(timer);
    };
  }, [sell, buy, parsed, wallet.hemiAddress]);

  useEffect(() => {
    if (!chosen || parsed == null || parsed <= 0n) {
      setNeedsApproval(false);
      return;
    }
    let cancel = false;
    void routerNeedsApproval(wallet.hemiAddress, sell, chosen.venue, parsed)
      .then((needed) => { if (!cancel) setNeedsApproval(needed); })
      .catch(() => { if (!cancel) setNeedsApproval(false); });
    return () => { cancel = true; };
  }, [chosen, parsed, sell, wallet.hemiAddress]);

  const gasUnits = chosen?.gasUnits ?? null;
  useEffect(() => {
    if (gasUnits == null) {
      setFeeWei(null);
      setFeePending(false);
      return;
    }
    let cancel = false;
    setFeePending(true);
    void hemiProvider().getFeeData().then((fee) => {
      const price = fee.maxFeePerGas ?? fee.gasPrice;
      if (cancel) return;
      setFeeWei(price != null ? gasUnits * price : null);
      setFeePending(false);
    }).catch(() => {
      if (cancel) return;
      setFeeWei(null);
      setFeePending(false);
    });
    return () => { cancel = true; };
  }, [gasUnits]);

  function pick(next: SwapAssetId, side: "sell" | "buy") {
    if (side === "sell") {
      if (next === buy) setBuy(sell);
      setSell(next);
    } else {
      if (next === sell) setSell(buy);
      setBuy(next);
    }
    picked.current = false;
    setVenue(null);
    setAmount("");
    setMenu(null);
  }

  function flip() {
    setSell(buy);
    setBuy(sell);
    picked.current = false;
    setVenue(null);
    setAmount("");
    setMenu(null);
  }

  const buttonLabel = busy === "approve"
    ? "Approving…"
    : busy === "swap"
      ? "Swapping…"
      : parsed == null || parsed <= 0n
        ? "Enter an amount"
        : noGas
          ? "Need ETH for gas"
          : !chosen
            ? (loading ? "Finding a route…" : "No route")
            : !sure
              ? "Confirm on mainnet"
              : needsApproval
                ? "Approve and swap"
                : "Swap";

  return (
    <div className="sheet-back" onClick={onClose}>
      <form
        className="sheet swap-sheet"
        onClick={(event) => {
          event.stopPropagation();
          const target = event.target as HTMLElement;
          if (!target.closest(".swap-pill-wrap")) setMenu(null);
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (parsed == null || parsed <= 0n) {
            setError(`Enter an amount with up to ${sellSpec.decimals} decimals.`);
            return;
          }
          if (free != null && parsed > free) {
            setError(sell === "eth"
              ? `Only ${formatUnits(free, 18)} ETH can be swapped. 0.0003 ETH stays for gas.`
              : `Only ${formatUnits(free, sellSpec.decimals)} ${sellSpec.label} is in this wallet.`);
            return;
          }
          if (!chosen) {
            setError("Wait for a quote, then pick Sushi or BrownFi.");
            return;
          }
          setBusy("swap");
          setError(null);
          void w.swap({
            sell,
            buy,
            amountIn: parsed,
            venue: chosen.venue,
            minOut: chosen.minOut,
          }, setBusy)
            .then(() => onClose())
            .catch((err) => setError(messageOf(err)))
            .finally(() => setBusy(null));
        }}
      >
        <div className="swap-top">
          <h2>Swap</h2>
          <span className="swap-spot">Spot</span>
        </div>
        <div className="swap-pair">
          <span>{sellSpec.label} → {buySpec.label}</span>
          <b title={spot == null ? undefined : `1 ${buySpec.label} in ${sellSpec.label}`}>{money(spot, sellSpec)}</b>
        </div>

        {(sell === "vetro" || buy === "vetro") && (
          <p className="fine">Vetro is Vetro USD on Hemi. It is a different token from VUSD.</p>
        )}

        <div className="swap-stack">
          <div className="swap-panel">
            <div className="swap-panel-top">
              <span>You pay</span>
              <div className="swap-bal">
                <span>Available <b>{free == null ? "…" : `${formatUnits(free, sellSpec.decimals)} ${sellSpec.label}`}</b></span>
                {held > 0n && <span className="swap-hold">For gas <b>{formatUnits(held, 18)} ETH</b></span>}
              </div>
            </div>
            <div className="swap-panel-row">
              <input
                inputMode="decimal"
                value={amount}
                placeholder="0"
                aria-label="You pay"
                onChange={(event) => setAmount(event.target.value)}
              />
              {free != null && free > 0n && (
                <button className="swap-max" type="button" onClick={() => setAmount(formatUnits(free, sellSpec.decimals))}>Max</button>
              )}
              <TokenPill asset={sellSpec} open={menu === "sell"} onOpen={() => setMenu(menu === "sell" ? null : "sell")} onPick={(id) => pick(id, "sell")} />
            </div>
          </div>

          <button className="swap-flip" type="button" aria-label="Switch pay and receive" onClick={flip}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path d="M8 5v11M8 16l-3-3M8 16l3-3M16 19V8M16 8l-3 3M16 8l3 3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          <div className="swap-panel">
            <div className="swap-panel-top">
              <span>You receive</span>
              <span className="swap-slip">Estimate · 0.5% slip</span>
            </div>
            <div className="swap-panel-row">
              <div className="swap-out" aria-live="polite">
                {chosen ? showAmount(chosen.amountOut, buySpec.decimals) : loading ? "…" : "0"}
              </div>
              <TokenPill asset={buySpec} open={menu === "buy"} onOpen={() => setMenu(menu === "buy" ? null : "buy")} onPick={(id) => pick(id, "buy")} />
            </div>
          </div>
        </div>

        <div className="rowline">
          <span>Max price (slippage)</span>
          <b>{money(worst, sellSpec)}</b>
        </div>
        <div className="rowline">
          <span>Network fee</span>
          <b>{feeText(chosen, feeWei, feePending)}</b>
        </div>
        <div className="rowline">
          <span>Route</span>
          <div className="swap-routes">
            {rows.length === 0 && <b>—</b>}
            {rows.map((row) => (
              <button
                key={row.venue}
                type="button"
                className={row.venue === venue && "amountOut" in row ? "on" : ""}
                disabled={"error" in row}
                onClick={() => {
                  if (!("amountOut" in row)) return;
                  picked.current = true;
                  setVenue(row.venue);
                }}
              >
                {row.label}
              </button>
            ))}
          </div>
        </div>
        {chosen && (
          <p className="fine swap-path">
            {chosen.path} · {chosen.via}
            {chosen.impact != null && (
              <span className={chosen.impact > 0.05 ? "hot" : ""}> · impact {(chosen.impact * 100).toFixed(1)}%</span>
            )}
          </p>
        )}
        {rows.some((row) => "error" in row) && (
          <p className="fine">{rows.filter((row) => "error" in row).map((row) => `${row.label}: ${"error" in row ? row.error : ""}`).join(" ")}</p>
        )}
        {loading && <p className="fine">Checking Sushi and BrownFi…</p>}
        {noGas && <p className="fine">This Hemi address has no ETH for gas. Receive a small amount of ETH first.</p>}
        {chosen && (
          <label className="check">
            <input type="checkbox" checked={sure} onChange={(event) => setSure(event.target.checked)} />
            <span>
              Broadcast this swap on mainnet.
              {` You receive at least ${formatUnits(chosen.minOut, buySpec.decimals)} ${buySpec.label}.`}
            </span>
          </label>
        )}
        {error && <p className="banner bad">{error}</p>}
        <button className={ready || busy != null ? "btn primary wide" : "btn wide swap-wait"} type="submit" disabled={!ready}>
          {buttonLabel}
        </button>
      </form>
    </div>
  );
}

function TokenPill({
  asset,
  open,
  onOpen,
  onPick,
}: {
  asset: (typeof ASSETS)[number];
  open: boolean;
  onOpen: () => void;
  onPick: (id: SwapAssetId) => void;
}) {
  return (
    <div className="swap-pill-wrap">
      <button className="swap-pill" type="button" aria-expanded={open} onClick={onOpen}>
        <img src={asset.icon} alt="" />
        {asset.label}
        <i />
      </button>
      {open && (
        <div className="swap-menu" role="listbox">
          {ASSETS.map((item) => (
            <button key={item.id} type="button" className={item.id === asset.id ? "on" : ""} onClick={() => onPick(item.id)}>
              <img src={item.icon} alt="" />
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function money(value: bigint | null, asset: { decimals: number; label: string }): string {
  if (value == null) return "—";
  return `${showAmount(value, asset.decimals)} ${asset.label}`;
}

function feeText(chosen: SwapQuote | null, feeWei: bigint | null, pending: boolean): string {
  if (!chosen || chosen.gasUnits == null) return "—";
  if (pending && feeWei == null) return "…";
  if (feeWei == null) return "—";
  return `${showAmount(feeWei, 18)} ETH`;
}

function payPerReceive(amountIn: bigint, amountOut: bigint, outDecimals: number): bigint | null {
  if (amountOut <= 0n) return null;
  return amountIn * 10n ** BigInt(outDecimals) / amountOut;
}

function showAmount(amount: bigint, decimals: number): string {
  if (amount === 0n) return "0";
  const places = Math.min(6, decimals);
  if (places === decimals) return formatUnits(amount, decimals);
  const factor = 10n ** BigInt(decimals - places);
  const rounded = (amount + factor / 2n) / factor;
  if (rounded !== 0n) return formatUnits(rounded, places);
  const frac = formatUnits(amount, decimals).split(".")[1] ?? "";
  const start = frac.search(/[1-9]/);
  if (start < 0) return "0";
  const cut = frac.slice(0, Math.min(frac.length, start + 4)).replace(/0+$/, "");
  return `0.${cut}`;
}

function balanceOf(id: SwapAssetId, balances: ReturnType<typeof useWallet>["balances"]): bigint | null {
  if (id === "eth") return balances.ethWei;
  if (id === "hemi") return balances.hemiTokenWei;
  if (id === "vusd") return balances.vusdWei;
  if (id === "vetro") return balances.vetroWei;
  if (id === "usdt") return balances.usdtRaw;
  if (id === "wbtc") return balances.wbtcSats;
  return balances.hemiSats;
}
