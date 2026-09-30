import { useEffect, useState } from "react";
import { btcToSats, satsToBtc, shortAddr } from "../lib/format";
import { messageOf } from "../lib/errors";
import { estimateSpend, fetchUtxos } from "../lib/btc";
import { btcTxUrl, hemiTxUrl } from "../lib/hemi";
import { useWallet } from "../state";

export function Tunnel() {
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
        <div className="balance" style={{ fontSize: 22 }}>
          {toHemi ? "Bitcoin → Hemi" : "Hemi → Bitcoin"}
        </div>
        <div className="meta">
          {w.vault
            ? `Min ${satsToBtc(toHemi ? w.vault.minDepositSats : w.vault.minWithdrawSats)} · ${w.vault.confirmations} Bitcoin confirmations · vault ${w.vault.accepting ? "open" : "paused"}`
            : "Reading the Hemi vault…"}
        </div>
      </section>

      <div className="choice">
        <button className={toHemi ? "on" : ""} type="button" onClick={() => setDirection("to-hemi")}>Deposit</button>
        <button className={!toHemi ? "on" : ""} type="button" onClick={() => setDirection("to-bitcoin")}>Withdraw</button>
      </div>

      <label className="field">
        <span>Amount · {balance == null ? "…" : `${satsToBtc(balance)} free`}</span>
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
        A deposit pays the live vault and writes your Hemi address into an OP_RETURN, which is how the Hemi portal tags a native tunnel. hemiBTC is minted to that address after the confirmation count above. Withdrawals call the vault factory on Hemi and pay Bitcoin back to the address you entered. Both moves are mainnet.
      </p>
    </div>
  );
}
