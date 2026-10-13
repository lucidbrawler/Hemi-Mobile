import type { ChainLeg } from "./hemi";

const KEY = "hemi-pending-activity";
const CAP = 24;

export type PendingActivity = {
  hash: string;
  /** Bitcoin address or Hemi address this row belongs to. */
  owner: string;
  when: number;
  title: string;
  detail: string;
  href: string;
  legs: ChainLeg[];
  /** Drop once Activity has this hash, or once a receipt exists. */
  clear: "indexed" | "mined";
};

export function readPending(): PendingActivity[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const rows = JSON.parse(raw) as PendingActivity[];
    if (!Array.isArray(rows)) return [];
    return rows.filter((row) => typeof row?.hash === "string" && typeof row.owner === "string");
  } catch {
    return [];
  }
}

export function rememberPending(row: PendingActivity): void {
  const hash = row.hash.toLowerCase();
  const next = [row, ...readPending().filter((item) => item.hash.toLowerCase() !== hash)].slice(0, CAP);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // A full browser store should not block the send that already landed.
  }
}

export function writePending(rows: PendingActivity[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(rows.slice(0, CAP)));
  } catch {
    // Same as rememberPending.
  }
}
