import { useEffect, useState } from "react";
import btcIcon from "../assets/btc.svg";
import hemiIcon from "../assets/hemi.svg";
import hemiEthIcon from "../assets/hemieth.svg";
import hemiBtcIcon from "../assets/hemibtc.svg";
import vusdIcon from "../assets/vusd.svg";
import { formatUnits, formatWhen } from "../lib/format";
import { messageOf } from "../lib/errors";
import { readBtcActivity, readHemiActivity, type ChainLeg, type ChainRow } from "../lib/hemi";
import { useWallet } from "../state";
import { EthMoves } from "./EthTunnel";
import { BtcMoves } from "./Tunnel";

const ICONS: Record<string, string> = {
  BTC: btcIcon,
  hemiBTC: hemiBtcIcon,
  HEMI: hemiIcon,
  VUSD: vusdIcon,
  ETH: hemiEthIcon,
};

function showLeg(raw: bigint, decimals: number): string {
  const abs = raw < 0n ? -raw : raw;
  const text = formatUnits(abs, decimals);
  const dot = text.indexOf(".");
  if (dot < 0) return text;
  const whole = text.slice(0, dot);
  const frac = text.slice(dot + 1);
  if (frac.length <= 6) return text;
  const head = frac.slice(0, 6).replace(/0+$/, "");
  if (head) return `${whole}.${head}`;
  const sig = frac.search(/[1-9]/);
  const tail = frac.slice(0, Math.max(sig + 1, 0) + 3).replace(/0+$/, "");
  return tail ? `${whole}.${tail}` : whole;
}

function Coin({ symbol }: { symbol: string }) {
  const src = ICONS[symbol];
  if (src) return <img className="coin" src={src} alt="" />;
  return <span className="coin coin-fallback">{symbol.slice(0, 1)}</span>;
}

function Amounts({ legs }: { legs: ChainLeg[] }) {
  return (
    <span className="amts">
      {legs.map((leg) => {
        const raw = BigInt(leg.amount);
        const inbound = raw >= 0n;
        return (
          <span className={inbound ? "amt in" : "amt out"} key={`${leg.symbol}-${leg.amount}`}>
            {inbound ? "+" : "−"}{showLeg(raw, leg.decimals)}
            <span>{leg.symbol}</span>
          </span>
        );
      })}
    </span>
  );
}

export function Activity() {
  const w = useWallet();
  const wallet = w.wallet!;
  const [rows, setRows] = useState<ChainRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [btc, hemi] = await Promise.all([
        readBtcActivity(wallet.btcAddress).then(
          (rows) => ({ rows, error: null as string | null }),
          (err: unknown) => ({ rows: [] as ChainRow[], error: messageOf(err) }),
        ),
        readHemiActivity(wallet.hemiAddress).then(
          (rows) => ({ rows, error: null as string | null }),
          (err: unknown) => ({ rows: [] as ChainRow[], error: messageOf(err) }),
        ),
      ]);
      if (!live) return;
      setRows([...btc.rows, ...hemi.rows].sort((a, b) => b.when - a.when));
      setError(btc.error && hemi.error ? `${btc.error} ${hemi.error}` : btc.error ?? hemi.error);
    })();
    return () => {
      live = false;
    };
  }, [wallet.btcAddress, wallet.hemiAddress, w.tunnels]);

  return (
    <div>
      <div className="kicker" style={{ marginBottom: 10 }}><span>Tunnel</span></div>
      {w.tunnels.length === 0 && w.ethMoves.length === 0 && <p className="empty">No tunnel moves from this device yet.</p>}
      <BtcMoves heading={false} />
      <EthMoves heading={false} />

      <div className="kicker" style={{ margin: "18px 0 10px" }}><span>Chain</span></div>
      {error && <p className="banner bad">{error}</p>}
      {rows.length === 0 && !error && <p className="empty">No Bitcoin or Hemi transfers for these addresses yet.</p>}
      <div className="list">
        {rows.map((row) => {
          const icon = row.title === "Swap"
            ? row.legs.find((leg) => BigInt(leg.amount) < 0n)?.symbol ?? row.legs[0]?.symbol
            : row.legs[0]?.symbol;
          return (
            <a className="card chain" key={row.href} href={row.href} target="_blank" rel="noreferrer">
              <Coin symbol={icon ?? "BTC"} />
              <span>
                <b>{row.title}</b>
                <small>{formatWhen(row.when)} · {row.detail}</small>
              </span>
              <Amounts legs={row.legs} />
            </a>
          );
        })}
      </div>
    </div>
  );
}
