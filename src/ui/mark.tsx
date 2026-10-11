import hemiLogo from "../assets/hemi.svg";

export function Brand() {
  return (
    <header className="brand">
      <img className="brand-logo" src={hemiLogo} alt="" />
      <div className="word">HEMI</div>
    </header>
  );
}
