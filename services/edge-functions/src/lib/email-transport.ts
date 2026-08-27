// US-915: email transport selection + sender-identity routing (PURE — env is
// injected, no supabase/network) so every branch unit-tests with zero setup.
//
// Two deliverability concerns live here:
//   1. TRANSPORT — choose the SES v2 HTTP API (preferred for marketing volume,
//      because it carries the Configuration Set for bounce/complaint event
//      publishing) vs raw SMTP, driven by env + whether the SES API is wired.
//   2. IDENTITY — marketing mail sends from a DEDICATED marketing identity
//      (news.gradethread.com) with its own From/Reply-To, kept separate from the
//      transactional identity so a marketing reputation hit can't harm
//      account-critical mail. A KNOWN-TRANSACTIONAL category can NEVER be routed
//      to the marketing identity, even if a caller mistakenly flags it marketing
//      (the hard guard `resolveIsMarketing` enforces this — see AC6).

export type TransportKind = "ses_api" | "smtp";

type EnvGetter = (k: string) => string | undefined;

const trimmed = (get: EnvGetter, k: string): string | undefined => {
  const v = get(k)?.trim();
  return v ? v : undefined;
};

export interface SendIdentity {
  fromEmail: string;
  fromName: string;
  replyTo?: string;
}

// ── Category routing (AC6) ──────────────────────────────────────────────────
//
// Every category used by a transactional `send*Email` in email.ts. These are
// account/service comms (receipts, grade-ready, security, admin alerts, eBay
// lifecycle) — they MUST stay on the transactional identity, never the marketing
// one. Marketing classes (broadcast, newsletter, drip, journeys, north-star
// digests) are NOT listed here; the coordinator flags those marketing explicitly.
export const TRANSACTIONAL_CATEGORIES: ReadonlySet<string> = new Set([
  "grade_ready",
  "grade_preliminary",
  "grade_review_request",
  "grade_finalized",
  "dispute_status",
  "welcome",
  "subscription_started",
  "subscription_renewal_receipt",
  // US-2119: the ADVANCE notice. Transactional for the same reason as the
  // receipt — a marketing opt-out must not suppress the only warning that a
  // card is about to be charged.
  "subscription_renewal_reminder",
  "subscription_canceled",
  "plan_downgraded",
  "subscription_paused",
  "subscription_resumed",
  "credit_pack_purchased",
  "payment_failed",
  // US-2128: the SCA/3DS challenge notice. It mirrors payment_failed (a required
  // billing warning that must reach the user regardless of marketing consent),
  // but the category string was added in email.ts and never registered here, so
  // it was not force-classified transactional. A subscriber who opted out of
  // marketing must still be told an authentication challenge is blocking their
  // renewal — otherwise the service silently degrades with no explanation.
  "payment_action_required",
  // A Grade Accuracy Guarantee claim outcome (fee refund to the original
  // payment method or as credits, + a free re-grade credit). Like any refund
  // receipt it is a required financial notice — a claimant who opted out of
  // marketing must still be told their claim was resolved and how they were made
  // whole. Sent transactionally today only because the caller passes no
  // marketing flag; registering it here makes that a guarantee, not an accident.
  "guarantee_remedy",
  "trial_expiring",
  "workspace_invite",
  "grading_regression_alert",
  "content_watchdog_alert",
  "ops_alert",
  "offer_received",
  "offer_responded",
  "return_opened",
  "dispute_opened",
  // US-2928/US-2929: the two post-sale escalations that had no reader at all.
  // Both are deadline-bearing and a lost case is a defect on the account, so a
  // marketing opt-out must not be able to suppress them.
  "inquiry_opened",
  "case_opened",
  // US-2933: the deadline reminder. Same class as the openings it follows up.
  "post_sale_deadline",
  // Registered here in the same pass because it belongs to the same class and
  // was simply missed: sendCancellationRequestedEmail has used this category
  // since US-2560 and it was never listed, so it was transactional only by
  // accident of no caller passing a marketing flag.
  "cancellation_requested",
  "ai_budget_alert",
  "content_digest",
  "dispute_filed_admin",
  "support_abuse_alert",
  "audit_anomaly_alert",
  "support_escalation",
  "referral_reward",
  "feedback",
  "account_deleted",
  "admin_message",
  // Auth emails via the GoTrue send-email hook — always transactional, never
  // the marketing identity (signup-confirm, reset, magic-link, email-change).
  "auth_signup",
  "auth_magiclink",
  "auth_recovery",
  "auth_invite",
  "auth_email_change",
  "auth_reauthentication",
]);

