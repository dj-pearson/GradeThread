// US-380: duplicate-account / identity-linking guidance.
//
// POLICY (mirrored on the self-hosted prod GoTrue — see supabase/config.toml):
// automatic identity linking on a CONFIRMED-email match is left ON (the GoTrue
// default) so that signing in with Google for an email that already has an
// email/password account LINKS to that existing account instead of creating a
// duplicate/orphaned one. The manual linking endpoint stays disabled
// (GOTRUE_SECURITY_MANUAL_LINKING_ENABLED=false).
//
// Because enumeration protection (US-369) forbids confirming whether a given
// email exists, we cannot tell a user *which* method they originally used.
// Instead we surface enumeration-safe guidance: whenever a credential sign-in
// fails, or an OAuth callback returns a linking/duplicate-identity error, we
// point users at "your original sign-in method" (including Continue with
// Google) WITHOUT revealing whether the account exists.

// Appended to the generic sign-in failure message. Shown for ALL credential
// failures, so it never reveals whether a specific account exists.
export const USE_ORIGINAL_METHOD_HINT =
  "If you originally signed up a different way — like Continue with Google — use that method instead.";

// Sign-in failure message: US-369 generic wording + US-380 method-mismatch hint.
export const SIGN_IN_FAILED_MESSAGE =
  "We couldn't sign you in. Check your email and password, and confirm your email if you just signed up. " +
  USE_ORIGINAL_METHOD_HINT;

// The message shown on the OAuth callback when a linking/duplicate-identity
// error is detected — guides the user back to their original method. This path
// is enumeration-safe because the user themselves initiated the OAuth sign-in
// with their own provider account.
export const OAUTH_LINKING_MESSAGE =
  "An account already exists for this email with a different sign-in method. " +
  "Please sign in using your original sign-in method instead.";

// OAuth callback errors that mean "this email already belongs to an account
// created with a different method and GoTrue couldn't auto-link it". GoTrue
// surfaces these as error codes and/or human-readable descriptions; match
// defensively on substrings of either.
const LINKING_ERROR_PATTERNS = [
  "identity_already_exists",
  "email_exists",
  "user_already_exists",
  "manual linking",
  "already registered",
  "already been registered",
  "multiple accounts",
  "different account",
  "different sign-in",
  "different sign in",
];

export function isIdentityLinkingError(
  error: string | null | undefined,
  description: string | null | undefined,
): boolean {
  const haystack = `${error ?? ""} ${description ?? ""}`.toLowerCase();
  return LINKING_ERROR_PATTERNS.some((p) => haystack.includes(p));
}
