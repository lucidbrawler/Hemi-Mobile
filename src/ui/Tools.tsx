import { useTheme, type ThemeName } from "./theme";

export function Tools({ onOpen }: { onOpen: (page: "tunnel" | "pop") => void }) {
  const { theme, choose } = useTheme();

  return (
    <div>
      <section className="card tools-card">
        <div className="kicker"><span>Appearance</span></div>
        <div className="choice" role="group" aria-label="Appearance">
          <ThemeChoice name="dark" theme={theme} choose={choose} label="Dark" />
          <ThemeChoice name="light" theme={theme} choose={choose} label="Light" />
        </div>
      </section>

      <section className="card tools-card">
        <div className="kicker"><span>More</span></div>
        <button className="menu-row" type="button" onClick={() => onOpen("tunnel")}>
          <span>
            <b>Tunnel</b>
            <small>Move BTC and ETH onto Hemi, and back.</small>
          </span>
          <i aria-hidden="true">›</i>
        </button>
        <button className="menu-row" type="button" onClick={() => onOpen("pop")}>
          <span>
            <b>PoP</b>
            <small>Watch proofs of proof. This does not spend bitcoin.</small>
          </span>
          <i aria-hidden="true">›</i>
        </button>
      </section>
    </div>
  );
}

function ThemeChoice({
  name,
  theme,
  choose,
  label,
}: {
  name: ThemeName;
  theme: ThemeName;
  choose: (next: ThemeName) => void;
  label: string;
}) {
  const on = theme === name;
  return (
    <button type="button" className={on ? "on" : ""} aria-pressed={on} onClick={() => choose(name)}>
      {label}
    </button>
  );
}
