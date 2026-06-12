// US-444: lightweight client-side validators for inline, ARIA-associated field
// errors. The server (and Supabase/GoTrue) remains authoritative — these only
// provide immediate, accessible feedback so users can fix problems at the field
// instead of relying on transient toasts.

// Pragmatic email shape check (not RFC-5322 exhaustive): a single @, no spaces,
// and a dotted domain. Good enough to catch typos before a round-trip.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(email: string): string | undefined {
  const trimmed = email.trim();
  if (!trimmed) return "Email is required";
  if (!EMAIL_RE.test(trimmed)) return "Enter a valid email address";
  return undefined;
}

export function validateRequired(
  value: string,
  label: string,
): string | undefined {
  return value.trim() ? undefined : `${label} is required`;
}
