export function messageOf(err: unknown): string {
  if (err && typeof err === "object") {
    const row = err as { shortMessage?: string; reason?: string; message?: string };
    if (row.shortMessage) return row.shortMessage;
    if (row.reason) return row.reason;
    if (row.message) return row.message;
  }
  return "Something went wrong.";
}
