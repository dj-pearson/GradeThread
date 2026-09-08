// Google Ads conversion reporting.
//
// WHY THIS IS ITS OWN FILE AND NOT A track() CALL. `track()` in analytics.ts
// reports to PostHog and nothing else, and the gtag bootstrap in index.html
// configures GA4 (`G-…`) only. Google Ads conversions are a third destination
// (`AW-…`): PostHog cannot feed them, and a GA4 property that emits no signup
// event has nothing to import. Before this file, a paid campaign could spend and
// had no way to record that it bought anything — which is exactly what happened.
//
// CONSENT. Deliberately NOT gated on the local `marketing` consent flag. The
// gtag bootstrap sets Consent Mode v2 to ad_storage:"denied" by default and the
// banner flips it, so gtag itself decides what may be stored; when consent is
// denied it sends a cookieless ping that Google uses for conversion modelling.
// Gating the call here as well would suppress that ping and lose the modelled
// conversion on top of the unmodelled one. Consent Mode is the gate.
//
// EXPECT UNDERCOUNTING ANYWAY. Modelling needs volume to work, and a small
// campaign will not supply it. Treat the reported number as a floor.

/**
 * Report a completed signup to Google Ads.
 *
 * Inert unless BOTH `VITE_GOOGLE_ADS_ID` (the `AW-…` account) and
 * `VITE_GOOGLE_ADS_SIGNUP_LABEL` (the per-conversion-action label) are set, so
 * this ships safely before the conversion action exists in the Ads account. The
 * env is read per call, never captured at module load, so the values can be
 * supplied at build time without import-order surprises.
 */
// The `AW-…` account has to be registered with gtag before any `send_to` naming
// it will be delivered; index.html configures the GA4 property only. Once per
// page is enough, and repeating it on every signup would add a remarketing hit
// nobody asked for.
let didConfigure = false;

// auth-confirm.tsx serves every Supabase email confirmation. Only some of them
// are a new account arriving: `recovery` is a password reset, `email_change` and
// `magiclink` are people who already have one, and `invite` is a new account
// that nobody paid an ad click for. Counting any of those as a signup inflates
// the conversion number with existing customers, and a campaign judged on an
// inflated number is worse than one judged on no number — it reads as working.
//
// `signup` is Supabase's explicit new-account type. `email` is its generic
// confirmation, and a null type falls through to the same place in
// `toEmailOtpType`, so both are treated as a signup: the cost of missing a real
// conversion at this volume is higher than the cost of the ambiguity.
const NEW_ACCOUNT_TYPES = new Set(["signup", "email"]);

export function reportSignupConversion(type: string | null): void {
  if (type !== null && !NEW_ACCOUNT_TYPES.has(type)) return;

  const account = import.meta.env.VITE_GOOGLE_ADS_ID;
  const label = import.meta.env.VITE_GOOGLE_ADS_SIGNUP_LABEL;
  if (!account || !label) return;

  try {
    if (!didConfigure) {
      window.gtag?.("config", account);
      didConfigure = true;
    }
    window.gtag?.("event", "conversion", { send_to: `${account}/${label}` });
  } catch {
    /* analytics must never break the UI */
  }
}
