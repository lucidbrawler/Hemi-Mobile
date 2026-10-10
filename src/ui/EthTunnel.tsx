import { useEffect, useState } from "react";
import ethIcon from "../assets/eth.svg";
import hemiEthIcon from "../assets/hemieth.svg";
import { formatRemain, formatUnits, formatWhen, parseUnits } from "../lib/format";
import { messageOf } from "../lib/errors";
import { hemiTxUrl } from "../lib/hemi";
import {
  destinationIsContract,
  ETH_DERIVE_SECONDS,
  estimateBridgeFee,
  ethTxUrl,
  maxBridgeAmount,
  readEthBridge,
  readEthInclusion,
  readWithdrawalStage,
  type EthBridgeInfo,
  type EthInclusion,
  type WithdrawalStage,
} from "../lib/ethBridge";
import { useWallet, withdrawalFields } from "../state";
import type { EthMove } from "../lib/storage";
import { StepStatus } from "./Step";

type Direction = "to-hemi" | "to-ethereum";

function waitLabel(seconds: number): string {
  const hours = Math.max(1, Math.round(seconds / 3600));
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

export function EthTunnel() {
  const w = useWallet();
  const wallet = w.wallet!;
  const [direction, setDirection] = useState<Direction>("to-hemi");
  const [amount, setAmount] = useState("");
  const [dest, setDest] = useState(wallet.hemiAddress);
  const [fee, setFee] = useState<bigint | null>(null);
  const [bridge, setBridge] = useState<EthBridgeInfo | null>(null);
  const [bridgeError, setBridgeError] = useState(false);
  const [contractDest, setContractDest] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  const [txid, setTxid] = useState<string | null>(null);

  const toHemi = direction === "to-hemi";
  const wei = parseUnits(amount, 18);
  const balance = toHemi ? w.balances.l1EthWei : w.balances.ethWei;
  const paused = bridge != null && (bridge.portalPaused || (toHemi ? bridge.l1Paused : bridge.l2Paused));
  const shortFee = wei != null && fee != null && balance != null && wei + fee > balance;

  useEffect(() => {
    setDest(wallet.hemiAddress);
    setFee(null);
    setTxid(null);
    setSure(false);
    setError(null);
  }, [toHemi, wallet.hemiAddress]);

  useEffect(() => {
    let live = true;
    void readEthBridge()
      .then((info) => {
        if (!live) return;
        setBridge(info);
        setBridgeError(false);
      })
      .catch(() => {
        if (!live) return;
        setBridge(null);
        setBridgeError(true);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (wei == null || wei <= 0n) {
      setFee(null);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      void estimateBridgeFee(toHemi ? "deposit" : "withdraw", wallet.hemiAddress, dest, wei)
        .then((next) => {
          if (live) setFee(next);
        })
        .catch(() => {
          if (live) setFee(null);
        });
    }, 350);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [wei, toHemi, dest, wallet.hemiAddress]);

  useEffect(() => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(dest.trim())) {
      setContractDest(false);
      return;
    }
    let live = true;
    void destinationIsContract(toHemi ? "deposit" : "withdraw", dest)
      .then((isContract) => {
        if (live) setContractDest(isContract);
      })
      .catch(() => {
        if (live) setContractDest(false);
      });
    return () => {
      live = false;
    };
  }, [dest, toHemi]);

  return (
    <div>
      <section className="hero">
        <div className="kicker">
          <span>Ethereum tunnel</span>
          <span>{bridge ? (paused ? "paused" : "open") : "…"}</span>
        </div>
        <div className="balance compact">{toHemi ? "Ethereum → Hemi" : "Hemi → Ethereum"}</div>
        <div className="meta">
          {bridge
            ? `No protocol fee · 1 ETH in, 1 ETH out · withdrawal wait ${waitLabel(bridge.finalizationSeconds)} after the proof`
            : bridgeError
              ? "Could not read the Ethereum bridge."
              : "Reading the Hemi Ethereum bridge…"}
        </div>
      </section>

      <section className="card avail">
        <div className="kicker"><span>Available</span></div>
        <div className="avail-row">
          <img className="coin" src={ethIcon} alt="" />
          <span>
            <b>ETH</b>
            <small>On Ethereum</small>
          </span>
          <span className="amt">
            {w.balances.l1EthWei == null ? "—" : formatUnits(w.balances.l1EthWei, 18)}
            <span>ETH</span>
          </span>
        </div>
        <div className="avail-row">
          <img className="coin" src={hemiEthIcon} alt="" />
          <span>
            <b>ETH</b>
            <small>On Hemi</small>
          </span>
          <span className="amt">
            {w.balances.ethWei == null ? "—" : formatUnits(w.balances.ethWei, 18)}
            <span>ETH</span>
          </span>
        </div>
      </section>

      <div className="choice">
        <button className={toHemi ? "on" : ""} type="button" onClick={() => setDirection("to-hemi")}>Deposit</button>
        <button className={!toHemi ? "on" : ""} type="button" onClick={() => setDirection("to-ethereum")}>Withdraw</button>
      </div>

      <label className="field">
        <span className="label-row">
          <span>Amount · {balance == null ? "…" : `${formatUnits(balance, 18)} available`}</span>
          <button
            type="button"
            disabled={balance == null || balance <= 0n}
            onClick={() => {
              if (balance == null) return;
              void maxBridgeAmount(toHemi ? "deposit" : "withdraw", wallet.hemiAddress, dest, balance)
                .then((max) => setAmount(formatUnits(max, 18)))
                .catch((err) => setError(messageOf(err)));
            }}
          >
            Max
          </button>
        </span>
        <input inputMode="decimal" value={amount} placeholder="0.01" onChange={(e) => setAmount(e.target.value)} />
      </label>
      <label className="field">
        <span>{toHemi ? "Hemi address that receives ETH" : "Ethereum address that receives ETH"}</span>
        <input value={dest} onChange={(e) => setDest(e.target.value)} spellCheck={false} />
      </label>

      <div className="card" style={{ padding: 14, marginBottom: 12 }}>
        <div className="rowline"><span>You send</span><b>{wei == null ? "—" : `${formatUnits(wei, 18)} ETH`}</b></div>
        <div className="rowline"><span>Bridge fee</span><b>0 ETH</b></div>
        <div className="rowline">
          <span>{toHemi ? "Ethereum network fee" : "Hemi network fee"}</span>
          <b>{fee == null ? "—" : `${formatUnits(fee, 18)} ETH`}</b>
        </div>
        <div className="rowline"><span>You receive</span><b>{wei == null ? "—" : `${formatUnits(wei, 18)} ETH`}</b></div>
      </div>

      {paused && <p className="fine">This direction of the bridge is paused.</p>}
      {shortFee && <p className="fine">Leave some ETH for the network fee. The bridged amount is on top of gas.</p>}
      {contractDest && (
        <p className="fine">That address is a contract. If it rejects plain ETH, the tunnel can finish without paying it.</p>
      )}
      <label className="check">
        <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
        <span>Broadcast this on mainnet. ETH actually moves.</span>
      </label>
      {busy && (
        <div className="card item" style={{ marginBottom: 12 }}>
          <StepStatus
            spinning
            step="Submitting"
            message={toHemi ? "Broadcasting the Ethereum deposit." : "Sending the withdrawal on Hemi."}
            eta="A few seconds, then the tracker keeps this move."
          />
        </div>
      )}
      {error && <p className="banner bad">{error}</p>}
      {txid && (
        <p className="banner ok">
          <a href={toHemi ? ethTxUrl(txid) : hemiTxUrl(txid)} target="_blank" rel="noreferrer">
            Open the transaction
          </a>
        </p>
      )}

      <button
        className="btn primary wide"
        type="button"
        disabled={busy || !sure || wei == null || wei <= 0n || paused || shortFee || (balance != null && wei > balance)}
        onClick={() => {
          if (wei == null) return;
          setBusy(true);
          setError(null);
          const task = toHemi ? w.depositEth(dest, wei) : w.withdrawEth(dest, wei);
          void task
            .then((hash) => {
              setTxid(hash);
              setAmount("");
            })
            .catch((err) => setError(messageOf(err)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Submitting…" : toHemi ? "Deposit ETH" : "Withdraw ETH"}
      </button>
      <p className="foot">
        {toHemi
          ? "A deposit calls the Hemi standard bridge on Ethereum. The same amount of ETH shows up on Hemi after the deposit is derived, usually within a few minutes. Ethereum gas is extra, and it is not taken out of the amount you bridge. An open move stays at the top of this page until it finishes."
          : "A withdrawal calls the Hemi standard bridge. When a Hemi output includes that block, prove the withdrawal on Ethereum, wait out the period above, then finalize. Prove and finalize each spend a little Ethereum gas. The ETH arrives on Ethereum when the finalize transaction succeeds. An open move stays at the top of this page until it finishes."}
      </p>
    </div>
  );
}

export function EthMoves({ heading = true, openOnly = false }: { heading?: boolean; openOnly?: boolean }) {
  const w = useWallet();
  const moves = w.ethMoves;
  const markEth = w.markEth;
  const proveEth = w.proveEth;
  const finalizeEth = w.finalizeEth;
  const [now, setNow] = useState(Date.now());
  const [tick, setTick] = useState(0);
  const [stages, setStages] = useState<Record<string, WithdrawalStage | "error">>({});
  const [inclusions, setInclusions] = useState<Record<string, EthInclusion | "error">>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tracking = moves.some((move) => (move.direction === "to-hemi" ? move.status !== "credited" : move.status !== "finalized"));
  useEffect(() => {
    if (!tracking) return;
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const poll = window.setInterval(() => setTick((value) => value + 1), 20_000);
    return () => {
      window.clearInterval(clock);
      window.clearInterval(poll);
    };
  }, [tracking]);

  useEffect(() => {
    let live = true;
    const pending = moves.filter((move) => move.direction === "to-ethereum" && move.withdrawal && move.l2Block != null && move.status !== "finalized");
    const deposits = moves.filter((move) => move.direction === "to-hemi" && move.status === "submitted");
    if (pending.length === 0 && deposits.length === 0) return;
    void Promise.all(pending.map(async (move) => {
      const fields = withdrawalFields(move);
      if (!fields || move.l2Block == null) return [move.id, "error"] as const;
      try {
        return [move.id, await readWithdrawalStage(fields, move.l2Block)] as const;
      } catch {
        return [move.id, "error"] as const;
      }
    })).then((rows) => {
      if (!live) return;
      const next: Record<string, WithdrawalStage | "error"> = {};
      for (const [id, stage] of rows) next[id] = stage;
      setStages(next);
      for (const [id, stage] of rows) {
        if (stage === "error") continue;
        const move = moves.find((row) => row.id === id);
        if (!move) continue;
        if (stage.kind === "finalized" && move.status !== "finalized") markEth(id, "finalized");
        if ((stage.kind === "waiting-finality" || stage.kind === "ready-to-finalize") && move.status === "submitted") {
          markEth(id, "proven");
        }
      }
    });
    void Promise.all(deposits.map(async (move) => {
      if (move.hemiWeiBefore && w.balances.ethWei != null) {
        const credited = w.balances.ethWei >= BigInt(move.hemiWeiBefore) + BigInt(move.amountWei);
        if (credited) {
          markEth(move.id, "credited");
          return [move.id, "pending"] as const;
        }
      }
      try {
        return [move.id, await readEthInclusion(move.txHash)] as const;
      } catch {
        return [move.id, "error"] as const;
      }
    })).then((rows) => {
      if (!live) return;
      const next: Record<string, EthInclusion | "error"> = {};
      for (const [id, inclusion] of rows) next[id] = inclusion;
      setInclusions(next);
    });
    return () => {
      live = false;
    };
  }, [moves, markEth, tick, w.balances.ethWei]);

  const shown = moves.filter((move) => !openOnly || ethOpen(move, stages[move.id]));
  if (shown.length === 0) return null;

  function run(id: string, task: Promise<string>) {
    setBusy(id);
    setError(null);
    void task.catch((err) => setError(messageOf(err))).finally(() => setBusy(null));
  }

  return (
    <div style={{ marginTop: heading ? 18 : 0, marginBottom: openOnly ? 12 : 0 }}>
      {heading && <div className="kicker" style={{ marginBottom: 10 }}><span>ETH tunnel</span></div>}
      <div className="list">
        {shown.map((move) => (
          <EthMoveCard
            key={move.id}
            move={move}
            stage={stages[move.id]}
            inclusion={inclusions[move.id]}
            now={now}
            busy={busy === move.id}
            l1Wei={w.balances.l1EthWei}
            onProve={() => run(move.id, proveEth(move.id))}
            onFinalize={() => run(move.id, finalizeEth(move.id))}
          />
        ))}
      </div>
      {error && <p className="banner bad">{error}</p>}
    </div>
  );
}

function ethOpen(move: EthMove, stage: WithdrawalStage | "error" | undefined): boolean {
  if (move.direction === "to-hemi") return move.status !== "credited";
  if (move.status === "finalized") return false;
  if (stage && stage !== "error" && stage.kind === "finalized") return false;
  return true;
}

function EthMoveCard({
  move,
  stage,
  inclusion,
  now,
  busy,
  l1Wei,
  onProve,
  onFinalize,
}: {
  move: EthMove;
  stage: WithdrawalStage | "error" | undefined;
  inclusion: EthInclusion | "error" | undefined;
  now: number;
  busy: boolean;
  l1Wei: bigint | null;
  onProve: () => void;
  onFinalize: () => void;
}) {
  const toHemi = move.direction === "to-hemi";
  const noGas = !toHemi && l1Wei === 0n;
  const view = toHemi ? depositView(move, inclusion, now) : withdrawView(move, stage, now);
  const canProve = !view.done && stage != null && stage !== "error" && stage.kind === "ready-to-prove";
  const canFinalize = !view.done && stage != null && stage !== "error" && stage.kind === "ready-to-finalize";

  return (
    <article className="card item">
      <b>{toHemi ? "ETH → Hemi" : "Hemi → ETH"}</b>
      <div className="fine">{formatWhen(move.createdAt)} · {formatUnits(BigInt(move.amountWei), 18)} ETH</div>
      <StepStatus spinning={view.spinning || busy} step={busy ? "Submitting the next transaction" : view.step} message={view.message} eta={view.eta} />
      {noGas && !toHemi && !view.done && <p className="fine">Proving and finalizing need ETH on Ethereum for gas.</p>}
      <div className="actions">
        <a href={toHemi ? ethTxUrl(move.txHash) : hemiTxUrl(move.txHash)} target="_blank" rel="noreferrer">
          Transaction
        </a>
        {canProve && (
          <button className="btn primary" type="button" disabled={busy || noGas} onClick={onProve}>
            {busy ? "Proving…" : "Prove on Ethereum"}
          </button>
        )}
        {canFinalize && (
          <button className="btn primary" type="button" disabled={busy || noGas} onClick={onFinalize}>
            {busy ? "Finalizing…" : "Finalize on Ethereum"}
          </button>
        )}
      </div>
    </article>
  );
}

function depositView(move: EthMove, inclusion: EthInclusion | "error" | undefined, now: number): {
  spinning: boolean;
  step: string;
  message: string;
  eta: string;
  done: boolean;
} {
  if (move.status === "credited") {
    return {
      spinning: false,
      done: true,
      step: "Done · ETH is on Hemi",
      message: "The Hemi balance increased by this deposit.",
      eta: formatWhen(move.createdAt),
    };
  }
  if (inclusion === "failed") {
    return {
      spinning: false,
      done: false,
      step: "Deposit failed",
      message: "Ethereum included the transaction and it reverted. Nothing was bridged.",
      eta: "This move will not finish",
    };
  }
  if (inclusion == null || inclusion === "error" || inclusion === "pending") {
    return {
      spinning: true,
      done: false,
      step: "Step 1 of 2 · Waiting for Ethereum",
      message: inclusion === "error"
        ? "Could not read the Ethereum receipt. Still tracking this deposit."
        : "The deposit is in the Ethereum mempool.",
      eta: "The next Ethereum block is usually about 12 seconds",
    };
  }
  const readyAt = inclusion.timestamp * 1000 + ETH_DERIVE_SECONDS * 1000;
  return {
    spinning: true,
    done: false,
    step: "Step 2 of 2 · Hemi derivation",
    message: "Ethereum included the deposit. Hemi credits the same amount after it derives that block.",
    eta: now >= readyAt
      ? "The usual window has passed. This closes when the Hemi ETH balance increases."
      : formatRemain(readyAt, now),
  };
}

function withdrawView(move: EthMove, stage: WithdrawalStage | "error" | undefined, now: number): {
  spinning: boolean;
  step: string;
  message: string;
  eta: string;
  done: boolean;
} {
  if (move.status === "finalized" || (stage && stage !== "error" && stage.kind === "finalized")) {
    return {
      spinning: false,
      done: true,
      step: "Done · ETH is on Ethereum",
      message: "Finalize succeeded. The portal paid the withdrawal.",
      eta: formatWhen(move.createdAt),
    };
  }
  if (stage == null) {
    return {
      spinning: true,
      done: false,
      step: "Checking the portal",
      message: "Reading where this withdrawal is on Ethereum.",
      eta: "Checking…",
    };
  }
  if (stage === "error") {
    return {
      spinning: true,
      done: false,
      step: "Portal status unavailable",
      message: "The tracker will try again. The withdrawal is still saved on this device.",
      eta: "Retrying about every 20 seconds",
    };
  }
  if (stage.kind === "waiting-output") {
    const eta = stage.aboutSeconds == null
      ? "Time until the next output is unavailable"
      : stage.aboutSeconds <= 0
        ? "Any moment"
        : formatRemain(now + stage.aboutSeconds * 1000, now);
    return {
      spinning: true,
      done: false,
      step: "Step 1 of 4 · Waiting for a Hemi output",
      message: move.l2Block == null
        ? "A published Hemi output has to include this withdrawal."
        : `A published Hemi output has to include block ${move.l2Block.toLocaleString()}. Outputs are every 120 Hemi blocks, about 24 minutes.`,
      eta,
    };
  }
  if (stage.kind === "ready-to-prove") {
    return {
      spinning: true,
      done: false,
      step: "Step 2 of 4 · Prove on Ethereum",
      message: "An output includes this withdrawal. Proving is your Ethereum transaction.",
      eta: "Waiting on you",
    };
  }
  if (stage.kind === "waiting-finality") {
    return {
      spinning: true,
      done: false,
      step: "Step 3 of 4 · Finality wait",
      message: `Proven. Finalize is allowed after ${formatWhen(stage.readyAt * 1000)}. Both the proof and the output have to finish the 24 hour period.`,
      eta: formatRemain(stage.readyAt * 1000, now),
    };
  }
  return {
    spinning: true,
    done: false,
    step: "Step 4 of 4 · Finalize on Ethereum",
    message: "The wait is over. Finalizing pays the ETH out of the portal.",
    eta: "Waiting on you",
  };
}
