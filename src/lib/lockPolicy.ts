/** Lock an open wallet after this much time with no taps or key presses. */
export const IDLE_LOCK_MS = 5 * 60 * 1000;

export function shouldAutoLock(input: { visibility: "visible" | "hidden"; idleMs: number }): boolean {
  return input.visibility === "hidden" || input.idleMs >= IDLE_LOCK_MS;
}
