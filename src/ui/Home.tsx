import { useEffect, useState } from "react";
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
import { formatUnits, formatUsd, formatWhen, parseUnits, satsToBtc, shortAddr } from "../lib/format";
import { btcAddressUrl, hemiAddressUrl } from "../lib/hemi";
import { messageOf } from "../lib/errors";
import { loadLpRewards, positionFeeLine, type LpRewardSnapshot } from "../lib/lpRewards";
import { readStake, stakeRewardLine, type StakePosition } from "../lib/stake";
import { useWallet } from "../state";
import { PoolSheet } from "./PoolSheet";
import { StakeSheet } from "./StakeSheet";
import { SwapSheet } from "./SwapSheet";

type Sheet = null | "receive" | "receive-hemi" | "send-btc" | "send-l1-eth" | "token" | "swap" | "stake" | "stake-rewards" | "pool" | "rewards" | "phrase" | "passkey" | "2fa";
type HemiAsset = "eth" | "hemi" | "vusd" | "hemibtc" | "vetro" | "wbtc" | "usdt";

export function Home() {
  const w = useWallet();
  const wallet = w.wallet!;
  const [sheet, setSheet] = useState<Sheet>(null);
  const [lpReload, setLpReload] = useState(0);
  const [stakeReload, setStakeReload] = useState(0);
  const [tokenAsset, setTokenAsset] = useState<HemiAsset>("hemibtc");
  const [tokenMode, setTokenMode] = useState<"send" | "receive">("send");
  function closePool() {
    setSheet(null);
    setLpReload((value) => value + 1);
  }
  function closeStake() {
    setSheet(null);
    setStakeReload((value) => value + 1);
  }
  function openToken(asset: HemiAsset, mode: "send" | "receive") {
    setTokenAsset(asset);
    setTokenMode(mode);
    setSheet("token");
  }
  const btc = w.balances.btcSats;
  const hemi = w.balances.hemiSats;
  const total = btc != null && hemi != null ? btc + hemi : null;
  const usd = total != null && w.balances.usd != null ? (Number(total) / 1e8) * w.balances.usd : null;

  return (
    <div>
      <section className="hero">
        <div className="kicker">
          <span>Total bitcoin</span>
          <button className="ghost" type="button" onClick={() => { void w.refresh(); setLpReload((value) => value + 1); setStakeReload((value) => value + 1); }} disabled={w.refreshing}>
            {w.refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        <div className="balance">
          {total == null ? "—" : satsToBtc(total)}
          <span className="unit">BTC</span>
        </div>
        <div className="sub">{usd == null ? "Price unavailable" : `≈ ${formatUsd(usd)}`}</div>
        <div className="meta">{w.walletName ? `${w.walletName} · ` : ""}Hemi mainnet · chain 43111 · Bitcoin and Ethereum</div>
      </section>

      <AssetRow
        icon={btcIcon}
        ticker="BTC"
        detail={`Native · ${shortAddr(wallet.btcAddress, 10, 6)}`}
        amount={btc == null ? "—" : satsToBtc(btc)}
        unit="BTC"
        onClick={() => setSheet("send-btc")}
      />
      <AssetRow
        icon={ethIcon}
        ticker="ETH"
        detail={`Native · On Ethereum · ${shortAddr(wallet.hemiAddress, 10, 6)}`}
        amount={w.balances.l1EthWei == null ? "—" : formatUnits(w.balances.l1EthWei, 18)}
        unit="ETH"
        onClick={() => setSheet("send-l1-eth")}
      />

      <section className="card hemi-wallet">
        <div className="kicker"><span>Hemi wallet</span></div>
        <p className="hint">
          HEMI, VUSD, Vetro, WBTC, USDT, ETH, and bitcoin you tunnel as {w.balances.symbol} live on this Hemi address.
        </p>
        <CopyAddress address={wallet.hemiAddress} />
        <Holding
          icon={hemiEthIcon}
          ticker="ETH"
          detail="On Hemi · gas"
          amount={w.balances.ethWei == null ? "—" : formatUnits(w.balances.ethWei, 18)}
          unit="ETH"
          onClick={() => openToken("eth", "send")}
        />
        <Holding
          icon={hemiIcon}
          ticker={w.balances.hemiTokenSymbol}
          detail={`ERC-20 · ${w.balances.hemiTokenDecimals} decimals · ${shortAddr(HEMI_TOKEN, 6, 4)}`}
          amount={w.balances.hemiTokenWei == null ? "—" : formatUnits(w.balances.hemiTokenWei, w.balances.hemiTokenDecimals)}
          unit={w.balances.hemiTokenSymbol}
          onClick={() => openToken("hemi", "send")}
        />
        <Holding
          icon={vusdIcon}
          ticker={w.balances.vusdSymbol}
          detail={`Stablecoin · ${w.balances.vusdDecimals} decimals · ${shortAddr(VUSD, 6, 4)}`}
          amount={w.balances.vusdWei == null ? "—" : formatUnits(w.balances.vusdWei, w.balances.vusdDecimals)}
          unit={w.balances.vusdSymbol}
          onClick={() => openToken("vusd", "send")}
        />
        <Holding
          icon={hemiBtcIcon}
          ticker={w.balances.symbol}
          detail={`ERC-20 · ${w.balances.decimals} decimals · ${shortAddr(HEMIBTC, 6, 4)}`}
          amount={hemi == null ? "—" : formatUnits(hemi, w.balances.decimals)}
          unit={w.balances.symbol}
          onClick={() => openToken("hemibtc", "send")}
        />
        <Holding
          icon={vetroIcon}
          ticker="Vetro"
          detail={`Vetro USD · 18 decimals · ${shortAddr(VETRO_USD, 6, 4)}`}
          amount={w.balances.vetroWei == null ? "—" : formatUnits(w.balances.vetroWei, 18)}
          unit="Vetro"
          onClick={() => openToken("vetro", "send")}
        />
        <Holding
          icon={wbtcIcon}
          ticker="WBTC"
          detail={`Wrapped BTC · 8 decimals · ${shortAddr(WBTC, 6, 4)}`}
          amount={w.balances.wbtcSats == null ? "—" : formatUnits(w.balances.wbtcSats, 8)}
          unit="WBTC"
          onClick={() => openToken("wbtc", "send")}
        />
        <Holding
          icon={usdtIcon}
          ticker="USDT"
          detail={`Stablecoin · 6 decimals · ${shortAddr(USDT, 6, 4)}`}
          amount={w.balances.usdtRaw == null ? "—" : formatUnits(w.balances.usdtRaw, 6)}
          unit="USDT"
          onClick={() => openToken("usdt", "send")}
        />
        <div className="actions">
          <button className="ghost" type="button" onClick={() => setSheet("stake")}>Stake HEMI</button>
          <button className="ghost" type="button" onClick={() => setSheet("pool")}>Add liquidity</button>
        </div>
      </section>

      <LiquidityCard
        owner={wallet.hemiAddress}
        reloadKey={lpReload}
        onRewards={() => setSheet("rewards")}
      />

      <StakeCard
        owner={wallet.hemiAddress}
        reloadKey={stakeReload}
        onRewards={() => setSheet("stake-rewards")}
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
        <StakeSheet initialMode={sheet === "stake-rewards" ? "rewards" : "lock"} onClose={closeStake} />
      )}
      {(sheet === "pool" || sheet === "rewards") && (
        <PoolSheet initialMode={sheet === "rewards" ? "rewards" : "deposit"} onClose={closePool} />
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
}: {
  icon: string;
  ticker: string;
  detail: string;
  amount: string;
  unit: string;
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
  onClick: () => void;
}) {
  return (
    <button className="holding" type="button" onClick={onClick}>
      <RowBody {...row} />
    </button>
  );
}

function StakeCard({
  owner,
  reloadKey,
  onRewards,
}: {
  owner: string;
  reloadKey: number;
  onRewards: () => void;
}) {
  const [positions, setPositions] = useState<StakePosition[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    setError(null);
    void readStake(owner).then(
      (next) => { if (!cancel) setPositions(next); },
      (err: unknown) => { if (!cancel) setError(messageOf(err)); },
    );
    return () => { cancel = true; };
  }, [owner, reloadKey]);

  const rows = positions ?? [];

  return (
    <section className="card stake-home">
      <div className="kicker"><span>Staked HEMI</span></div>
      {positions == null && !error && <p className="fine">Loading positions…</p>}
      {error && <p className="fine">{error}</p>}
      {positions != null && rows.length === 0 && (
        <p className="fine">No staked HEMI in this wallet yet.</p>
      )}
      <div className="lp-list">
        {rows.map((position) => (
          <div className="lp-pos" key={position.tokenId}>
            <b>{formatUnits(position.amount, 18)} HEMI</b>
            <small>
              {position.weight == null ? "Weight unavailable" : `${formatUnits(position.weight, 18)} veHEMI`}
              {" · "}
              {position.expired ? "Unlocked" : position.end <= 0 ? "Unlocks —" : `Unlocks ${formatWhen(position.end * 1000)}`}
            </small>
            <span>{stakeRewardLine(position)}</span>
          </div>
        ))}
      </div>
      <div className="actions">
        <button className="ghost" type="button" onClick={onRewards}>Rewards</button>
      </div>
    </section>
  );
}

