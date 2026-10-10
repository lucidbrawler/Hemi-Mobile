import { useEffect, useState } from "react";
import btcIcon from "../assets/btc.svg";
import hemiBtcIcon from "../assets/hemibtc.svg";
import { btcToSats, formatRemain, formatUnits, formatWhen, satsToBtc, shortAddr } from "../lib/format";
import { messageOf } from "../lib/errors";
import { estimateSpend, fetchUtxos, findBtcCredit } from "../lib/btc";
import { btcTxUrl, hemiTxUrl, readBtcConfirmations, readHemiMined } from "../lib/hemi";
import { useWallet } from "../state";
import type { TunnelRecord } from "../lib/storage";
import { EthMoves, EthTunnel } from "./EthTunnel";
import { StepStatus } from "./Step";

const BTC_BLOCK_MS = 10 * 60 * 1000;

export function Tunnel() {
  const [asset, setAsset] = useState<"btc" | "eth">("btc");
  return (
    <div>
      <BtcMoves openOnly heading />
      <EthMoves openOnly heading />
      <div className="choice" style={{ marginTop: 0 }}>
        <button className={asset === "btc" ? "on" : ""} type="button" onClick={() => setAsset("btc")}>Bitcoin</button>
        <button className={asset === "eth" ? "on" : ""} type="button" onClick={() => setAsset("eth")}>ETH</button>
      </div>
      {asset === "btc" ? <BtcTunnel /> : <EthTunnel />}
    </div>
  );
}

function Available({ rows }: { rows: { icon: string; ticker: string; detail: string; amount: string }[] }) {
  return (
    <section className="card avail">
      <div className="kicker"><span>Available</span></div>
      {rows.map((row) => (
        <div className="avail-row" key={`${row.ticker}-${row.detail}`}>
          <img className="coin" src={row.icon} alt="" />
          <span>
            <b>{row.ticker}</b>
            <small>{row.detail}</small>
          </span>
          <span className="amt">
            {row.amount}
            <span>{row.ticker}</span>
          </span>
        </div>
      ))}
    </section>
  );
}