export function isTransactionalCategory(category?: string | null): boolean {
  return !!category && TRANSACTIONAL_CATEGORIES.has(category);
}

/**
 * The single arbiter of whether a send is marketing. A known-transactional
 * category is ALWAYS transactional regardless of the requested flag (hard guard,
 * AC6) — so transactional mail can never be moved onto the marketing identity.
 */
export function resolveIsMarketing(opts: { marketing?: boolean; category?: string | null }): boolean {
  if (isTransactionalCategory(opts.category)) return false;
  return !!opts.marketing;
}

// ── Sender identity ─────────────────────────────────────────────────────────

/** Transactional identity — the existing SMTP_* sender. */
export function transactionalIdentity(get: EnvGetter): SendIdentity {
  return {
    fromEmail: trimmed(get, "SMTP_ADMIN_EMAIL") ?? "",
    fromName: trimmed(get, "SMTP_SENDER_NAME") ?? "GradeThread",
    replyTo: trimmed(get, "SMTP_REPLY_TO"),
  };
}

/**
 * Marketing identity — a DEDICATED marketing From/Reply-To (e.g.
 * news@news.gradethread.com) separate from transactional. Falls back to the
 * transactional address when the marketing override is unset, so mail still
 * sends on an un-configured deploy (just without the reputation isolation).
 */
export function marketingIdentity(get: EnvGetter): SendIdentity {
  const tx = transactionalIdentity(get);
  return {
    fromEmail: trimmed(get, "SES_MARKETING_FROM_EMAIL") ?? tx.fromEmail,
    fromName: trimmed(get, "SES_MARKETING_FROM_NAME") ?? "GradeThread News",
    replyTo: trimmed(get, "SES_MARKETING_REPLY_TO") ?? tx.replyTo,
  };
}

export function resolveIdentity(isMarketing: boolean, get: EnvGetter): SendIdentity {
  return isMarketing ? marketingIdentity(get) : transactionalIdentity(get);
}

// ── Configuration Set (AC2) ─────────────────────────────────────────────────
//
// The SES Configuration Set whose event destination publishes bounce/complaint/
// delivery events (to the SNS endpoint wired in the SES console). Marketing sends
// prefer a marketing-specific set; both fall back to the shared set.
export function resolveConfigurationSet(
  isMarketing: boolean,
  get: EnvGetter,
): string | undefined {
  const shared = trimmed(get, "SES_CONFIGURATION_SET");
  if (isMarketing) return trimmed(get, "SES_MARKETING_CONFIGURATION_SET") ?? shared;
  return trimmed(get, "SES_TRANSACTIONAL_CONFIGURATION_SET") ?? shared;
}

// ── Transport selection (AC2) ───────────────────────────────────────────────

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** The SES v2 HTTP API is usable when AWS region + credentials are present. */
export function sesApiConfigured(get: EnvGetter): boolean {
  const region = trimmed(get, "SES_AWS_REGION") ?? trimmed(get, "AWS_REGION");
  const key = trimmed(get, "SES_AWS_ACCESS_KEY_ID") ?? trimmed(get, "AWS_ACCESS_KEY_ID");
  const secret = trimmed(get, "SES_AWS_SECRET_ACCESS_KEY") ?? trimmed(get, "AWS_SECRET_ACCESS_KEY");
  return !!(region && key && secret);
}

/**
 * Choose the transport. An explicit `EMAIL_TRANSPORT` env (`ses_api` | `smtp`)
 * forces the choice (when the forced transport is actually usable). Otherwise:
 * marketing volume prefers the SES API (for Configuration-Set event publishing)
 * when it's wired; everything else uses SMTP. Falls back to SMTP whenever the SES
 * API isn't configured, so a deploy without AWS creds simply keeps using SMTP.
 */
export function resolveTransportKind(isMarketing: boolean, get: EnvGetter): TransportKind {
  const sesReady = sesApiConfigured(get);
  const forced = (get("EMAIL_TRANSPORT") ?? "").trim().toLowerCase();
  if (forced === "smtp") return "smtp";
  if (forced === "ses_api") return sesReady ? "ses_api" : "smtp";
  // Default: SES API for marketing volume when wired; SMTP otherwise.
  return isMarketing && sesReady ? "ses_api" : "smtp";
}

