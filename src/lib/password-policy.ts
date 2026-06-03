// Client-side password policy (US-367). The SERVER (GoTrue) is authoritative —
// these checks only give immediate feedback and must mirror the config in
// supabase/config.toml (minimum_password_length = 10,
// password_requirements = "lower_upper_letters_digits"). Keep them in sync.

export const PASSWORD_MIN_LENGTH = 10;

export const PASSWORD_HINT =
  "At least 10 characters, including upper- and lower-case letters and a number.";

export interface PasswordCheck {
  ok: boolean;
  reason: string | null;
}

export function checkPassword(password: string): PasswordCheck {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, reason: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` };
  }
  if (!/[a-z]/.test(password)) {
    return { ok: false, reason: "Password must include a lower-case letter." };
  }
  if (!/[A-Z]/.test(password)) {
    return { ok: false, reason: "Password must include an upper-case letter." };
  }
  if (!/[0-9]/.test(password)) {
    return { ok: false, reason: "Password must include a number." };
  }
  return { ok: true, reason: null };
}

export function isStrongPassword(password: string): boolean {
  return checkPassword(password).ok;
}

// Coarse 0–4 strength score for a meter (length + character-class variety).
export function passwordStrength(password: string): number {
  if (!password) return 0;
  let score = 0;
  if (password.length >= PASSWORD_MIN_LENGTH) score++;
  if (password.length >= 14) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password)) score++;
  else if (/[0-9]/.test(password)) score += 0;
  return Math.min(score, 4);
}