function BtcTunnel() {
  const w = useWallet();
  const wallet = w.wallet!;
  const [direction, setDirection] = useState<"to-hemi" | "to-bitcoin">("to-hemi");
  const [amount, setAmount] = useState("");
  const [dest, setDest] = useState(wallet.hemiAddress);
  const [fee, setFee] = useState<bigint | null>(null);
  const [networkFee, setNetworkFee] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  const [txid, setTxid] = useState<string | null>(null);

  const toHemi = direction === "to-hemi";
  const sats = btcToSats(amount);
  const min = toHemi ? w.vault?.minDepositSats : w.vault?.minWithdrawSats;
  const balance = toHemi ? w.balances.btcSats : w.balances.hemiSats;

  useEffect(() => {
    setDest(toHemi ? wallet.hemiAddress : wallet.btcAddress);
    setFee(null);
    setTxid(null);
    setSure(false);
    setError(null);
  }, [toHemi, wallet.hemiAddress, wallet.btcAddress]);

  useEffect(() => {
    if (sats == null || sats <= 0n) {
      setFee(null);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      void w.vaultFee(toHemi ? "deposit" : "withdraw", sats)
        .then((next) => {
          if (live) setFee(next);
        })
        .catch(() => {
          if (live) setFee(null);
        });
      if (toHemi) {
        void (async () => {
          const [utxos, rate] = await Promise.all([fetchUtxos(wallet.btcAddress), w.feeRate()]);
          if (!live) return;
          setNetworkFee(estimateSpend(utxos, sats, rate, true));
        })().catch(() => {
          if (live) setNetworkFee(null);
        });
      } else {
        setNetworkFee(null);
      }
    }, 350);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [sats, toHemi, w, wallet.btcAddress]);

  const net = sats != null && fee != null && sats > fee ? sats - fee : null;
  const tooSmall = sats != null && min != null && sats < min;
  const noGas = !toHemi && w.balances.ethWei === 0n;

  return (
    <div>
      <section className="hero">
        <div className="kicker"><span>Native tunnel</span><span>Vault {w.vault ? "live" : "…"}</span></div>
        <div className="balance compact">
          {toHemi ? "Bitcoin → Hemi" : "Hemi → Bitcoin"}
        </div>
        <div className="meta">
          {w.vault
            ? `Min ${satsToBtc(toHemi ? w.vault.minDepositSats : w.vault.minWithdrawSats)} · ${w.vault.confirmations} Bitcoin confirmations · vault ${w.vault.accepting ? "open" : "paused"}`
            : "Reading the Hemi vault…"}
        </div>
      </section>

      <Available
        rows={[
          {
            icon: btcIcon,
            ticker: "BTC",
            detail: "Native Bitcoin",
            amount: w.balances.btcSats == null ? "—" : satsToBtc(w.balances.btcSats),
          },
          {
            icon: hemiBtcIcon,
            ticker: w.balances.symbol,
            detail: "On Hemi",
            amount: w.balances.hemiSats == null ? "—" : formatUnits(w.balances.hemiSats, w.balances.decimals),
          },
        ]}
      />

      <div className="choice">
        <button className={toHemi ? "on" : ""} type="button" onClick={() => setDirection("to-hemi")}>Deposit</button>
        <button className={!toHemi ? "on" : ""} type="button" onClick={() => setDirection("to-bitcoin")}>Withdraw</button>
      </div>

      <label className="field">
        <span>Amount · {balance == null ? "…" : `${satsToBtc(balance)} available`}</span>
        <input inputMode="decimal" value={amount} placeholder="0.0001" onChange={(e) => setAmount(e.target.value)} />
      </label>
      <label className="field">
        <span>{toHemi ? "Hemi address that receives hemiBTC" : "Bitcoin address that receives BTC"}</span>
        <input value={dest} onChange={(e) => setDest(e.target.value)} spellCheck={false} />
      </label>

      <div className="card" style={{ padding: 14, marginBottom: 12 }}>
        <div className="rowline"><span>You send</span><b>{sats == null ? "—" : `${satsToBtc(sats)} ${toHemi ? "BTC" : "hemiBTC"}`}</b></div>
        <div className="rowline"><span>Vault fee</span><b>{fee == null ? "—" : `${satsToBtc(fee)}`}</b></div>
        {toHemi && (
          <div className="rowline"><span>Bitcoin network fee</span><b>{networkFee == null ? "—" : `${satsToBtc(networkFee)}`}</b></div>
        )}
        <div className="rowline"><span>You receive</span><b>{net == null ? "—" : `${satsToBtc(net)} ${toHemi ? "hemiBTC" : "BTC"}`}</b></div>
        {toHemi && w.vault && (
          <div className="rowline"><span>Vault</span><b>{shortAddr(w.vault.custodyAddress, 8, 6)}</b></div>
        )}
      </div>

      {tooSmall && min != null && <p className="fine">Minimum is {satsToBtc(min)}.</p>}
      {noGas && <p className="fine">Withdrawals need ETH on Hemi for gas.</p>}
      {w.vault && !w.vault.accepting && toHemi && <p className="fine">The vault is not accepting deposits right now.</p>}
      <label className="check">
        <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
        <span>Broadcast this on mainnet. Bitcoin and hemiBTC actually move.</span>
      </label>
      {busy && (
        <div className="card item" style={{ marginBottom: 12 }}>
          <StepStatus
            spinning
            step="Submitting"
            message={toHemi ? "Broadcasting the Bitcoin deposit." : "Sending the withdrawal on Hemi."}
            eta="A few seconds, then the tracker keeps this move."
          />
        </div>
      )}
      {error && <p className="banner bad">{error}</p>}
      {txid && (
        <p className="banner ok">
          <a href={toHemi ? btcTxUrl(txid) : hemiTxUrl(txid)} target="_blank" rel="noreferrer">
            Open the transaction
          </a>
        </p>
      )}

      <button
        className="btn primary wide"
        type="button"
        disabled={busy || !sure || sats == null || sats <= 0n || tooSmall || noGas || (toHemi && w.vault != null && !w.vault.accepting)}
        onClick={() => {
          if (sats == null) return;
          setBusy(true);
          setError(null);
          const task = toHemi ? w.deposit(dest, sats) : w.withdraw(dest, sats);
          void task
            .then((hash) => {
              setTxid(hash);
              setAmount("");
            })
            .catch((err) => setError(messageOf(err)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Submitting…" : toHemi ? "Deposit Bitcoin" : "Withdraw to Bitcoin"}
      </button>
      <p className="foot">
        A deposit pays the live vault and writes your Hemi address into an OP_RETURN, which is how the Hemi portal tags a native tunnel. hemiBTC is minted to that address after the confirmation count above. Withdrawals call the vault factory on Hemi and pay Bitcoin back to the address you entered. Both moves are mainnet. An open move stays at the top of this page until it finishes.
      </p>
    </div>
  );
}

export function BtcMoves({ heading = true, openOnly = false }: { heading?: boolean; openOnly?: boolean }) {
  const w = useWallet();
  const [now, setNow] = useState(Date.now());
  const [confs, setConfs] = useState<Record<string, number | null>>({});
  const [mined, setMined] = useState<Record<string, boolean | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = w.tunnels.filter((row) => !openOnly || row.status === "broadcast");
  const markBtc = w.markBtc;

  const tracking = w.tunnels.some((row) => row.status === "broadcast");
  useEffect(() => {
    if (!tracking) return;
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(clock);
  }, [tracking]);

  useEffect(() => {
    let live = true;
    const deposits = w.tunnels.filter((row) => row.direction === "to-hemi" && row.status === "broadcast");
    const withdraws = w.tunnels.filter((row) => row.direction === "to-bitcoin" && row.status === "broadcast");
    if (deposits.length === 0 && withdraws.length === 0) return;
    const run = () => {
      void Promise.all(deposits.map(async (row) => {
        try {
          return [row.id, await readBtcConfirmations(row.txHash)] as const;
        } catch {
          return [row.id, null] as const;
        }
      })).then((next) => {
        if (!live) return;
        setConfs(Object.fromEntries(next));
      });
      void Promise.all(withdraws.map(async (row) => {
        try {
          const included = await readHemiMined(row.txHash);
          if (included) {
            const paid = await findBtcCredit(row.btcAddress, row.createdAt, BigInt(row.netSats));
            if (paid) markBtc(row.id, "paid");
          }
          return [row.id, included] as const;
        } catch {
          return [row.id, null] as const;
        }
      })).then((next) => {
        if (!live) return;
        setMined(Object.fromEntries(next));
      });
    };
    run();
    const poll = window.setInterval(run, 20_000);
    return () => {
      live = false;
      window.clearInterval(poll);
    };
  }, [w.tunnels, markBtc]);

  if (rows.length === 0) return null;

  return (
    <div style={{ marginBottom: heading ? 12 : 0 }}>
      {heading && <div className="kicker" style={{ marginBottom: 10 }}><span>Bitcoin tunnel</span></div>}
      <div className="list">
        {rows.map((row) => (
          <BtcMoveCard
            key={row.id}
            row={row}
            now={now}
            confirmations={confs[row.id]}
            need={w.vault?.confirmations ?? 6}
            mined={mined[row.id]}
            busy={busy === row.id}
            onMint={() => {
              setBusy(row.id);
              setError(null);
              void w.mintDeposit(row)
                .catch((err) => setError(messageOf(err)))
                .finally(() => setBusy(null));
            }}
          />
        ))}
      </div>
      {error && <p className="banner bad">{error}</p>}
    </div>
  );
}

function BtcMoveCard({
  row,
  now,
  confirmations,
  need,
  mined,
  busy,
  onMint,
}: {
  row: TunnelRecord;
  now: number;
  confirmations: number | null | undefined;
  need: number;
  mined: boolean | null | undefined;
  busy: boolean;
  onMint: () => void;
}) {
  const deposit = row.direction === "to-hemi";
  const done = row.status === "minted" || row.status === "paid";
  let step = done ? "Done" : "Checking";
  let message = "Reading this move.";
  let eta = "Checking…";
  let spinning = !done;
  let canMint = false;

  if (done) {
    spinning = false;
    step = deposit ? "Done · hemiBTC mint submitted" : "Done · Bitcoin payout seen";
    message = deposit
      ? "The mint transaction was sent. hemiBTC shows up after Hemi confirms it."
      : "Bitcoin for this withdrawal showed up on the address you entered.";
    eta = formatWhen(row.createdAt);
  } else if (deposit) {
    const got = confirmations;
    if (got == null) {
      step = "Step 2 of 3 · Bitcoin confirmations";
      message = "Asking mempool.space how many confirmations this deposit has.";
      eta = "Checking…";
    } else if (got >= need) {
      canMint = true;
      step = "Step 3 of 3 · Mint hemiBTC";
      message = `${got} of ${need} Bitcoin confirmations are in. Minting is one Hemi transaction.`;
      eta = "Waiting on you";
    } else {
      step = "Step 2 of 3 · Bitcoin confirmations";
      message = got === 0
        ? `The deposit is waiting for its first Bitcoin block. The vault needs ${need}.`
        : `${got} of ${need} Bitcoin confirmations.`;
      eta = formatRemain(now + (need - got) * BTC_BLOCK_MS, now);
    }
  } else if (mined == null) {
    step = "Step 1 of 2 · Hemi inclusion";
    message = "Checking whether Hemi has included the withdrawal.";
    eta = "Checking…";
  } else if (!mined) {
    step = "Step 1 of 2 · Hemi inclusion";
    message = "The withdrawal is waiting to be included on Hemi.";
    eta = "A Hemi block is usually about 12 seconds";
  } else {
    step = "Step 2 of 2 · Bitcoin payout";
    message = `Hemi included it. The vault pays Bitcoin to ${shortAddr(row.btcAddress, 8, 6)}.`;
    eta = "No published clock for the payout. This closes when that Bitcoin arrives.";
  }

  return (
    <article className="card item">
      <b>{deposit ? "Bitcoin → hemiBTC" : "hemiBTC → Bitcoin"}</b>
      <div className="fine">{formatWhen(row.createdAt)} · {satsToBtc(BigInt(row.netSats))} after the vault fee</div>
      <StepStatus spinning={spinning} step={step} message={message} eta={eta} />
      <div className="actions">
        <a href={deposit ? btcTxUrl(row.txHash) : hemiTxUrl(row.txHash)} target="_blank" rel="noreferrer">Transaction</a>
        {canMint && (
          <button className="btn primary" type="button" disabled={busy} onClick={onMint}>
            {busy ? "Minting…" : "Mint hemiBTC"}
          </button>
        )}
      </div>
    </article>
  );
}