/** Whether the warmup ramp opt-in flag is on (mirrors settings, env shortcut). */
export function warmupForced(get: EnvGetter): boolean {
  return TRUTHY.has((get("MARKETING_WARMUP_ENABLED") ?? "").trim().toLowerCase());
}

// ── List-Unsubscribe headers (AC4) ──────────────────────────────────────────

export interface MarketingHeaderInput {
  /** No-login one-click unsubscribe URL (https). */
  unsubscribeUrl?: string;
  /** mailto: unsubscribe address (e.g. unsubscribe@gradethread.com). */
  mailto?: string;
}

/**
 * RFC 2369 + RFC 8058 one-click unsubscribe headers. `List-Unsubscribe` lists the
 * https URL and/or a mailto; `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
 * is added ONLY when an https URL is present (one-click requires an HTTP target)
 * so Gmail/Apple Mail render the native unsubscribe affordance. Returns an empty
 * object when neither target is available (caller adds nothing).
 */
export function buildListUnsubscribeHeaders(input: MarketingHeaderInput): Record<string, string> {
  const targets: string[] = [];
  const url = input.unsubscribeUrl?.trim();
  const mailto = input.mailto?.trim();
  if (url && /^https?:\/\//i.test(url)) targets.push(`<${url}>`);
  if (mailto) targets.push(mailto.startsWith("mailto:") ? `<${mailto}>` : `<mailto:${mailto}>`);
  if (targets.length === 0) return {};
  const headers: Record<string, string> = { "List-Unsubscribe": targets.join(", ") };
  if (url && /^https?:\/\//i.test(url)) {
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  return headers;
}

/** The default mailto unsubscribe target (env override → support address). */
export function unsubscribeMailto(get: EnvGetter): string | undefined {
  return trimmed(get, "MARKETING_UNSUBSCRIBE_MAILTO");
}

// ── Deliverability pre-flight (AC5) ─────────────────────────────────────────
//
// Surface — at boot — whether the deliverability posture is configured: the
// dedicated marketing identity, the SES Configuration Set, the unsubscribe
// mailto, and the DNS-auth attestations (SPF/DKIM/DMARC verified out-of-band via
// `SES_DKIM_VERIFIED` / `SES_SPF_ALIGNED` / `SES_DMARC_POLICY` flags an operator
// sets once the DNS records are live — DNS itself can't be read from the edge).
export interface DeliverabilityWarning {
  key: string;
  message: string;
}

export function deliverabilityWarnings(get: EnvGetter): DeliverabilityWarning[] {
  const warnings: DeliverabilityWarning[] = [];
  if (!trimmed(get, "SES_CONFIGURATION_SET") && !trimmed(get, "SES_MARKETING_CONFIGURATION_SET")) {
    warnings.push({
      key: "configuration_set",
      message:
        "No SES Configuration Set (SES_CONFIGURATION_SET) — bounce/complaint events won't publish to SNS.",
    });
  }
  if (!trimmed(get, "SES_MARKETING_FROM_EMAIL")) {
    warnings.push({
      key: "marketing_identity",
      message:
        "No dedicated marketing identity (SES_MARKETING_FROM_EMAIL) — marketing mail shares the transactional From, so a reputation hit can harm account mail.",
    });
  }
  if (!isAttested(get, "SES_DKIM_VERIFIED")) {
    warnings.push({ key: "dkim", message: "DKIM not attested (set SES_DKIM_VERIFIED=true once DKIM CNAMEs are live)." });
  }
  if (!isAttested(get, "SES_SPF_ALIGNED")) {
    warnings.push({ key: "spf", message: "SPF not attested (set SES_SPF_ALIGNED=true once the SPF/MAIL FROM record is live)." });
  }
  if (!trimmed(get, "SES_DMARC_POLICY")) {
    warnings.push({ key: "dmarc", message: "No DMARC policy recorded (set SES_DMARC_POLICY to your published p= policy)." });
  }
  return warnings;
}

function isAttested(get: EnvGetter, key: string): boolean {
  return TRUTHY.has((get(key) ?? "").trim().toLowerCase());
}
