/** Same bar as the Warthog wallet: 4 of these 5 checks is "Good". */

export const NATIVE_PASSWORD_ERROR =
  "Password is too weak. Use at least 8 characters, with uppercase, lowercase, and a number.";

export type PasswordCheck = { label: string; met: boolean };

export function passwordChecks(password: string): PasswordCheck[] {
  return [
    { label: "At least 8 characters", met: password.length >= 8 },
    { label: "One lowercase letter", met: /[a-z]/.test(password) },
    { label: "One uppercase letter", met: /[A-Z]/.test(password) },
    { label: "One number", met: /\d/.test(password) },
    { label: "One special character", met: /[^a-zA-Z\d]/.test(password) },
  ];
}

export function passwordScore(password: string): number {
  return passwordChecks(password).reduce((score, row) => score + (row.met ? 1 : 0), 0);
}

/** True when the password would be accepted on the phone. */
export function passwordMeetsBar(password: string): boolean {
  return passwordScore(password) >= 4;
}

export function assertNativePassword(password: string): void {
  if (!passwordMeetsBar(password)) throw new Error(NATIVE_PASSWORD_ERROR);
}