function LiquidityCard({
  owner,
  reloadKey,
  onRewards,
}: {
  owner: string;
  reloadKey: number;
  onRewards: () => void;
}) {
  const [snapshot, setSnapshot] = useState<LpRewardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    setError(null);
    void loadLpRewards(owner).then(
      (next) => { if (!cancel) setSnapshot(next); },
      (err: unknown) => { if (!cancel) setError(messageOf(err)); },
    );
    return () => { cancel = true; };
  }, [owner, reloadKey]);

  const positions = snapshot?.positions ?? [];

  return (
    <section className="card liquidity">
      <div className="kicker"><span>Liquidity</span></div>
      {snapshot == null && !error && <p className="fine">Loading positions…</p>}
      {error && <p className="fine">{error}</p>}
      {snapshot != null && positions.length === 0 && (
        <p className="fine">No liquidity positions in this wallet yet.</p>
      )}
      {snapshot?.truncated && <p className="fine">Showing the first 30 positions on each venue.</p>}
      <div className="lp-list">
        {positions.map((position) => (
          <div className="lp-pos" key={`${position.venue}-${position.tokenId}`}>
            <b>{position.pairLabel}{position.feeLabel ? ` · ${position.feeLabel}` : ""}</b>
            <small>{position.venueLabel} · {position.inRange ? "In range" : "Out of range"}</small>
            <small>{position.lowerPrice} – {position.upperPrice} {position.priceUnit}</small>
            <span>{positionFeeLine(position)}</span>
          </div>
        ))}
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
  const parsed = parseUnits(amount, decimals);
  const blocked = gas != null && gas === 0n;

  useEffect(() => {
    setAmount("");
    setError(null);
    setSure(false);
  }, [unit, decimals]);

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

  return (
    <div className="sheet-back" onClick={onClose}>
      <form
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (twoFactor && password.length < 8) {
            setError("Password must be at least 8 characters.");
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
        <p className="hint">The browser asks you to create a passkey. That becomes the unlock.</p>
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
          </>
        )}
        {error && <p className="banner bad">{error}</p>}
        <button className="btn primary wide" disabled={busy || (twoFactor && password.length < 8)} type="submit">
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

  return (
    <div className="sheet-back" onClick={onClose}>
      <form
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (password.length < 8) {
            setError("Password must be at least 8 characters.");
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
        {error && <p className="banner bad">{error}</p>}
        <button className="btn primary wide" disabled={busy || password.length < 8} type="submit">
          {busy ? "Saving…" : "Turn on 2FA"}
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
        <p className="fine">Anyone with these words can move the Bitcoin, the hemiBTC, the HEMI, the VUSD, and the ETH.</p>
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
