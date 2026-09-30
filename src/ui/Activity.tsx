import { useEffect, useState } from "react";
import { formatWhen, satsToBtc } from "../lib/format";
import { messageOf } from "../lib/errors";
import { readBtcActivity, readHemiActivity, type ChainRow } from "../lib/hemi";
import { btcTxUrl, hemiTxUrl } from "../lib/hemi";
import { useWallet } from "../state";

export function Activity() {
  const w = useWallet();
  const wallet = w.wallet!;
  const [rows, setRows] = useState<ChainRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mintError, setMintError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([readBtcActivity(wallet.btcAddress), readHemiActivity(wallet.hemiAddress)])
      .then(([btc, hemi]) => {
        if (!live) return;
        setRows([...btc, ...hemi].sort((a, b) => b.when - a.when));
      })
      .catch((err) => {
        if (live) setError(messageOf(err));
      });
    return () => {
      live = false;
    };
  }, [wallet.btcAddress, wallet.hemiAddress, w.tunnels]);

  return (
    <div>
      <div className="kicker" style={{ marginBottom: 10 }}><span>Tunnel</span></div>
      {w.tunnels.length === 0 && <p className="empty">No tunnel moves from this device yet.</p>}
      <div className="list">
        {w.tunnels.map((row) => (
          <article className="card item" key={row.id}>
            <b>{row.direction === "to-hemi" ? "Bitcoin → hemiBTC" : "hemiBTC → Bitcoin"}</b>
            <div className="fine">{formatWhen(row.createdAt)} · {row.status}</div>
            <div className="amt" style={{ marginTop: 6 }}>{satsToBtc(BigInt(row.netSats))} after a {satsToBtc(BigInt(row.vaultFeeSats))} vault fee</div>
            <div className="actions">
              <a href={row.direction === "to-hemi" ? btcTxUrl(row.txHash) : hemiTxUrl(row.txHash)} target="_blank" rel="noreferrer">
                Transaction
              </a>
              {row.direction === "to-hemi" && row.status === "broadcast" && (
                <button
                  className="btn primary"
                  type="button"
                  disabled={busy === row.id}
                  onClick={() => {
                    setBusy(row.id);
                    setMintError(null);
                    void w.mintDeposit(row)
                      .catch((err) => setMintError(messageOf(err)))
                      .finally(() => setBusy(null));
                  }}
                >
                  {busy === row.id ? "Minting…" : "Mint hemiBTC"}
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {mintError && <p className="banner bad">{mintError}</p>}

      <div className="kicker" style={{ margin: "18px 0 10px" }}><span>Chain</span></div>
      {error && <p className="banner bad">{error}</p>}
      {rows.length === 0 && !error && <p className="empty">No Bitcoin or hemiBTC transfers for these addresses yet.</p>}
      <div className="list">
        {rows.map((row) => {
          const sats = BigInt(row.amount);
          return (
            <a className="card item" key={`${row.title}-${row.id}`} href={row.href} target="_blank" rel="noreferrer">
              <b>{row.title}</b>
              <div className="fine">{formatWhen(row.when)} · {row.detail}</div>
              <div className="amt">{sats >= 0n ? "+" : ""}{satsToBtc(sats)}</div>
            </a>
          );
        })}
      </div>
    </div>
  );
}
