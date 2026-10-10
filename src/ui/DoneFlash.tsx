import { useEffect, useState } from "react";
import hemiIcon from "../assets/hemi.svg";

/** Spinning Hemi mark that settles after a send or swap lands. */
export function DoneFlash() {
  const [line, setLine] = useState<string | null>(null);
  const [spin, setSpin] = useState(true);

  useEffect(() => {
    let spinTimer = 0;
    let hideTimer = 0;
    const onDone = (event: Event) => {
      const text = (event as CustomEvent<string>).detail || "Done.";
      window.clearTimeout(spinTimer);
      window.clearTimeout(hideTimer);
      setLine(text);
      setSpin(true);
      spinTimer = window.setTimeout(() => setSpin(false), 1400);
      hideTimer = window.setTimeout(() => setLine(null), 2600);
    };
    window.addEventListener("hemi-done", onDone);
    return () => {
      window.clearTimeout(spinTimer);
      window.clearTimeout(hideTimer);
      window.removeEventListener("hemi-done", onDone);
    };
  }, []);

  if (!line) return null;
  return (
    <div className="done-flash" role="status">
      <img className={spin ? "coin spin" : "coin"} src={hemiIcon} alt="" />
      <b>{line}</b>
    </div>
  );
}
