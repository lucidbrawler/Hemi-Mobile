import { useEffect, useState } from "react";
import { messageOf } from "../lib/errors";
import { celebrate, pokeBuddy } from "../lib/fx";
import {
  loadMerklWallet,
  merklAmountLine,
  merklAmountUsd,
  merklClaimable,
  merklForPool,
  merklPayoutCoversMore,
  merklPayoutLine,
  merklTokenAddresses,
  type MerklWalletRewards,
} from "../lib/merkl";
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

/**
 * Live Merkl APR, claimable amount, and claim for one pool.
 * Renders nothing when that pool has no campaign and this wallet has not earned on it.
 */
export function MerklOnPosition({
  id,
  pool,
  inRange,
  shared,
  merkl,
  noGas,
}: {
  id: string;
  pool: string | null;
  inRange: boolean;
  shared: boolean;
  merkl: ReturnType<typeof useMerklRewards>;
  noGas: boolean;
}) {
  const [sure, setSure] = useState(false);
  const reward = merklForPool(merkl.data, pool);
  if (!reward || !merkl.data) return null;

  const ready = merkl.data.rewardsReady;
  const claimable = merklAmountLine(reward.tokens, "claimable");
  const pending = merklAmountLine(reward.tokens, "pending");
  const claimableUsd = merklAmountUsd(reward.tokens, merkl.book, "claimable");
  const paying = merklClaimable(reward, merkl.data.claims);
  const payout = merklPayoutLine(reward, merkl.data.claims);
  const more = merklPayoutCoversMore(reward, merkl.data.claims);
  const waitingProof = claimable != null && paying.length === 0;
  const rewardLabel = reward.reward && reward.reward !== "the reward token" ? reward.reward : "";
  const canClaim = paying.length > 0 && sure && !noGas && !merkl.busy;

  return (
    <div className="merkl-pos">
      {reward.apr != null && (
        <small>
          Merkl {formatIncentive(reward.apr)}
          {rewardLabel ? ` · ${rewardLabel}` : ""}
          {reward.endsAt > 0 ? ` · through ${campaignDate(reward.endsAt)}` : ""}
        </small>
      )}
      {reward.apr == null && rewardLabel && <small>Merkl · {rewardLabel}</small>}
      {reward.apr != null && !inRange && <small>Pays while the price is in range.</small>}
      {ready && claimable && <span>Claimable {claimable}</span>}
      {ready && claimable && claimableUsd && <span className="usd">{claimableUsd}</span>}
      {ready && !claimable && !pending && reward.apr != null && <span>Claimable none yet</span>}
      {ready && pending && <small>Pending {pending}. Not claimable until the next Merkl update.</small>}
      {ready && shared && (claimable != null || pending != null) && (
        <small>Every position in this pool shows this same balance.</small>
      )}
      {ready && waitingProof && <small>The Merkl proof for this reward is not ready.</small>}
      {ready && paying.length > 0 && payout && (
        <>
          <label className="check">
            <input type="checkbox" checked={sure} onChange={(event) => setSure(event.target.checked)} />
            <span>Broadcast this Merkl claim on mainnet.</span>
          </label>
          <small>{claimNote(payout, more)}</small>
          {noGas && <small>This Hemi address has no ETH for gas.</small>}
          <div className="actions">
            <button
              className="ghost"
              type="button"
              disabled={!canClaim}
              onClick={() => void merkl.claim(id, paying.map((token) => token.address))}
            >
              {merkl.busy ? "Claiming…" : !sure ? "Confirm on mainnet" : noGas ? "Need ETH for gas" : "Claim Merkl"}
            </button>
          </div>
        </>
      )}
      {merkl.errorFor === id && merkl.error && <small>{merkl.error}</small>}
    </div>
  );
}

function claimNote(payout: string, more: boolean): string {
  const base = `A claim sends ${payout} to this wallet.`;
  if (!more) return base;
  return `${base} Merkl pays each token in one proof, so this includes the same token earned in another pool.`;
}

function formatIncentive(percent: number): string {
  if (!Number.isFinite(percent) || percent < 0) return "Unavailable";
  if (percent === 0) return "0%";
  if (percent >= 10000) return ">10,000%";
  if (percent >= 100) return `${percent.toFixed(0)}%`;
  if (percent >= 10) return `${percent.toFixed(2)}%`;
  return `${percent.toFixed(2)}%`;
}

function campaignDate(unix: number): string {
  const date = new Date(unix * 1000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}
