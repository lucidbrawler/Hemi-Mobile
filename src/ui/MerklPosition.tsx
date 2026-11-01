import { useEffect, useState } from "react";
import { messageOf } from "../lib/errors";
import { formatUnits, formatUsd } from "../lib/format";
import { celebrate, pokeBuddy } from "../lib/fx";
import {
  loadMerklWallet,
  merklAmountLine,
  merklAmountValue,
  merklClaimable,
  merklForPool,
  merklPayoutCoversMore,
  merklPayoutLine,
  merklTokenAddresses,
  type MerklAmount,
  type MerklWalletRewards,
} from "../lib/merkl";
import { poolById } from "../lib/pool";
import { useWallet } from "../state";
import { usePrices } from "./usePrices";

/** This wallet's Merkl incentives, shared by every position card on the screen. */
export function useMerklRewards(owner: string, reloadKey = 0) {
  const w = useWallet();
  const [tick, setTick] = useState(0);
  const [data, setData] = useState<MerklWalletRewards | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorFor, setErrorFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const book = usePrices(merklTokenAddresses(data));

  useEffect(() => {
    let cancel = false;
    void loadMerklWallet(owner, tick > 0 || reloadKey > 0).then(
      (next) => { if (!cancel) setData(next); },
      () => { if (!cancel) setData(null); },
    );
    return () => { cancel = true; };
  }, [owner, tick, reloadKey]);

  async function claim(id: string, tokens: string[]) {
    if (busy || tokens.length === 0) return;
    setBusy(true);
    setErrorFor(id);
    setError(null);
    pokeBuddy("Claiming.");
    try {
      await w.claimMerkl(tokens);
      celebrate("Rewards claimed.");
      setTick((value) => value + 1);
    } catch (err) {
      setError(messageOf(err));
      setTick((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }

  return { data, book, busy, errorFor, error, claim };
}

export type RewardView = "fees" | "merkl";

/** Fees is the position view. Merkl swaps that same card over to campaign rewards. */
export function RewardViewToggle({
  view,
  onChange,
}: {
  view: RewardView;
  onChange: (view: RewardView) => void;
}) {
  return (
    <div className="seg" role="group" aria-label="Position rewards">
      <button type="button" className={view === "fees" ? "on" : ""} aria-pressed={view === "fees"} onClick={() => onChange("fees")}>Fees</button>
      <button type="button" className={view === "merkl" ? "on" : ""} aria-pressed={view === "merkl"} onClick={() => onChange("merkl")}>Merkl</button>
    </div>
  );
}

export function positionPoolAddress(poolId: string): string {
  return poolById(poolId)?.pool.toLowerCase() ?? "";
}

/**
 * True for the first open position whose pool can claim a token.
 * Later positions in this render that share the token stay quiet.
 */
export function offerMerklClaim(data: MerklWalletRewards | null, pool: string, seen: Set<string>): boolean {
  if (!data || !pool) return false;
  const reward = merklForPool(data, pool);
  if (!reward) return false;
  const tokens = merklClaimable(reward, data.claims);
  if (tokens.length === 0 || tokens.every((token) => seen.has(token.address))) return false;
  for (const token of tokens) seen.add(token.address);
  return true;
}

/** Merkl claimable and pending for one open position's pool. */
export function PositionMerkl({
  pool,
  merkl,
  noGas,
  offerClaim,
}: {
  pool: string;
  merkl: ReturnType<typeof useMerklRewards>;
  noGas: boolean;
  offerClaim: boolean;
}) {
  const [sure, setSure] = useState(false);
  const data = merkl.data;
  const claimId = `merkl-${pool}`;
  if (!data) return <p className="fine">Loading Merkl rewards…</p>;
  if (!data.rewardsReady) return <p className="fine">Merkl rewards did not load.</p>;

  const reward = merklForPool(data, pool);
  const rows = reward?.tokens.filter((token) => token.claimable > 0n || token.pending > 0n) ?? [];
  if (!reward || rows.length === 0) return <small>No Merkl rewards on this position.</small>;

  const paying = merklClaimable(reward, data.claims);
  const payout = merklPayoutLine(reward, data.claims) ?? "";
  const coversMore = merklPayoutCoversMore(reward, data.claims);
  const waitingProof = rows.some((token) => (
    token.claimable > 0n
    && !data.claims.some((claim) => claim.address === token.address && claim.claimable > 0n && claim.proofs != null)
  ));
  const canClaim = offerClaim && paying.length > 0 && sure && !noGas && !merkl.busy;
  const claimableUsd = merklAmountValue(rows, merkl.book, "claimable");
  const pendingUsd = merklAmountValue(rows, merkl.book, "pending");
  const track = merklTrack(rows, claimableUsd, pendingUsd);

  return (
    <div className="merkl-pos">
      <div className="reward-meter">
        <div className="reward-track" role="img" aria-label={track.label}>
          {track.claimable > 0 ? <span className="reward-merkl fill" style={{ width: `${track.claimable}%` }} /> : null}
          {track.pending > 0 ? <span className="reward-pending fill" style={{ width: `${track.pending}%` }} /> : null}
        </div>
        <div className="reward-key">
          <span><i className="reward-merkl" />Claimable {tokenLine(rows, "claimable")}{usdSuffix(claimableUsd)}</span>
          <span><i className="reward-pending" />Pending {tokenLine(rows, "pending")}{usdSuffix(pendingUsd)}</span>
        </div>
      </div>
      {waitingProof && <small>The Merkl proof for this reward is not ready.</small>}
      {offerClaim && paying.length > 0 && payout && (
        <>
          <label className="check">
            <input type="checkbox" checked={sure} onChange={(event) => setSure(event.target.checked)} />
            <span>Broadcast this Merkl claim on mainnet.</span>
          </label>
          <small>
            {coversMore
              ? `A claim sends ${payout} to this wallet. Merkl pays this token's full balance.`
              : `A claim sends ${payout} to this wallet.`}
          </small>
          {noGas && <small>This Hemi address has no ETH for gas.</small>}
          <div className="actions">
            <button
              className={canClaim ? "btn primary" : "ghost"}
              type="button"
              disabled={!canClaim}
              onClick={() => void merkl.claim(claimId, paying.map((token) => token.address))}
            >
              {merkl.busy ? "Claiming…" : noGas ? "Need ETH for gas" : "Claim Merkl"}
            </button>
          </div>
        </>
      )}
      {merkl.errorFor === claimId && merkl.error && <small>{merkl.error}</small>}
    </div>
  );
}

function merklTrack(
  rows: readonly MerklAmount[],
  claimableUsd: number | null,
  pendingUsd: number | null,
): { claimable: number; pending: number; label: string } {
  const priced = claimableUsd != null && pendingUsd != null;
  const claimableScore = priced ? claimableUsd : amountScore(rows, "claimable");
  const pendingScore = priced ? pendingUsd : amountScore(rows, "pending");
  const scale = claimableScore + pendingScore;
  const width = (score: number) => (scale > 0 && score > 0 ? (score / scale) * 100 : 0);
  const claimableText = tokenLine(rows, "claimable");
  const pendingText = tokenLine(rows, "pending");
  const claimableLabel = claimableText === "0" ? "" : `${claimableText} ready to claim.`;
  const pendingLabel = pendingText === "0" ? "" : `${pendingText} pending the next Merkl update.`;
  return {
    claimable: width(claimableScore),
    pending: width(pendingScore),
    label: `${claimableLabel} ${pendingLabel}`.trim(),
  };
}

function amountScore(rows: readonly MerklAmount[], field: "claimable" | "pending"): number {
  let total = 0;
  for (const token of rows) {
    const value = Number(formatUnits(token[field], token.decimals));
    if (Number.isFinite(value) && value > 0) total += value;
  }
  return total;
}

function tokenLine(rows: readonly MerklAmount[], field: "claimable" | "pending"): string {
  return merklAmountLine(rows, field) ?? "0";
}

function usdSuffix(usd: number | null): string {
  if (usd == null || usd <= 0) return "";
  return ` · ${formatUsd(usd)}`;
}


