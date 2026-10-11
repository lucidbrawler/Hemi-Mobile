import { useEffect, useState } from "react";
import { formatUnits, formatWhen, parseUnits } from "../lib/format";
import { messageOf } from "../lib/errors";
import { celebrate } from "../lib/fx";
import {
  STAKE_MIN_HEMI,
  STAKE_PRESETS,
  type StakePosition,
  readStake,
  stakeNeedsApproval,
  stakeRewardLine,
  stakeUnlockAt,
  stakeWeightLabel,
  type StakePresetId,
} from "../lib/stake";
import { useWallet } from "../state";

function unlockLabel(end: number): string {
  if (end <= 0) return "—";
  return formatWhen(end * 1000);
}

function readyRewards(positions: StakePosition[]): string {
  const totals = new Map<string, { amount: bigint; decimals: number }>();
  for (const position of positions) {
    for (const reward of position.rewards ?? []) {
      if (reward.amount <= 0n) continue;
      const current = totals.get(reward.symbol) ?? { amount: 0n, decimals: reward.decimals };
      current.amount += reward.amount;
      totals.set(reward.symbol, current);
    }
  }
  return [...totals].map(([symbol, row]) => `${formatUnits(row.amount, row.decimals)} ${symbol}`).join(" · ");
}

type StakeMode = "lock" | "rewards";

export function StakeSheet({ onClose, initialMode = "lock" }: { onClose: () => void; initialMode?: StakeMode }) {
  const w = useWallet();
  const wallet = w.wallet!;
  const free = w.balances.hemiTokenWei;
  const [mode, setMode] = useState<StakeMode>(initialMode);
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

  const owed = (positions ?? []).filter((position) => position.rewards?.some((reward) => reward.amount > 0n));
  const readyText = readyRewards(owed);
  const canClaim = owed.length > 0 && sure && !noGas && busy == null;
  const claimLabel = busy === "claim"
    ? "Claiming…"
    : positions == null
      ? "Checking rewards…"
      : owed.length === 0
        ? "No rewards yet"
        : noGas
          ? "Need ETH for gas"
          : !sure
            ? "Confirm on mainnet"
            : "Claim rewards";

  async function claimPositions(rows: StakePosition[]) {
    if (rows.length === 0 || busy != null) return;
    setBusy("claim");
    setError(null);
    try {
      for (const position of rows) {
        await w.stakeClaim(BigInt(position.tokenId));
      }
      celebrate("Rewards claimed.");
      reload();
    } catch (err) {
      setError(messageOf(err));
      reload();
    } finally {
      setBusy(null);
    }
  }

  function setView(next: StakeMode) {
    setMode(next);
    setSure(false);
    setError(null);
  }

  const ready = mode === "lock" && parsed != null && parsed >= STAKE_MIN_HEMI && (free == null || parsed <= free) && !noGas && sure && !busy;
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
          <h2>{mode === "rewards" ? "Rewards" : "Stake"}</h2>
          <span className="swap-spot">veHEMI</span>
        </div>
        <div className="rowline">
          <span>View</span>
          <div className="swap-routes">
            <button type="button" className={mode === "lock" ? "on" : ""} onClick={() => setView("lock")}>Lock</button>
            <button type="button" className={mode === "rewards" ? "on" : ""} onClick={() => setView("rewards")}>Rewards</button>
          </div>
        </div>
        {mode === "rewards" ? (
          <StakeRewards
            positions={positions}
            error={error}
            sure={sure}
            setSure={setSure}
            busy={busy}
            noGas={noGas}
            owed={owed}
            readyText={readyText}
            canClaim={canClaim}
            claimLabel={claimLabel}
            claimPositions={claimPositions}
            onUnlock={(tokenId) => {
              setBusy("unlock");
              setError(null);
              void w.stakeUnlock(tokenId, (phase) => setBusy(phase))
                .then(() => reload())
                .catch((err) => setError(messageOf(err)))
                .finally(() => setBusy(null));
            }}
          />
        ) : (
          <>
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
          </>
        )}
      </form>
    </div>
  );
}

function StakeRewards({
  positions,
  error,
  sure,
  setSure,
  busy,
  noGas,
  owed,
  readyText,
  canClaim,
  claimLabel,
  claimPositions,
  onUnlock,
}: {
  positions: StakePosition[] | null;
  error: string | null;
  sure: boolean;
  setSure: (value: boolean) => void;
  busy: string | null;
  noGas: boolean;
  owed: StakePosition[];
  readyText: string;
  canClaim: boolean;
  claimLabel: string;
  claimPositions: (rows: StakePosition[]) => Promise<void>;
  onUnlock: (tokenId: bigint) => void;
}) {
  const rows = positions ?? [];
  const canAct = rows.some((position) => position.expired || position.rewards?.some((reward) => reward.amount > 0n));

  return (
    <div>
      <p className="fine">
        Epoch rewards accrue on each lock in HEMI, hemiBTC, and USDC. A claim sends whatever the position has earned to this wallet.
      </p>
      {positions == null && !error && <p className="empty">Loading positions…</p>}
      {positions != null && rows.length === 0 && (
        <p className="empty">No staked HEMI in this wallet yet. A lock creates one, and its epoch rewards show up here.</p>
      )}
      {rows.length > 0 && (
        <div className="rowline">
          <span>Ready to claim</span>
          <b>{readyText || "None yet"}</b>
        </div>
      )}
      {canAct && (
        <label className="check">
          <input type="checkbox" checked={sure} onChange={(event) => setSure(event.target.checked)} />
          <span>Broadcast this on mainnet.</span>
        </label>
      )}
      <div className="list">
        {rows.map((position) => {
          const hasRewards = position.rewards?.some((reward) => reward.amount > 0n) ?? false;
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
                <b>{stakeRewardLine(position)}</b>
              </div>
              {(hasRewards || position.expired) && (
                <div className="actions">
                  {hasRewards && (
                    <button
                      className="ghost"
                      type="button"
                      disabled={!sure || busy != null || noGas}
                      onClick={() => void claimPositions([position])}
                    >
                      {busy === "claim" ? "Claiming…" : !sure ? "Confirm on mainnet" : noGas ? "Need ETH for gas" : "Claim"}
                    </button>
                  )}
                  {position.expired && (
                    <button
                      className="ghost"
                      type="button"
                      disabled={!sure || busy != null || noGas}
                      onClick={() => onUnlock(BigInt(position.tokenId))}
                    >
                      {busy === "record" ? "Recording…" : busy === "unlock" ? "Unlocking…" : "Unlock HEMI"}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {owed.length > 1 && (
        <button
          className={canClaim ? "btn primary wide" : "btn wide swap-wait"}
          type="button"
          disabled={!canClaim}
          onClick={() => void claimPositions(owed)}
        >
          {claimLabel}
        </button>
      )}
      {error && <p className="banner bad">{error}</p>}
      {noGas && canAct && (
        <p className="fine">This Hemi address has no ETH for gas. Receive a small amount of ETH first.</p>
      )}
    </div>
  );
}
