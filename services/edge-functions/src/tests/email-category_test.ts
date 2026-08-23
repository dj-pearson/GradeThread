// US-801: every TRANSACTIONAL send must pass a `category` so a failed delivery
// is persisted to the email_deliveries outbox and retried (sendEmail only
// enqueues when options.category is set). This guards against a new send
// function silently shipping without durable retry. Marketing/bulk sends are
// intentionally exempt: they have their own campaign-level delivery tracking
// and should not flood the transactional outbox. Those are sendDripStepEmail
// and the per-recipient campaign broadcast in routes/admin-growth.ts, which
// categorizes as broadcast:<campaignId> against its own reservation.
//
// sendGradeCompleteEmail came OFF the list below on 2026-08-23. It was one of
// only two exported senders in email.ts with no production caller, and the
// verdict was SUPERSEDED, not missing: GradeCompleteData is a strict subset of
// GradeFinalizedData, and the seller is emailed twice by the live pipeline
// already, sendGradePreliminaryEmail when the AI grade lands and
// sendGradeFinalizedEmail after review. The preliminary path even reads the
// notification_preferences.grade_complete pref, which is the clearest sign of
// which function inherited the job.
import { assert } from "@std/assert";

const EMAIL_SRC = new URL("../lib/email.ts", import.meta.url);

// Exported transactional senders that MUST be categorized.
const TRANSACTIONAL_SENDERS = [
  "sendGradePreliminaryEmail",
  "sendGradeReviewRequestEmail",
  "sendGradeFinalizedEmail",
  "sendDisputeResolvedEmail",
  "sendWelcomeEmail",
  "sendSubscriptionStartedEmail",
  "sendSubscriptionCanceledEmail",
  "sendSubscriptionPausedEmail",
  "sendSubscriptionResumedEmail",
  "sendCreditPackPurchasedEmail",
  "sendPaymentFailedEmail",
  "sendTrialExpiringEmail",
  "sendWorkspaceInvitationEmail",
  "sendGradingRegressionAlertEmail",
  "sendContentWatchdogAlertEmail",
  "sendDisputeFiledAdminEmail",
  "sendAccountDeletedEmail",
  "sendFeedbackEmail",
  "sendReferralRewardEmail",
];

// Returns the source slice of a function: from its declaration to the next
// top-level `export ` (or EOF).
function functionBlock(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  assert(start !== -1, `expected an exported function ${name} in email.ts`);
  const after = src.indexOf("\nexport ", start + 1);
  return src.slice(start, after === -1 ? undefined : after);
}

Deno.test("every transactional email sender sets a category (US-801 durable retry)", async () => {
  const src = await Deno.readTextFile(EMAIL_SRC);
  for (const name of TRANSACTIONAL_SENDERS) {
    const body = functionBlock(src, name);
    assert(
      /category:\s*["']/.test(body),
      `${name} calls sendEmail without a category — a transient SMTP failure ` +
        `would be silently lost instead of retried from the outbox.`,
    );
  }
});

Deno.test("the CAN-SPAM footer never embeds the dev placeholder token", async () => {
  const src = await Deno.readTextFile(EMAIL_SRC);
  // The bracketed "[SET …]" placeholder must not be a renderable fallback.
  assert(
    !src.includes("[SET COMPANY_POSTAL_ADDRESS]"),
    "postalAddress() still embeds the [SET COMPANY_POSTAL_ADDRESS] placeholder, " +
      "which would render to real recipients when the env var is unset.",
  );
});
