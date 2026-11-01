export type RewardBarInput = {
  positionUsd: number | null;
  feesUsd: number | null;
  merklUsd: number | null;
  pendingUsd: number | null;
};

export type RewardBar = {
  /** Width of each segment as a percent of the track. */
  widths: { fees: number; merkl: number; pending: number };
  rewardUsd: number;
  /**
   * Unclaimed rewards as a percent of the position.
   * Null when the position value is missing or a reward price is missing.
   */
  percentOfPosition: number | null;
  /** True when fees, Merkl, and pending each have a number, including zero. */
  complete: boolean;
};

/** How full the reward track is. The position value is the scale, until rewards pass it. */
export function rewardBar(input: RewardBarInput): RewardBar {
  const fees = positive(input.feesUsd);
  const merkl = positive(input.merklUsd);
  const pending = positive(input.pendingUsd);
  const complete = isNumber(input.feesUsd) && isNumber(input.merklUsd) && isNumber(input.pendingUsd);
  const rewardUsd = fees + merkl + pending;
  const position = input.positionUsd != null && input.positionUsd > 0 && Number.isFinite(input.positionUsd)
    ? input.positionUsd
    : null;
  const scale = position != null ? Math.max(position, rewardUsd) : rewardUsd;
  const width = (usd: number) => (scale > 0 && usd > 0 ? (usd / scale) * 100 : 0);
  return {
    widths: { fees: width(fees), merkl: width(merkl), pending: width(pending) },
    rewardUsd,
    percentOfPosition: complete && position != null ? (rewardUsd / position) * 100 : null,
    complete,
  };
}

function isNumber(value: number | null): value is number {
  return value != null && Number.isFinite(value) && value >= 0;
}

function positive(value: number | null): number {
  return isNumber(value) ? value : 0;
}
