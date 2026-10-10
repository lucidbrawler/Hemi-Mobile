import { useState, type ReactNode } from "react";
import { useWallet } from "./state";
import { Activity } from "./ui/Activity";
import { Buddy } from "./ui/Buddy";
import { DoneFlash } from "./ui/DoneFlash";
import { Gate } from "./ui/Gate";
import { Home } from "./ui/Home";
import { Brand } from "./ui/mark";
import { Pop } from "./ui/Pop";
import { Tunnel } from "./ui/Tunnel";

type Tab = "wallet" | "pop" | "tunnel" | "activity";

export function App() {
  const w = useWallet();
  const [tab, setTab] = useState<Tab>("wallet");

  if (!w.ready) {
    return (
      <Stage bare>
        <p className="fine">Opening wallet…</p>
      </Stage>
    );
  }

  if (!w.wallet) {
    return (
      <Stage bare>
        <Gate />
      </Stage>
    );
  }

  const nav = (
    <nav className="nav">
      <button className={tab === "wallet" ? "on" : ""} type="button" onClick={() => setTab("wallet")}>Wallet</button>
      <button className={tab === "pop" ? "on" : ""} type="button" onClick={() => setTab("pop")}>PoP</button>
      <button className={tab === "tunnel" ? "on" : ""} type="button" onClick={() => setTab("tunnel")}>Tunnel</button>
      <button className={tab === "activity" ? "on" : ""} type="button" onClick={() => setTab("activity")}>Activity</button>
    </nav>
  );

  return (
    <Stage nav={nav}>
      <Brand subtitle="BTC, hemiBTC, ETH, HEMI, and VUSD" />
      {w.notice && (
        <div className="banner ok">
          <span>{w.notice}</span>
          <button type="button" onClick={w.clearFlash}>Close</button>
        </div>
      )}
      {w.error && (
        <div className="banner bad">
          <span>{w.error}</span>
          <button type="button" onClick={w.clearFlash}>Close</button>
        </div>
      )}
      {tab === "wallet" && <Home />}
      {tab === "pop" && <Pop />}
      {tab === "tunnel" && <Tunnel />}
      {tab === "activity" && <Activity />}
    </Stage>
  );
}

function Stage({
  children,
  bare,
  nav,
}: {
  children: ReactNode;
  bare?: boolean;
  nav?: ReactNode;
}) {
  return (
    <div className="stage">
      <main className="phone">
        <div className={bare ? "screen bare" : "screen"}>{children}</div>
        {nav}
        <DoneFlash />
        <Buddy />
      </main>
    </div>
  );
}
