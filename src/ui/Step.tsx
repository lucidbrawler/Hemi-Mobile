import hemiIcon from "../assets/hemi.svg";

export function StepStatus({
  spinning,
  step,
  message,
  eta,
}: {
  spinning: boolean;
  step: string;
  message: string;
  eta: string;
}) {
  return (
    <div className="step-row">
      <img className={spinning ? "coin spin" : "coin"} src={hemiIcon} alt="" />
      <div>
        <b>{step}</b>
        <div className="fine">{message}</div>
        <div className="eta">{eta}</div>
      </div>
    </div>
  );
}
