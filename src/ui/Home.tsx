import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { formatUsd, satsToBtc, shortAddr, btcToSats } from "../lib/format";
import { btcAddressUrl, hemiAddressUrl } from "../lib/hemi";
import { messageOf } from "../lib/errors";
import { useWallet } from "../state";

type Sheet = null | "receive" | "send-btc" | "send-hemi" | "phrase";

export function Home() {
  const w = useWallet();
  const wallet = w.wallet!;
  const [sheet, setSheet] = useState<Sheet>(null);
  const btc = w.balances.btcSats;
  const hemi = w.balances.hemiSats;
  const total = btc != null && hemi != null ? btc + hemi : null;
  const usd = total != null && w.balances.usd != null ? (Number(total) / 1e8) * w.balances.usd : null;

  return (
    <div>
      <section className="hero">
        <div className="kicker">
          <span>Total bitcoin</span>
          <button className="ghost" type="button" onClick={() => void w.refresh()} disabled={w.refreshing}>
            {w.refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        <div className="balance">
          {total == null ? "—" : satsToBtc(total)}
          <span className="unit">BTC</span>
        </div>
        <div className="sub">{usd == null ? "Price unavailable" : `≈ ${formatUsd(usd)}`}</div>
        <div className="meta">Hemi mainnet · chain 43111 · Bitcoin mainnet</div>
      </section>

      <button className="card asset" type="button" onClick={() => setSheet("send-btc")}>
        <span className="dot btc">BTC</span>
        <span>
          <b>Bitcoin</b>
          <small>Native · {shortAddr(wallet.btcAddress, 10, 6)}</small>
        </span>
        <span className="amt">
          {btc == null ? "—" : satsToBtc(btc)}
          <span>BTC</span>
        </span>
      </button>

      <button className="card asset" type="button" onClick={() => setSheet("send-hemi")}>
        <span className="dot hbtc">hB</span>
        <span>
          <b>hemiBTC</b>
          <small>Hemi · {shortAddr(wallet.hemiAddress, 8, 6)}</small>
        </span>
        <span className="amt">
          {hemi == null ? "—" : satsToBtc(hemi)}
          <span>hemiBTC</span>
        </span>
      </button>

      <p className="fine">
        Hemi gas {w.balances.ethWei == null ? "—" : `${formatEth(w.balances.ethWei)} ETH`}. Sends and tunnel withdrawals on Hemi need a little ETH.
      </p>

      <div className="actions">
        <button className="btn primary" type="button" onClick={() => setSheet("receive")}>Receive</button>
        <button className="ghost" type="button" onClick={() => setSheet("phrase")}>Phrase</button>
        <button className="ghost" type="button" onClick={w.lock}>Lock</button>
      </div>

      {sheet === "receive" && <Receive onClose={() => setSheet(null)} />}
      {sheet === "send-btc" && (
        <Send
          title="Send Bitcoin"
          unit="BTC"
          balance={btc}
          onClose={() => setSheet(null)}
          onSubmit={(to, amount) => w.sendBitcoin(to, amount)}
          placeholder="bc1…"
        />
      )}
      {sheet === "send-hemi" && (
        <Send
          title="Send hemiBTC"
          unit="hemiBTC"
          balance={hemi}
          onClose={() => setSheet(null)}
          onSubmit={(to, amount) => w.sendHemi(to, amount)}
          placeholder="0x…"
          gas={w.balances.ethWei}
        />
      )}
      {sheet === "phrase" && <Phrase onClose={() => setSheet(null)} />}
    </div>
  );
}

function formatEth(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 5).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function Receive({ onClose }: { onClose: () => void }) {
  const wallet = useWallet().wallet!;
  const [which, setWhich] = useState<"btc" | "hemi">("btc");
  const address = which === "btc" ? wallet.btcAddress : wallet.hemiAddress;
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    void QRCode.toDataURL(address, { margin: 1, width: 360, color: { dark: "#111111", light: "#ffffff" } }).then((url) => {
      if (live) setQr(url);
    });
    return () => {
      live = false;
    };
  }, [address]);

  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>Receive</h2>
        <div className="choice">
          <button className={which === "btc" ? "on" : ""} type="button" onClick={() => setWhich("btc")}>Bitcoin</button>
          <button className={which === "hemi" ? "on" : ""} type="button" onClick={() => setWhich("hemi")}>Hemi</button>
        </div>
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
          <a className="btn" href={which === "btc" ? btcAddressUrl(address) : hemiAddressUrl(address)} target="_blank" rel="noreferrer">
            Explorer
          </a>
          <button className="ghost" type="button" onClick={onClose}>Close</button>
        </div>
        <p className="foot">
          {which === "btc"
            ? "Native segwit Bitcoin. Do not send hemiBTC here."
            : "This address receives hemiBTC and the ETH used for Hemi gas."}
        </p>
      </div>
    </div>
  );
}

function Send({
  title,
  unit,
  balance,
  placeholder,
  gas,
  onClose,
  onSubmit,
}: {
  title: string;
  unit: string;
  balance: bigint | null;
  placeholder: string;
  gas?: bigint | null;
  onClose: () => void;
  onSubmit: (to: string, amount: bigint) => Promise<string>;
}) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  const sats = btcToSats(amount);
  const blocked = gas != null && gas === 0n;

  return (
    <div className="sheet-back" onClick={onClose}>
      <form
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (sats == null || sats <= 0n) {
            setError("Enter an amount with up to 8 decimals.");
            return;
          }
          if (balance != null && sats > balance) {
            setError(`Only ${satsToBtc(balance)} ${unit} is in this wallet.`);
            return;
          }
          setBusy(true);
          setError(null);
          void onSubmit(to.trim(), sats)
            .then(() => onClose())
            .catch((err) => setError(messageOf(err)))
            .finally(() => setBusy(false));
        }}
      >
        <h2>{title}</h2>
        <label className="field">
          <span>To</span>
          <input value={to} placeholder={placeholder} onChange={(e) => setTo(e.target.value)} spellCheck={false} />
        </label>
        <label className="field">
          <span>Amount · {balance == null ? "…" : `${satsToBtc(balance)} free`}</span>
          <input inputMode="decimal" value={amount} placeholder="0.00" onChange={(e) => setAmount(e.target.value)} />
        </label>
        {blocked && <p className="fine">This Hemi address has no ETH for gas. Receive a small amount of ETH first.</p>}
        <label className="check">
          <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
          <span>Broadcast this on mainnet.</span>
        </label>
        {error && <p className="banner bad">{error}</p>}
        <button className="btn primary wide" disabled={busy || blocked || !sure} type="submit">
          {busy ? "Sending…" : "Send"}
        </button>
      </form>
    </div>
  );
}

function Phrase({ onClose }: { onClose: () => void }) {
  const phrase = useWallet().wallet!.mnemonic;
  const [open, setOpen] = useState(false);
  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>Recovery phrase</h2>
        <p className="fine">Anyone with these words can move the Bitcoin and the hemiBTC.</p>
        {open ? (
          <ol className="words">
            {phrase.split(" ").map((word, index) => (
              <li key={`${word}-${index}`}>
                <i>{index + 1}</i>
                {word}
              </li>
            ))}
          </ol>
        ) : (
          <button className="btn primary wide" type="button" onClick={() => setOpen(true)}>
            Show phrase
          </button>
        )}
        <button className="ghost wide" style={{ marginTop: 8 }} type="button" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
