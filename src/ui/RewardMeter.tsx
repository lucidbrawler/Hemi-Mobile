import { formatUsd } from "../lib/format";
import { positionUsdAmount, type LpPosition } from "../lib/lpRewards";
import type { PriceBook } from "../lib/prices";

/** Unclaimed trading fees, drawn against the position value. Merkl has its own bar. */
export function PositionRewardBar({
  position,
  book,
}: {
  position: LpPosition;
  book: PriceBook | null;
}) {
  const feesUsd = positionUsdAmount(position, book, "fees");
  const positionUsd = positionUsdAmount(position, book, "size");
  const width = feeWidth(feesUsd, positionUsd);
  const note = feeNote(feesUsd, positionUsd);

  return (
    <div className="reward-meter">
      <div className="reward-track" role="img" aria-label={note}>
        {width > 0 ? <span className="reward-fees fill" style={{ width: `${width}%` }} /> : null}
      </div>
      <div className="reward-key">
        <span><i className="reward-fees" />Fees {feesUsd == null ? "…" : formatUsd(feesUsd)}</span>
      </div>
      <small className="reward-note">{note}</small>
    </div>
  );
}

function feeWidth(feesUsd: number | null, positionUsd: number | null): number {
  if (feesUsd == null || feesUsd <= 0) return 0;
  if (positionUsd == null || positionUsd <= 0) return 100;
  return Math.min(100, (feesUsd / Math.max(positionUsd, feesUsd)) * 100);
}

function feeNote(feesUsd: number | null, positionUsd: number | null): string {
  if (feesUsd == null) return "Fee value did not load.";
  if (feesUsd === 0) return "No trading fees unclaimed yet.";
  const total = formatUsd(feesUsd);
  if (positionUsd == null || positionUsd <= 0) return `${total} in trading fees.`;
  return `${total} in trading fees · ${percentText((feesUsd / positionUsd) * 100)} of this position.`;
}

function percentText(percent: number): string {
  if (percent > 0 && percent < 0.01) return "<0.01%";
  if (percent >= 1000) return `${Math.round(percent).toLocaleString("en-US")}%`;
  if (percent >= 10) return `${percent.toFixed(1)}%`;
  return `${percent.toFixed(2)}%`;
}
