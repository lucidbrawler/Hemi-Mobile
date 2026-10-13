import { useEffect, useState } from "react";
import { formatLockRemain, formatUnits, formatWhen, parseUnits } from "../lib/format";
import { messageOf } from "../lib/errors";
import { celebrate } from "../lib/fx";
import {
  STAKE_MIN_HEMI,
  STAKE_PRESETS,
  type StakeExtend,
  type StakePosition,
  readStake,
  stakeExtensions,
  stakeNeedsApproval,
  stakeLockedUsd,
  stakeRewardLine,
  stakeRewardTokens,
  stakeRewardsUsd,
  stakeUnlockAt,
  stakeWeight,
  stakeWeightLabel,
  type StakePresetId,
} from "../lib/stake";
import { useWallet } from "../state";
import { usePrices } from "./usePrices";

function unlockLabel(end: number): string {
  if (end <= 0) return "—";
  return formatWhen(end * 1000);
}

function unlockLine(end: number, nowSec: number): string {
  if (end <= 0) return "—";
  const when = `${formatWhen(end * 1000)} · ${formatLockRemain(end)}`;
  return stakeExtensions(nowSec, end).length === 0 ? `${when} · Longest lock` : when;
}

function veAbout(amount: bigint): string {
  const text = formatUnits(amount, 18);
  const dot = text.indexOf(".");
  if (dot < 0) return text;
  const frac = text.slice(dot + 1, dot + 5).replace(/0+$/, "");
  return frac ? `${text.slice(0, dot)}.${frac}` : text.slice(0, dot);
}

