import { useEffect, useState, type ReactNode } from "react";
import { useWallet } from "./state";
import { Activity } from "./ui/Activity";
import { Buddy } from "./ui/Buddy";
import { DoneFlash } from "./ui/DoneFlash";
import { Gate } from "./ui/Gate";
import { Home } from "./ui/Home";
import { Brand } from "./ui/mark";
import { Pop } from "./ui/Pop";
import { Tools } from "./ui/Tools";
import { Tunnel } from "./ui/Tunnel";

type Place = "wallet" | "activity" | "tools" | "pop" | "tunnel";

export function App() {
  const w = useWallet();
  const [place, setPlace] = useState<Place>("wallet");

  useEffect(() => {
    document.querySelector(".screen")?.scrollTo(0, 0);
  }, [place]);

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

  const toolsOn = place === "tools" || place === "pop" || place === "tunnel";
  const nav = (
    <nav className="nav">
      <button className={place === "wallet" ? "on" : ""} type="button" onClick={() => setPlace("wallet")}>Wallet</button>
      <button className={place === "activity" ? "on" : ""} type="button" onClick={() => setPlace("activity")}>Activity</button>
      <button className={toolsOn ? "on" : ""} type="button" onClick={() => setPlace("tools")}>Tools</button>
    </nav>
  );

  return (
    <Stage nav={nav}>
      <Brand />
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
      {place === "wallet" && <Home />}
      {place === "activity" && <Activity />}
      {place === "tools" && <Tools onOpen={setPlace} />}
      {(place === "pop" || place === "tunnel") && (
        <button className="back" type="button" onClick={() => setPlace("tools")}>Tools</button>
      )}
      {place === "pop" && <Pop />}
      {place === "tunnel" && <Tunnel />}
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
