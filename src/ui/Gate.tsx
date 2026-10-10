import { useEffect, useMemo, useState } from "react";
import { messageOf } from "../lib/errors";
import { shortAddr } from "../lib/format";
import { createMnemonic, deriveWallet } from "../lib/wallet";
import type { SavedWallet } from "../lib/storage";
import { useWallet } from "../state";
import { Brand } from "./mark";

type Mode = "list" | "unlock" | "create" | "import";

export function Gate() {
  const wallet = useWallet();
  const [mode, setMode] = useState<Mode>(wallet.wallets.length ? "list" : "create");
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [phrase, setPhrase] = useState("");
  const [draft, setDraft] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [twoFactor, setTwoFactor] = useState(false);
  const [wrote, setWrote] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  useEffect(() => {
    if (mode === "create" && !draft) setDraft(createMnemonic());
  }, [mode, draft]);

  useEffect(() => {
    if (wallet.wallets.length === 0 && (mode === "list" || mode === "unlock")) setMode("create");
  }, [wallet.wallets.length, mode]);

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

  function resetSecrets() {
    setPassword("");
    setAgain("");
    setTwoFactor(false);
    setError(null);
    setConfirmRemove(null);
  }

  const passkey = wallet.passkeyReady;
  const needPassword = !passkey || twoFactor;
  const chosen = wallet.wallets.find((row) => row.name === selected) ?? null;

  return (
    <div>
      <Brand subtitle="BTC, hemiBTC, ETH, HEMI, and VUSD" />
      <p className="sub" style={{ marginTop: 0 }}>
        One phrase holds Bitcoin and a Hemi address. That address receives tunneled BTC and ETH. Saved wallets stay on this device.
      </p>
      <div className="choice">
        {wallet.wallets.length > 0 && (
          <button className={mode === "list" || mode === "unlock" ? "on" : ""} onClick={() => { resetSecrets(); setMode("list"); }} type="button">
            Saved
          </button>
        )}
        <button
          className={mode === "create" ? "on" : ""}
          onClick={() => {
            setDraft(createMnemonic());
            setWrote(false);
            setName("");
            resetSecrets();
            setMode("create");
          }}
          type="button"
        >
          Create
        </button>
        <button className={mode === "import" ? "on" : ""} onClick={() => { setName(""); resetSecrets(); setMode("import"); }} type="button">
          Import
        </button>
      </div>

      {mode === "list" && (
        <WalletList
          rows={wallet.wallets}
          confirmRemove={confirmRemove}
          onOpen={(row) => {
            resetSecrets();
            setSelected(row.name);
            setMode("unlock");
          }}
          onRemove={(rowName) => {
            if (confirmRemove !== rowName) {
              setConfirmRemove(rowName);
              return;
            }
            void run(() => wallet.removeWallet(rowName));
          }}
        />
      )}

      {mode === "unlock" && chosen && (
        <UnlockForm
          row={chosen}
          busy={busy}
          password={password}
          setPassword={setPassword}
          again={again}
          setAgain={setAgain}
          onPasskey={() => void run(() => wallet.unlockPasskey(chosen.name))}
          onPassword={() => void run(() => wallet.unlockPassword(chosen.name, password))}
          on2fa={() => void run(() => wallet.unlock2fa(chosen.name, password))}
          onBack={() => { resetSecrets(); setMode("list"); }}
        />
      )}

      {mode === "create" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              if (!wrote) throw new Error("Confirm that you wrote the phrase down.");
              assertPassword(needPassword, password, again);
              await wallet.saveWallet(name, draft || createMnemonic(), {
                twoFactor: passkey && twoFactor,
                password: needPassword ? password : undefined,
              });
            });
          }}
        >
          <NameField name={name} setName={setName} />
          <ol className="words">
            {(draft || " ").split(" ").filter(Boolean).map((word, index) => (
              <li key={`${word}-${index}`}>
                <i>{index + 1}</i>
                {word}
              </li>
            ))}
          </ol>
          <CreatedWallets phrase={draft} />
          <SaveAuth
            passkey={passkey}
            native={wallet.passkeyKind === "native"}
            passkeyNote={wallet.passkeyNote}
            twoFactor={twoFactor}
            setTwoFactor={setTwoFactor}
            password={password}
            setPassword={setPassword}
            again={again}
            setAgain={setAgain}
          />
          <label className="check">
            <input type="checkbox" checked={wrote} onChange={(e) => setWrote(e.target.checked)} />
            <span>I wrote the 12 words down. They stay on this device and cannot be recovered if I lose them.</span>
          </label>
          <button className="btn primary wide" disabled={busy || !draft || !wrote || !name.trim() || (needPassword && password.length < 8)} type="submit">
            {saveLabel(busy, passkey, twoFactor)}
          </button>
        </form>
      )}

      {mode === "import" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              assertPassword(needPassword, password, again);
              await wallet.saveWallet(name, phrase, {
                twoFactor: passkey && twoFactor,
                password: needPassword ? password : undefined,
              });
            });
          }}
        >
          <NameField name={name} setName={setName} />
          <label className="field">
            <span>Recovery phrase</span>
            <textarea value={phrase} onChange={(e) => setPhrase(e.target.value)} spellCheck={false} />
          </label>
          <CreatedWallets phrase={phrase} />
          <SaveAuth
            passkey={passkey}
            native={wallet.passkeyKind === "native"}
            passkeyNote={wallet.passkeyNote}
            twoFactor={twoFactor}
            setTwoFactor={setTwoFactor}
            password={password}
            setPassword={setPassword}
            again={again}
            setAgain={setAgain}
          />
          <button className="btn primary wide" disabled={busy || !name.trim() || phrase.trim().split(/\s+/).length < 12 || (needPassword && password.length < 8)} type="submit">
            {saveLabel(busy, passkey, twoFactor)}
          </button>
        </form>
      )}

      {error && <p className="banner bad" style={{ marginTop: 12 }}>{error}</p>}
      <p className="foot">
        Unofficial demo for holding native BTC, hemiBTC, ETH, HEMI, and VUSD. Mainnet. Not affiliated with Hemi Labs. Each name is a wallet saved on this device. Passkey is the unlock. A password is the optional second factor.
      </p>
    </div>
  );
}

