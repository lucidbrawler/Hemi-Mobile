import { useEffect, useRef, useState } from "react";
import { HEMI_CHAIN_HEX, DappError, prepareDappUrl } from "../lib/dapp";
import {
  closeDappBrowser,
  dappBrowserAvailable,
  emitDapp,
  listenDapp,
  openDappBrowser,
  respondDapp,
  setDappBrowserVisible,
  type DappPageRequest,
} from "../lib/dappBrowser";
import { answerDappRequest, type DappPrompt } from "../lib/dappRequest";
import { messageOf } from "../lib/errors";
import { requirePublic } from "../lib/sessionVault";

const connected = new Set<string>();

/** Keeps the site browser's requests alive for the whole unlocked session. */
export function DappHost() {
  const [prompt, setPrompt] = useState<DappPrompt | null>(null);
  const [sure, setSure] = useState(false);
  const pending = useRef<((ok: boolean) => void) | null>(null);

  function ask(next: DappPrompt): Promise<boolean> {
    setSure(false);
    setPrompt(next);
    return new Promise((resolve) => {
      pending.current = resolve;
    });
  }

  function finish(ok: boolean) {
    const resolve = pending.current;
    pending.current = null;
    setPrompt(null);
    setSure(false);
    resolve?.(ok);
  }

  useEffect(() => {
    if (!dappBrowserAvailable()) return;
    let alive = true;
    let remove = () => {};
    let chain: Promise<void> = Promise.resolve();

    async function handle(request: DappPageRequest) {
      const connectMethod = request.method === "eth_requestAccounts" || request.method === "wallet_requestPermissions";
      const signMethod = request.method === "personal_sign"
        || request.method === "eth_signTypedData_v3"
        || request.method === "eth_signTypedData_v4"
        || request.method === "eth_sendTransaction";
      const hide = connectMethod ? !connected.has(request.origin) : signMethod && connected.has(request.origin);
      if (hide) await setDappBrowserVisible(false);
      try {
        const answer = await answerDappRequest(request.method, request.params, request.origin, connected, ask);
        if (!alive) {
          const rejected = Boolean(answer.connect || answer.disconnect);
          await respondDapp(request.id, !rejected, rejected ? { code: 4001, message: "You rejected the request." } : answer.result);
          return;
        }
        if (answer.connect) connected.add(request.origin);
        if (answer.disconnect) connected.delete(request.origin);
        await respondDapp(request.id, true, answer.result);
        if (answer.connect) {
          await emitDapp("accountsChanged", [requirePublic().hemiAddress]);
          await emitDapp("chainChanged", HEMI_CHAIN_HEX);
        }
        if (answer.disconnect) await emitDapp("accountsChanged", []);
      } catch (err) {
        const code = err instanceof DappError ? err.code : -32603;
        try {
          await respondDapp(request.id, false, { code, message: messageOf(err) });
        } catch {
          // The page is already gone.
        }
      } finally {
        if (hide && alive) await setDappBrowserVisible(true);
      }
    }

    const stop = listenDapp(
      (request) => {
        chain = chain.then(() => alive ? handle(request) : undefined).catch(() => undefined);
      },
      () => {
        connected.clear();
      },
    );
    void stop.then((next) => {
      if (!alive) next();
      else remove = next;
    });
    return () => {
      alive = false;
      remove();
      const resolve = pending.current;
      pending.current = null;
      resolve?.(false);
      connected.clear();
      void closeDappBrowser();
    };
  }, []);

  return prompt ? (
    <div className="sheet-back dapp-back">
      <div className="sheet" role="dialog" aria-label={prompt.title}>
        <h2>{prompt.title}</h2>
        <p className="hint">{prompt.origin}</p>
        <p className="fine">{prompt.body}</p>
        {prompt.lines.map((line) => (
          <div className="rowline" key={line.label}>
            <span>{line.label}</span>
            <b>{line.value}</b>
          </div>
        ))}
        {prompt.sure && (
          <label className="check">
            <input type="checkbox" checked={sure} onChange={(event) => setSure(event.target.checked)} />
            <span>I approve this on Hemi mainnet.</span>
          </label>
        )}
        <div className="actions">
          <button className="ghost" type="button" onClick={() => void finish(false)}>Reject</button>
          <button
            className="btn primary"
            type="button"
            disabled={prompt.sure && !sure}
            onClick={() => void finish(true)}
          >
            {prompt.confirm}
          </button>
        </div>
      </div>
    </div>
  ) : null;
}

export function BrowserPage() {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const native = dappBrowserAvailable();

  async function open() {
    setError(null);
    try {
      const next = prepareDappUrl(url);
      setUrl(next);
      if (!native) throw new Error("The site browser is in the Android app.");
      await openDappBrowser(next);
    } catch (err) {
      setError(messageOf(err));
    }
  }

  return (
    <section className="card tools-card">
      <div className="kicker"><span>Browser</span></div>
      <p className="hint">
        Open a site here. It can ask to connect this Hemi address, the way a wallet extension does.
        A connection, a signature, and a transaction each wait for your approval. This wallet stays on Hemi.
      </p>
      {!native && <p className="fine">The site browser is in the Android app. A normal browser page cannot see this wallet.</p>}
      <label className="field">
        <span>Site</span>
        <input
          value={url}
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="https://"
          aria-label="Site"
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void open();
          }}
        />
      </label>
      {error && <p className="banner bad">{error}</p>}
      <button className="btn primary wide" type="button" onClick={() => void open()}>Open</button>
    </section>
  );
}
