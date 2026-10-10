import { useEffect, useRef, useState } from "react";
import idle0 from "../assets/buddy/idle-0.png";
import idle2 from "../assets/buddy/idle-2.png";
import idle3 from "../assets/buddy/idle-3.png";
import idle4 from "../assets/buddy/idle-4.png";
import idle5 from "../assets/buddy/idle-5.png";
import idle6 from "../assets/buddy/idle-6.png";
import idle7 from "../assets/buddy/idle-7.png";
import idle9 from "../assets/buddy/idle-9.png";
import fire0 from "../assets/buddy/fire-0.png";
import fire1 from "../assets/buddy/fire-1.png";
import fire2 from "../assets/buddy/fire-2.png";
import fire3 from "../assets/buddy/fire-3.png";

const IDLE = [idle0, idle7, idle0, idle0];
const WALK = [idle2, idle3, idle4, idle5, idle6, idle4, idle2, idle9, idle0];
const BLAST = [fire0, fire1, fire2, fire2, fire2, fire2];
const FIRE = [...BLAST, ...BLAST, ...BLAST, ...BLAST, fire3, fire3];
const FIRE_FRAME_MS = 280;
const FIRE_HOLD_MS = 900;
const SEND_MS = (FIRE.length - 1) * FIRE_FRAME_MS + FIRE_HOLD_MS;
const REDUCE_MS = 2500;
const TIPS = [
  "Sends stay off until you check mainnet.",
  "Bitcoin receive is the bc1 address.",
  "ETH, HEMI, VUSD, and hemiBTC share the 0x address.",
  "HEMI, VUSD, and hemiBTC need a little Hemi ETH for gas.",
];

export function Buddy() {
  const [frame, setFrame] = useState(idle0);
  const [line, setLine] = useState<string | null>(null);
  const tipTimer = useRef(0);
  const say = (text: string) => {
    setLine(text);
    window.clearTimeout(tipTimer.current);
    tipTimer.current = window.setTimeout(() => setLine(null), 4200);
  };

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let mode: "idle" | "walk" | "fire" = "idle";
    let step = 0;
    let cancelled = false;
    const pending: number[] = [];
    const later = (fn: () => void, ms: number) => {
      const id = window.setTimeout(() => {
        const at = pending.indexOf(id);
        if (at >= 0) pending.splice(at, 1);
        fn();
      }, ms);
      pending.push(id);
    };
    const clearFire = () => {
      for (const id of pending) window.clearTimeout(id);
      pending.length = 0;
    };
    const onSend = () => {
      clearFire();
      setLine("Sending.");
      window.clearTimeout(tipTimer.current);
      const lineMs = reduce ? REDUCE_MS : SEND_MS;
      tipTimer.current = window.setTimeout(() => setLine(null), lineMs);
      if (reduce) {
        setFrame(fire2);
        later(() => setFrame(idle0), REDUCE_MS);
        return;
      }
      mode = "fire";
      let n = 0;
      const play = () => {
        if (cancelled) return;
        setFrame(FIRE[n]);
        n += 1;
        if (n < FIRE.length) {
          later(play, FIRE_FRAME_MS);
        } else {
          later(() => {
            mode = "idle";
            step = 0;
            setFrame(idle0);
          }, FIRE_HOLD_MS);
        }
      };
      play();
    };

    const tick = () => {
      if (mode === "fire") return;
      if (reduce) return;
      if (mode === "walk") {
        step += 1;
        if (step >= WALK.length) {
          mode = "idle";
          step = 0;
          setFrame(IDLE[0]);
        } else {
          setFrame(WALK[step]);
        }
        return;
      }
      step += 1;
      setFrame(IDLE[step % IDLE.length]);
      if (step > 0 && step % 14 === 0) {
        mode = "walk";
        step = 0;
        setFrame(WALK[0]);
      }
    };

    const timer = window.setInterval(tick, 480);
    window.addEventListener("hemi-buddy", onSend);
    return () => {
      cancelled = true;
      clearFire();
      window.clearInterval(timer);
      window.clearTimeout(tipTimer.current);
      window.removeEventListener("hemi-buddy", onSend);
    };
  }, []);

  return (
    <div className="buddy">
      {line && <p className="say" aria-live="polite">{line}</p>}
      <button
        className="sprite"
        type="button"
        aria-label="Hemi"
        onClick={() => say(TIPS[Math.floor(Math.random() * TIPS.length)])}
      >
        <img src={frame} alt="" />
      </button>
    </div>
  );
}