function authLabel(row: SavedWallet): string {
  if (row.require2fa) return "Password + passkey";
  if (row.hasPasskey) return "Passkey";
  return "Password";
}

function WalletList({
  rows,
  confirmRemove,
  onOpen,
  onRemove,
}: {
  rows: SavedWallet[];
  confirmRemove: string | null;
  onOpen: (row: SavedWallet) => void;
  onRemove: (name: string) => void;
}) {
  return (
    <div className="wallet-list">
      <p className="hint">{rows.length} saved on this device. Pick one to unlock it.</p>
      {rows.map((row) => (
        <div className="wallet-row" key={row.name}>
          <button type="button" onClick={() => onOpen(row)}>
            <b>{row.name}</b>
            <small>{row.addressHint ? shortAddr(row.addressHint, 10, 6) : "Bitcoin address hidden until unlock"}</small>
            <small className="tag">{authLabel(row)}</small>
          </button>
          <button className="ghost danger" type="button" onClick={() => onRemove(row.name)}>
            {confirmRemove === row.name ? "Erase this wallet" : "Remove"}
          </button>
        </div>
      ))}
    </div>
  );
}

function UnlockForm({
  row,
  busy,
  password,
  setPassword,
  again,
  setAgain,
  onPasskey,
  onPassword,
  on2fa,
  onBack,
}: {
  row: SavedWallet;
  busy: boolean;
  password: string;
  setPassword: (value: string) => void;
  again: string;
  setAgain: (value: string) => void;
  onPasskey: () => void;
  onPassword: () => void;
  on2fa: () => void;
  onBack: () => void;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (row.require2fa) on2fa();
        else if (row.hasPasskey) onPasskey();
        else onPassword();
      }}
    >
      <p className="hint">Unlock {row.name}. {authLabel(row)}.</p>
      {row.require2fa && (
        <>
          <p className="hint">2FA is on. Enter the password, then confirm the passkey.</p>
          <PasswordFields password={password} setPassword={setPassword} again={again} setAgain={setAgain} confirm={false} />
        </>
      )}
      {!row.require2fa && row.hasPasskey && <p className="hint">Confirm the passkey on this device.</p>}
      {!row.require2fa && !row.hasPasskey && row.hasPassword && (
        <>
          <p className="hint">This wallet was saved with a password. After it opens, enable a passkey from the wallet tab.</p>
          <PasswordFields password={password} setPassword={setPassword} again={again} setAgain={setAgain} confirm={false} />
        </>
      )}
      <button className="btn primary wide" disabled={busy || ((row.require2fa || !row.hasPasskey) && password.length < 8)} type="submit">
        {busy ? (row.hasPasskey ? "Waiting for passkey…" : "Unlocking…") : row.require2fa ? "Unlock with password + passkey" : row.hasPasskey ? "Unlock with passkey" : "Unlock with password"}
      </button>
      <button className="ghost wide" style={{ marginTop: 8 }} type="button" onClick={onBack}>
        Back to saved wallets
      </button>
    </form>
  );
}

