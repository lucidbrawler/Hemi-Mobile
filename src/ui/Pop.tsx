import { useEffect, useState } from "react";
import { HEMI_EXPLORER, HEMI_TOKEN, KEYSTONE_EVERY } from "../chain";
import { formatUnits, formatWhen, shortAddr } from "../lib/format";
import { btcAddressUrl, btcTxUrl, hemiAddressUrl, hemiTxUrl } from "../lib/hemi";
import { messageOf } from "../lib/errors";
import { readPopDash, type PopDash } from "../lib/pop";
import { useWallet } from "../state";

function linedAddress(value: string) {
  const mid = Math.ceil(value.length / 2);
  return (
    <>
      {value.slice(0, mid)}
      <br />
      {value.slice(mid)}
    </>
  );
}

export function Pop() {
  const w = useWallet();
  const wallet = w.wallet!;
  const [dash, setDash] = useState<PopDash | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setBusy(true);
    setError(null);
    void readPopDash(wallet.btcAddress, wallet.hemiAddress)
      .then((next) => {
        if (live) setDash(next);
      })
      .catch((err) => {
        if (live) setError(messageOf(err));
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [wallet.btcAddress, wallet.hemiAddress, tick]);

  const nextKeystone = !dash
    ? "—"
    : dash.onKeystoneBoundary
      ? "Now"
      : `${dash.blocksUntilKeystone} blocks`;

  return (
    <div>
      <section className="hero">
        <div className="kicker">
          <span>PoP mining</span>
          <button className="ghost" type="button" onClick={() => setTick((n) => n + 1)} disabled={busy}>
            {busy ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        <div className="balance compact">
          {dash ? dash.hemiBlock.toLocaleString() : busy ? "…" : "—"}
          <span className="unit">HEMI BLOCK</span>
        </div>
        <div className="sub">
          {dash
            ? dash.onKeystoneBoundary
              ? "This block is a keystone boundary."
              : `${dash.blocksUntilKeystone} blocks until the next keystone boundary.`
            : "Reading Hemi and Bitcoin."}
        </div>
        <div className="chip">Watch only. popmd publishes the proofs. This tab does not spend bitcoin.</div>
      </section>

      {error && <p className="banner bad">{error}</p>}

      <section className="card hemi-wallet">
        <div className="kicker"><span>Network</span></div>
        <div className="stats">
          <div>
            <span>Next keystone</span>
            <b>{nextKeystone}</b>
          </div>
          <div>
            <span>Kit lag</span>
            <b>{dash?.kitLag == null ? "—" : `${dash.kitLag} blocks`}</b>
          </div>
          <div>
            <span>Fast fee</span>
            <b>{dash?.fastestFee == null ? "—" : `${dash.fastestFee} sat/vB`}</b>
          </div>
          <div>
            <span>Half hour</span>
            <b>{dash?.halfHourFee == null ? "—" : `${dash.halfHourFee} sat/vB`}</b>
          </div>
        </div>
        <div className="rowline"><span>Keystone every</span><b>{KEYSTONE_EVERY} blocks</b></div>
        <div className="rowline">
          <span>Bitcoin in the Hemi kit</span>
          <b>{dash?.bitcoinKitHeight?.toLocaleString() ?? "—"}</b>
        </div>
        <div className="rowline">
          <span>Bitcoin tip</span>
          <b>{dash?.mempoolHeight?.toLocaleString() ?? "—"}</b>
        </div>
        <p className="hint">
          A keystone is Hemi’s checkpoint. Miners pay a Bitcoin fee to put it in a block. Payouts are {dash?.symbol ?? "HEMI"} about four hours later, and a publication inside the next two or three Bitcoin blocks scores higher.
        </p>
      </section>

      <section className="card hemi-wallet">
        <div className="kicker"><span>This Bitcoin address</span></div>
        <div className="well"><p className="addr">{linedAddress(wallet.btcAddress)}</p></div>
        <p className="hint">
          {dash
            ? `${dash.publications.length} PoP publication${dash.publications.length === 1 ? "" : "s"} in the latest ${dash.scanned} transactions.`
            : "Checking recent transactions."}
          {" "}The miner address matches this wallet only when popmd is using this recovery phrase.
        </p>
        <a className="out" href={btcAddressUrl(wallet.btcAddress)} target="_blank" rel="noreferrer">Open on mempool.space</a>
        <div className="list" style={{ marginTop: 10 }}>
          {dash?.publications.map((row) => (
            <a className="card item" key={row.txid} href={btcTxUrl(row.txid)} target="_blank" rel="noreferrer">
              <b>PoP publication</b>
              <div className="fine">{row.when ? formatWhen(row.when) : "In the mempool"} · {row.confirmed ? "Confirmed" : "Unconfirmed"}</div>
              <div className="amt">{shortAddr(row.txid, 10, 8)}</div>
            </a>
          ))}
        </div>
      </section>

      <section className="card hemi-wallet">
        <div className="kicker"><span>{dash?.symbol ?? "HEMI"} on this Hemi address</span></div>
        <div className="well"><p className="addr">{linedAddress(wallet.hemiAddress)}</p></div>
        <div className="rowline">
          <span>Balance</span>
          <b>{dash?.hemiBalance == null ? "—" : `${formatUnits(dash.hemiBalance, dash.decimals)} ${dash.symbol}`}</b>
        </div>
        <p className="hint">
          Rewards land on the Hemi address of the miner key, token {shortAddr(HEMI_TOKEN, 6, 4)}.
        </p>
        <a className="out" href={hemiAddressUrl(wallet.hemiAddress)} target="_blank" rel="noreferrer">Open on the Hemi explorer</a>
        <div className="list" style={{ marginTop: 10 }}>
          {dash?.rewards.map((row) => (
            <a className="card item" key={row.tx} href={hemiTxUrl(row.tx)} target="_blank" rel="noreferrer">
              <b>{dash.symbol} received</b>
              <div className="fine">{formatWhen(Date.parse(row.when))}</div>
              <div className="amt">{formatUnits(row.amount, row.decimals)}</div>
            </a>
          ))}
          {dash && dash.rewards.length === 0 && <p className="empty">No {dash.symbol} transfers into this address yet.</p>}
        </div>
      </section>

      {dash && dash.notes.length > 0 && (
        <p className="fine">{dash.notes.join(" ")}</p>
      )}
      <p className="foot">
        hemiStake is a separate lockup. This tab is the PoP publication watch. Explorer: {HEMI_EXPLORER.replace("https://", "")}.
      </p>
    </div>
  );
}
