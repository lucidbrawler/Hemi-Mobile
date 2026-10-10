type BuddyCue = { kind: "send" | "done"; line: string };

export function pokeBuddy(line = "Sending.") {
  const cue: BuddyCue = { kind: "send", line };
  window.dispatchEvent(new CustomEvent("hemi-buddy", { detail: cue }));
}

/** Short completion moment after a send, swap, or reward claim. */
export function celebrate(line: string) {
  const cue: BuddyCue = { kind: "done", line };
  window.dispatchEvent(new CustomEvent("hemi-buddy", { detail: cue }));
  window.dispatchEvent(new CustomEvent("hemi-done", { detail: line }));
}