function NameField({ name, setName }: { name: string; setName: (value: string) => void }) {
  return (
    <label className="field">
      <span>Wallet name</span>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. main" autoComplete="off" maxLength={40} />
    </label>
  );
}

function CreatedWallets({ phrase }: { phrase: string }) {
  const derived = useMemo(() => {
    try {
      return phrase.trim() ? deriveWallet(phrase) : null;
    } catch {
      return null;
    }
  }, [phrase]);
  if (!derived) return null;
  return (
    <div className="card born">
      <div className="kicker"><span>Wallets in this phrase</span></div>
      <div className="born-row">
        <b>Bitcoin</b>
        <span>{derived.btcAddress}</span>
      </div>
      <div className="born-row">
        <b>Hemi wallet</b>
        <span>{derived.hemiAddress}</span>
        <small>This address receives tunneled BTC as hemiBTC, plus ETH, HEMI, and VUSD on Hemi. The same key spends them.</small>
      </div>
    </div>
  );
}

function saveLabel(busy: boolean, passkey: boolean, twoFactor: boolean): string {
  if (busy) return passkey ? "Waiting for passkey…" : "Saving…";
  if (!passkey) return "Save with password";
  return twoFactor ? "Save with passkey + password" : "Save with passkey";
}

function assertPassword(needed: boolean, password: string, again: string) {
  if (!needed) return;
  if (password.length < 8) throw new Error("Password must be at least 8 characters.");
  if (password !== again) throw new Error("Passwords do not match.");
}

function PasswordFields({
  password,
  setPassword,
  again,
  setAgain,
  confirm,
}: {
  password: string;
  setPassword: (value: string) => void;
  again: string;
  setAgain: (value: string) => void;
  confirm: boolean;
}) {
  return (
    <>
      <label className="field">
        <span>Password</span>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={confirm ? "new-password" : "current-password"} />
      </label>
      {confirm && (
        <label className="field">
          <span>Confirm password</span>
          <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
        </label>
      )}
    </>
  );
}

function SaveAuth({
  passkey,
  native,
  passkeyNote,
  twoFactor,
  setTwoFactor,
  password,
  setPassword,
  again,
  setAgain,
}: {
  passkey: boolean;
  native: boolean;
  passkeyNote: string | null;
  twoFactor: boolean;
  setTwoFactor: (value: boolean) => void;
  password: string;
  setPassword: (value: string) => void;
  again: string;
  setAgain: (value: string) => void;
}) {
  if (!passkey) {
    return (
      <>
        <p className="hint">
          {passkeyNote ||
            "Passkey is not available here. A password can save the wallet on this device."}
        </p>
        <PasswordFields password={password} setPassword={setPassword} again={again} setAgain={setAgain} confirm />
      </>
    );
  }
  return (
    <>
      <p className="hint">
        {native
          ? "Passkey is this phone’s fingerprint, face, or PIN. The phrase stays encrypted on the phone. Turn on a password only if you want both factors at every login."
          : "Passkey is how you unlock. The browser asks once to create it. Turn on a password only if you want both factors at every login."}
      </p>
      <label className="check">
        <input type="checkbox" checked={twoFactor} onChange={(e) => setTwoFactor(e.target.checked)} />
        <span>Also require a password (2FA)</span>
      </label>
      {twoFactor && <PasswordFields password={password} setPassword={setPassword} again={again} setAgain={setAgain} confirm />}
    </>
  );
}