function weightPreview(from: bigint, next: bigint): string {
  const left = veAbout(from);
  if (from === next) return `Weight stays about ${left} veHEMI`;
  return `Weight goes from ${left} to about ${veAbout(next)} veHEMI`;
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
export type StakeFocus = { tokenId: string; action: "add" | "extend" };

export function StakeSheet({
  onClose,
  initialMode = "lock",
  focus = null,
}: {
  onClose: () => void;
  initialMode?: StakeMode;
  focus?: StakeFocus | null;
}) {
  const w = useWallet();
  const wallet = w.wallet!;
  const free = w.balances.hemiTokenWei;
  const [mode, setMode] = useState<StakeMode>(initialMode);
  const [amount, setAmount] = useState("");
  const [addAmount, setAddAmount] = useState("");
  const [extendId, setExtendId] = useState("");
  const [manage, setManage] = useState<StakeFocus | null>(focus);
  const [term, setTerm] = useState<StakePresetId>("1y");
  const [sure, setSure] = useState(false);
  const [needsApproval, setNeedsApproval] = useState(false);
  const [positions, setPositions] = useState<StakePosition[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsed = parseUnits(amount, 18);
  const addParsed = parseUnits(addAmount, 18);
  const approvalAmount = mode === "rewards" && manage?.action === "add" ? addParsed : mode === "lock" ? parsed : null;
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
    if (approvalAmount == null || approvalAmount <= 0n) {
      setNeedsApproval(false);
      return;
    }
    let live = true;
    void stakeNeedsApproval(wallet.hemiAddress, approvalAmount)
      .then((need) => {
        if (live) setNeedsApproval(need);
      })
      .catch(() => {
        if (live) setNeedsApproval(true);
      });
    return () => {
      live = false;
    };
  }, [approvalAmount, wallet.hemiAddress]);

  useEffect(() => {
    if (focus?.action !== "extend" || positions == null) return;
    const position = positions.find((row) => row.tokenId === focus.tokenId);
    if (!position) return;
    const choices = stakeExtensions(Math.floor(Date.now() / 1000), position.end);
    setExtendId(choices[choices.length - 1]?.id ?? "");
  }, [focus, positions]);

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
    setManage(null);
    setSure(false);
    setError(null);
  }

  function openManage(position: StakePosition, action: "add" | "extend") {
    setManage({ tokenId: position.tokenId, action });
    setError(null);
    if (action === "extend") {
      const choices = stakeExtensions(Math.floor(Date.now() / 1000), position.end);
      setExtendId(choices[choices.length - 1]?.id ?? "");
    }
  }

  function addToLock(tokenId: string) {
    if (addParsed == null || addParsed <= 0n || busy != null) return;
    setBusy("add");
    setError(null);
    void w.stakeAdd(BigInt(tokenId), addParsed, setBusy)
      .then(() => {
        setAddAmount("");
        setSure(false);
        setManage(null);
        reload();
      })
      .catch((err) => {
        setError(messageOf(err));
        reload();
      })
      .finally(() => setBusy(null));
  }

  function extendLock(tokenId: string, extend: StakeExtend) {
    if (busy != null) return;
    setBusy("extend");
    setError(null);
    void w.stakeExtend(BigInt(tokenId), extend)
      .then(() => {
        setSure(false);
        setManage(null);
        reload();
      })
      .catch((err) => {
        setError(messageOf(err));
        reload();
      })
      .finally(() => setBusy(null));
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
            free={free}
            manage={manage}
            addAmount={addAmount}
            setAddAmount={setAddAmount}
            addParsed={addParsed}
            extendId={extendId}
            setExtendId={setExtendId}
            needsApproval={needsApproval}
            openManage={openManage}
            addToLock={addToLock}
            extendLock={extendLock}
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
          Lock HEMI for voting weight and epoch rewards. The lock rounds down to a 6 day epoch and cannot be opened early. More HEMI, or more time, goes on a lock you already have from Rewards.
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
  free,
  manage,
  addAmount,
  setAddAmount,
  addParsed,
  extendId,
  setExtendId,
  needsApproval,
  openManage,
  addToLock,
  extendLock,
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
  free: bigint | null;
  manage: StakeFocus | null;
  addAmount: string;
  setAddAmount: (value: string) => void;
  addParsed: bigint | null;
  extendId: string;
  setExtendId: (value: string) => void;
  needsApproval: boolean;
  openManage: (position: StakePosition, action: "add" | "extend") => void;
  addToLock: (tokenId: string) => void;
  extendLock: (tokenId: string, extend: StakeExtend) => void;
  onUnlock: (tokenId: bigint) => void;
}) {
  const rows = positions ?? [];
  const book = usePrices(stakeRewardTokens(positions));
  const readyValue = stakeRewardsUsd(owed.flatMap((position) => position.rewards ?? []), book);
  const nowSec = Math.floor(Date.now() / 1000);
  const canAct = rows.some((position) => position.expired || position.rewards?.some((reward) => reward.amount > 0n));

  return (
    <div>
      <p className="fine">
        Epoch rewards accrue on each lock in HEMI, hemiBTC, and USDC. A running lock can take more HEMI, and more time when a later unlock still fits inside 4 years.
      </p>
      {positions == null && !error && <p className="empty">Loading positions…</p>}
      {positions != null && rows.length === 0 && (
        <p className="empty">No staked HEMI in this wallet yet. A lock creates one, and its epoch rewards show up here.</p>
      )}
      {rows.length > 0 && (
        <>
          <div className="rowline">
            <span>Ready to claim</span>
            <b>{readyText || "None yet"}</b>
          </div>
          {readyValue && (
            <div className="rowline">
              <span>Value</span>
              <b>{readyValue}</b>
            </div>
          )}
        </>
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
          const lockedUsd = stakeLockedUsd(position, book);
          const rewardUsd = stakeRewardsUsd(position.rewards, book);
          return (
            <div className="card stake-pos" key={position.tokenId}>
              <div className="rowline">
                <span>Locked</span>
                <b>{formatUnits(position.amount, 18)} HEMI</b>
              </div>
              {lockedUsd && (
                <div className="rowline">
                  <span>Value</span>
                  <b>{lockedUsd}</b>
                </div>
              )}
              <div className="rowline">
                <span>Weight</span>
                <b>{position.weight == null ? "—" : `${formatUnits(position.weight, 18)} veHEMI`}</b>
              </div>
              <div className="rowline">
                <span>{position.expired ? "Unlocked" : "Unlocks"}</span>
                <b>{position.expired ? unlockLabel(position.end) : unlockLine(position.end, nowSec)}</b>
              </div>
              <div className="rowline">
                <span>Rewards</span>
                <b>{stakeRewardLine(position)}</b>
              </div>
              {rewardUsd && (
                <div className="rowline">
                  <span>Reward value</span>
                  <b>{rewardUsd}</b>
                </div>
              )}
              {!position.expired && (
                <LockManage
                  position={position}
                  nowSec={nowSec}
                  free={free}
                  open={manage?.tokenId === position.tokenId ? manage.action : null}
                  addAmount={addAmount}
                  setAddAmount={setAddAmount}
                  addParsed={addParsed}
                  extendId={extendId}
                  setExtendId={setExtendId}
                  needsApproval={needsApproval}
                  sure={sure}
                  setSure={setSure}
                  busy={busy}
                  noGas={noGas}
                  onOpen={(action) => openManage(position, action)}
                  onAdd={() => addToLock(position.tokenId)}
                  onExtend={(extend) => extendLock(position.tokenId, extend)}
                />
              )}
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
      {noGas && (canAct || manage != null) && (
        <p className="fine">This Hemi address has no ETH for gas. Receive a small amount of ETH first.</p>
      )}
    </div>
  );
}

function LockManage({
  position,
  nowSec,
  free,
  open,
  addAmount,
  setAddAmount,
  addParsed,
  extendId,
  setExtendId,
  needsApproval,
  sure,
  setSure,
  busy,
  noGas,
  onOpen,
  onAdd,
  onExtend,
}: {
  position: StakePosition;
  nowSec: number;
  free: bigint | null;
  open: "add" | "extend" | null;
  addAmount: string;
  setAddAmount: (value: string) => void;
  addParsed: bigint | null;
  extendId: string;
  setExtendId: (value: string) => void;
  needsApproval: boolean;
  sure: boolean;
  setSure: (value: boolean) => void;
  busy: string | null;
  noGas: boolean;
  onOpen: (action: "add" | "extend") => void;
  onAdd: () => void;
  onExtend: (extend: StakeExtend) => void;
}) {
  const choices = stakeExtensions(nowSec, position.end);
  const selected = choices.find((choice) => choice.id === extendId) ?? choices[choices.length - 1] ?? null;
  const fromWeight = stakeWeight(position.amount, position.end, nowSec);
  const addWeight = addParsed != null && addParsed > 0n
    ? stakeWeight(position.amount + addParsed, position.end, nowSec)
    : null;
  const extendWeight = selected == null ? null : stakeWeight(position.amount, selected.unlockAt, nowSec);
  const addReady = open === "add" && addParsed != null && addParsed > 0n && (free == null || addParsed <= free) && sure && !noGas && busy == null;
  const extendReady = open === "extend" && selected != null && sure && !noGas && busy == null;
  const addLabel = busy === "approve"
    ? "Approving…"
    : busy === "add"
      ? "Adding…"
      : addParsed == null || addParsed <= 0n
        ? "Enter an amount"
        : free != null && addParsed > free
          ? "Not enough HEMI"
          : noGas
            ? "Need ETH for gas"
            : !sure
              ? "Confirm on mainnet"
              : needsApproval
                ? "Approve and add"
                : "Add HEMI";
  const extendLabel = busy === "extend"
    ? "Extending…"
    : noGas
      ? "Need ETH for gas"
      : !sure
        ? "Confirm on mainnet"
        : selected == null
          ? "No later unlock"
          : "Add time";

  return (
    <div>
      <div className="actions">
        <button className="ghost" type="button" disabled={busy != null} onClick={() => onOpen("add")}>Add HEMI</button>
        {choices.length > 0 && (
          <button className="ghost" type="button" disabled={busy != null} onClick={() => onOpen("extend")}>Add time</button>
        )}
      </div>
      {choices.length === 0 && <p className="fine">This lock is already as long as it can be.</p>}
      {open === "add" && (
        <>
          <label className="field">
            <span>
              Add HEMI
              <b>{free == null ? "…" : `${formatUnits(free, 18)} free`}</b>
            </span>
            <input
              value={addAmount}
              onChange={(event) => setAddAmount(event.target.value)}
              inputMode="decimal"
              placeholder="0"
              autoComplete="off"
            />
          </label>
          {free != null && free > 0n && (
            <button className="ghost" type="button" onClick={() => setAddAmount(formatUnits(free, 18))}>Max</button>
          )}
          <p className="fine">This stays in the same lock and keeps the same unlock date.</p>
          {addWeight != null && <p className="fine">{weightPreview(fromWeight, addWeight)}</p>}
          <label className="check">
            <input type="checkbox" checked={sure} onChange={(event) => setSure(event.target.checked)} />
            <span>Broadcast this on mainnet.</span>
          </label>
          <button className={addReady ? "btn primary wide" : "btn wide swap-wait"} type="button" disabled={!addReady} onClick={onAdd}>
            {addLabel}
          </button>
        </>
      )}
      {open === "extend" && choices.length > 0 && selected && (
        <>
          <div className="rowline">
            <span>Add</span>
            <div className="swap-routes">
              {choices.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  className={selected.id === choice.id ? "on" : ""}
                  onClick={() => setExtendId(choice.id)}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </div>
          <div className="rowline">
            <span>New unlock</span>
            <b>{unlockLabel(selected.unlockAt)} · {formatLockRemain(selected.unlockAt)}</b>
          </div>
          {extendWeight != null && <p className="fine">{weightPreview(fromWeight, extendWeight)}</p>}
          <label className="check">
            <input type="checkbox" checked={sure} onChange={(event) => setSure(event.target.checked)} />
            <span>Broadcast this on mainnet.</span>
          </label>
          <button
            className={extendReady ? "btn primary wide" : "btn wide swap-wait"}
            type="button"
            disabled={!extendReady}
            onClick={() => onExtend(selected.extend)}
          >
            {extendLabel}
          </button>
        </>
      )}
    </div>
  );
}
