import { useEffect, useState } from "react";
import { formatUnits, formatWhen, parseUnits } from "../lib/format";
import { messageOf } from "../lib/errors";
import {
  STAKE_MIN_HEMI,
  STAKE_PRESETS,
  readStake,
  stakeNeedsApproval,
  stakeUnlockAt,
  stakeWeightLabel,
  type StakePosition,
  type StakePresetId,
} from "../lib/stake";
import { useWallet } from "../state";

function unlockLabel(end: number): string {
  if (end <= 0) return "—";
  return formatWhen(end * 1000);
}

export function StakeSheet({ onClose }: { onClose: () => void }) {
  const w = useWallet();
  const wallet = w.wallet!;
  const free = w.balances.hemiTokenWei;
  const [amount, setAmount] = useState("");
  const [term, setTerm] = useState<StakePresetId>("1y");
  const [sure, setSure] = useState(false);
  const [needsApproval, setNeedsApproval] = useState(false);
  const [positions, setPositions] = useState<StakePosition[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsed = parseUnits(amount, 18);
  const preset = STAKE_PRESETS.find((row) => row.id === term) ?? STAKE_PRESETS[1];
  const unlockAt = stakeUnlockAt(Math.floor(Date.now() / 1000), preset.seconds);
  const noGas = w.balances.ethWei == null || w.balances.ethWei === 0n;

  function reload() {
    void readStake(wallet.hemiAddress)
      .then(setPositions)
      .catch((err) => setError(messageOf(err)));
  }

  useEffect(() => {
    let live = true;
    void readStake(wallet.hemiAddress)
      .then((rows) => {
        if (live) setPositions(rows);
      })
      .catch((err) => {
        if (live) setError(messageOf(err));
      });
    return () => {
      live = false;
    };
  }, [wallet.hemiAddress]);

  useEffect(() => {
    if (parsed == null || parsed <= 0n) {
      setNeedsApproval(false);
      return;
    }
    let live = true;
    void stakeNeedsApproval(wallet.hemiAddress, parsed)
      .then((need) => {
        if (live) setNeedsApproval(need);
      })
      .catch(() => {
        if (live) setNeedsApproval(true);
      });
    return () => {
      live = false;
    };
  }, [parsed, wallet.hemiAddress]);

  const ready = parsed != null && parsed >= STAKE_MIN_HEMI && (free == null || parsed <= free) && !noGas && sure && !busy;
  const label = busy === "approve"
    ? "Approving…"
    : busy === "lock"
      ? "Locking…"
      : parsed == null || parsed <= 0n
        ? "Enter an amount"
        : parsed < STAKE_MIN_HEMI
          ? "Minimum is 10 HEMI"
          : free != null && parsed > free
            ? "Not enough HEMI"
            : w.balances.ethWei == null
              ? "Checking gas…"
              : w.balances.ethWei === 0n
                ? "Need ETH for gas"
              : !sure
                ? "Confirm on mainnet"
                : needsApproval
                  ? "Approve and lock"
                  : "Lock HEMI";

  return (
    <div className="sheet-back" onClick={onClose}>
      <form
        className="sheet stake-sheet"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready || parsed == null) return;
          setBusy("lock");
          setError(null);
          void w.stakeLock(parsed, BigInt(preset.seconds), setBusy)
            .then(() => {
              setAmount("");
              setSure(false);
              reload();
            })
            .catch((err) => setError(messageOf(err)))
            .finally(() => setBusy(null));
        }}
      >
        <div className="swap-top">
          <h2>Stake</h2>
          <span className="swap-spot">veHEMI</span>
        </div>
        <p className="hint">
          Lock HEMI for voting weight and epoch rewards. The lock rounds down to a 6 day epoch and cannot be opened early.
        </p>

        <label className="field">
          <span>
            You lock
            <b>{free == null ? "…" : `${formatUnits(free, 18)} HEMI`}</b>
          </span>
          <input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            placeholder="0"
            autoComplete="off"
          />
        </label>
        {free != null && free > 0n && (
          <button
            className="ghost"
            type="button"
            onClick={() => setAmount(formatUnits(free, 18))}
          >
            Max
          </button>
        )}

        <div className="rowline">
          <span>Lock</span>
          <div className="swap-routes">
            {STAKE_PRESETS.map((row) => (
              <button
                key={row.id}
                type="button"
                className={term === row.id ? "on" : ""}
                onClick={() => setTerm(row.id)}
              >
                {row.label}
              </button>
            ))}
          </div>
        </div>
        <div className="rowline">
          <span>Voting weight</span>
          <b>Starts near {stakeWeightLabel(preset.seconds)}</b>
        </div>
        <div className="rowline">
          <span>Unlocks</span>
          <b>{unlockLabel(unlockAt)}</b>
        </div>
        <p className="fine">
          Weight falls to zero at unlock. Rewards accrue by epoch in HEMI, hemiBTC, and USDC. A new lock is a transferable veHEMI position.
        </p>

        {error && <p className="banner bad">{error}</p>}
        <label className="check">
          <input type="checkbox" checked={sure} onChange={(event) => setSure(event.target.checked)} />
          <span>Broadcast this on mainnet.</span>
        </label>
        <button className={ready ? "btn primary wide" : "btn wide swap-wait"} disabled={!ready} type="submit">
          {label}
        </button>

        <div className="kicker" style={{ margin: "18px 0 10px" }}><span>Positions</span></div>
        {positions == null && !error && <p className="empty">Loading positions…</p>}
        {positions?.length === 0 && <p className="empty">No veHEMI positions on this address yet.</p>}
        <div className="list">
          {positions?.map((position) => {
            const owed = position.rewards?.some((reward) => reward.amount > 0n) ?? false;
            return (
              <div className="card stake-pos" key={position.tokenId}>
                <div className="rowline">
                  <span>Locked</span>
                  <b>{formatUnits(position.amount, 18)} HEMI</b>
                </div>
                <div className="rowline">
                  <span>Weight</span>
                  <b>{position.weight == null ? "—" : `${formatUnits(position.weight, 18)} veHEMI`}</b>
                </div>
                <div className="rowline">
                  <span>{position.expired ? "Unlocked" : "Unlocks"}</span>
                  <b>{unlockLabel(position.end)}</b>
                </div>
                <div className="rowline">
                  <span>Rewards</span>
                  <b>
                    {position.rewards == null
                      ? "Unavailable"
                      : position.rewards.length === 0
                        ? "None yet"
                        : position.rewards.map((reward) => `${formatUnits(reward.amount, reward.decimals)} ${reward.symbol}`).join(" · ")}
                  </b>
                </div>
                <div className="actions">
                  {owed && (
                    <button
                      className="ghost"
                      type="button"
                      disabled={!sure || busy != null || noGas}
                      onClick={() => {
                        setBusy("claim");
                        setError(null);
                        void w.stakeClaim(BigInt(position.tokenId))
                          .then(() => reload())
                          .catch((err) => setError(messageOf(err)))
                          .finally(() => setBusy(null));
                      }}
                    >
                      {busy === "claim" ? "Claiming…" : "Claim"}
                    </button>
                  )}
                  {position.expired && (
                    <button
                      className="ghost"
                      type="button"
                      disabled={!sure || busy != null || noGas}
                      onClick={() => {
                        setBusy("unlock");
                        setError(null);
                        void w.stakeUnlock(BigInt(position.tokenId), (phase) => setBusy(phase))
                          .then(() => reload())
                          .catch((err) => setError(messageOf(err)))
                          .finally(() => setBusy(null));
                      }}
                    >
                      {busy === "record" ? "Recording…" : busy === "unlock" ? "Unlocking…" : "Unlock HEMI"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </form>
    </div>
  );
}
