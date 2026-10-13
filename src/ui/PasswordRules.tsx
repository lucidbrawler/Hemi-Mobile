import { passwordChecks } from "../lib/password";

export function PasswordRules({ password }: { password: string }) {
  return (
    <ul className="rules">
      {passwordChecks(password).map((row) => (
        <li key={row.label} className={row.met ? "met" : "miss"}>
          {row.label}
        </li>
      ))}
    </ul>
  );
}
