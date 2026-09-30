import { useEffect, useState } from "react";
import { messageOf } from "../lib/errors";
import { createMnemonic } from "../lib/wallet";
import { useWallet } from "../state";
import { Brand } from "./mark";

export function Gate() {
  const wallet = useWallet();
  const [mode, setMode] = useState<"unlock" | "create" | "import">(wallet.saved ? "unlock" : "create");
  const [phrase, setPhrase] = useState("");
  const [draft, setDraft] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [wrote, setWrote] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode === "create" && !draft) setDraft(createMnemonic());
  }, [mode, draft]);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Brand subtitle="Native BTC and hemiBTC" />
      <p className="sub" style={{ marginTop: 0 }}>
        One wallet for Bitcoin and Hemi. The native tunnel sits on the next tab after you unlock.
      </p>
      <div className="choice">
        {wallet.saved && (
          <button className={mode === "unlock" ? "on" : ""} onClick={() => setMode("unlock")} type="button">
            Unlock
          </button>
        )}
        <button
          className={mode === "create" ? "on" : ""}
          onClick={() => {
            setDraft(createMnemonic());
            setWrote(false);
            setMode("create");
          }}
          type="button"
        >
          Create
        </button>
        <button className={mode === "import" ? "on" : ""} onClick={() => setMode("import")} type="button">
          Import
        </button>
      </div>

      {mode === "unlock" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => wallet.unlock(password));
          }}
        >
          <label className="field">
            <span>Password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
          <button className="btn primary wide" disabled={busy || password.length < 8} type="submit">
            {busy ? "Unlocking…" : "Unlock"}
          </button>
        </form>
      )}

      {mode === "create" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              if (password !== again) throw new Error("Passwords do not match.");
              if (!wrote) throw new Error("Confirm that you wrote the phrase down.");
              const mnemonic = draft || createMnemonic();
              await wallet.importPhrase(mnemonic, password);
            });
          }}
        >
          <ol className="words">
            {(draft || " ").split(" ").filter(Boolean).map((word, index) => (
              <li key={`${word}-${index}`}>
                <i>{index + 1}</i>
                {word}
              </li>
            ))}
          </ol>
          {!draft && (
            <button className="ghost wide" type="button" onClick={() => setDraft(createMnemonic())}>
              Generate phrase
            </button>
          )}
          <label className="field">
            <span>Password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </label>
          <label className="field">
            <span>Confirm password</span>
            <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
          </label>
          <label className="check">
            <input type="checkbox" checked={wrote} onChange={(e) => setWrote(e.target.checked)} />
            <span>I wrote the 12 words down. They stay on this device, encrypted, and cannot be recovered if I lose them.</span>
          </label>
          <button className="btn primary wide" disabled={busy || !draft || password.length < 8} type="submit">
            {busy ? "Saving…" : "Save wallet"}
          </button>
        </form>
      )}

      {mode === "import" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => wallet.importPhrase(phrase, password));
          }}
        >
          <label className="field">
            <span>Recovery phrase</span>
            <textarea value={phrase} onChange={(e) => setPhrase(e.target.value)} spellCheck={false} />
          </label>
          <label className="field">
            <span>New password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </label>
          <button className="btn primary wide" disabled={busy || password.length < 8} type="submit">
            {busy ? "Importing…" : "Import wallet"}
          </button>
        </form>
      )}

      {error && <p className="banner bad" style={{ marginTop: 12 }}>{error}</p>}
      {wallet.saved && mode !== "unlock" && (
        <button className="ghost danger wide" style={{ marginTop: 10 }} type="button" onClick={() => wallet.wipe()}>
          Erase saved wallet on this device
        </button>
      )}
      <p className="foot">
        Unofficial demo for holding native BTC and hemiBTC. Mainnet. Not affiliated with Hemi Labs. The phrase is encrypted in this browser with your password.
      </p>
    </div>
  );
}
