// Webhook dead-letter capture (US-772).
//
// When a webhook handler throws a NON-TRANSIENT error (a code bug a Stripe retry
// can't fix), webhooks.ts keeps the idempotency claim and returns 200 so Stripe
// doesn't storm a permanently-failing event. The cost is that the event is now
// permanently dropped — a paid checkout could vanish with only a console line as
// evidence. recordWebhookDeadLetter makes that drop DURABLE and ALERTED:
//
//   1. ALWAYS captures the drop to the error tracker (Sentry via captureException)
//      — this fires regardless of whether the DB write below succeeds, so the
//      floor is never "console.error only".
//   1b. ALSO emits a CRITICAL ops event (US-2011). Sentry alone was not enough:
//      it is one channel, and its alert routing is separately unverified, so a
//      dropped PAID CHECKOUT could land somewhere nobody watches. emitOpsEvent
//      is the path that fans out to the on-call webhook, so the drop now reaches
//      the same place every other critical operational event does.
//   2. Writes a redacted row to webhook_dead_letters so an operator can see +
//      manually replay it from the admin queue.
//
// It NEVER throws: the caller is already on the 200-return path and must not be
// turned into a 500 by a logging failure. A failed write falls back to (1) + a
// console line.
//
// `insert` is injectable so the logic is unit-testable without a DB (mirrors the
// webhook-idempotency / rate-limit injectable-deps pattern).

import { supabaseAdmin } from "./supabase.ts";
import { captureException } from "./observability.ts";
import { emitOpsEvent } from "./ops-events.ts";
import { redact } from "./log-redact.ts";

export interface DeadLetterInput {
  // US-1650: 'googleplay' added for the Google Play RTDN webhook. 'content' is a
  // valid DB value too (00206) but isn't dead-lettered through this path.
  provider: "stripe" | "ebay" | "appstore" | "googleplay";
  eventId: string;
  eventType: string | null;
  /** The event payload (e.g. Stripe event.data.object). Redacted before storage. */
  payload: unknown;
  errorMessage: string;
}

export interface DeadLetterRow {
  provider: string;
  event_id: string;
  event_type: string | null;
  payload: unknown;
  error_message: string;
}

export type DeadLetterInserter = (
  row: DeadLetterRow,
) => Promise<{ error: { code?: string; message?: string } | null }>;

const defaultInsert: DeadLetterInserter = async (row) => {
  // ignoreDuplicates: the (provider, event_id) unique index means a re-drop of an
  // already-recorded event is a no-op, not an error.
  const { error } = await supabaseAdmin
    .from("webhook_dead_letters")
    .upsert(row, { onConflict: "provider,event_id", ignoreDuplicates: true });
  return { error };
};

// Redact PII/secrets from the payload while keeping it a JSON object where
// possible (so the admin UI can render fields). redact() replaces values with
// bracketed placeholders that stay valid inside a JSON string, so re-parsing the
// scrubbed string normally round-trips; on any failure we fall back to a wrapped
// scrubbed string rather than dropping the payload.
function redactPayload(payload: unknown): unknown {
  try {
    return JSON.parse(redact(JSON.stringify(payload ?? null)));
  } catch {
    return { redacted: redact(payload) };
  }
}

// Returns true when the durable row was written (or already existed), false when
// only the error-tracker capture + console fallback ran. Never throws.
export async function recordWebhookDeadLetter(
  input: DeadLetterInput,
  insert: DeadLetterInserter = defaultInsert,
): Promise<boolean> {
  // (1) The alert floor — always fires, even if the DB is unreachable. This is
  // the Sentry/observability event the story requires on every drop.
  captureException(
    new Error(
      `webhook DROPPED (non-transient): ${input.provider} ${input.eventType ?? "?"} ` +
        `(${input.eventId}): ${input.errorMessage}`,
    ),
    {
      level: "error",
      route: "webhook.dead_letter",
      tags: { provider: input.provider, event_type: input.eventType ?? "unknown" },
      extra: { event_id: input.eventId },
    },
  );

  // (1b) The operational alert channel. Deliberately fire-and-forget: this
  // function is on the caller's 200-return path and must never throw or block,
  // and emitOpsEvent already swallows its own failures. Awaiting it would make a
  // slow alert sink delay a webhook ack, which is how you get Stripe retries.
  void emitOpsEvent("webhook.dead_letter", "critical", {
    title:
      `Webhook DROPPED (non-transient): ${input.provider} ` +
      `${input.eventType ?? "unknown"} — manual replay required`,
    source: "webhook",
    data: {
      provider: input.provider,
      event_id: input.eventId,
      event_type: input.eventType ?? "unknown",
      // Truncated: the ops feed is a signal surface, not a log store. The full
      // (redacted) payload lives in webhook_dead_letters for the replay path.
      error: input.errorMessage.slice(0, 300),
    },
  });

  // (2) The durable capture — best-effort, never throws.
  try {
    const { error } = await insert({
      provider: input.provider,
      event_id: input.eventId,
      event_type: input.eventType,
      payload: redactPayload(input.payload),
      error_message: input.errorMessage.slice(0, 2000),
    });
    if (error && error.code !== "23505") {
      console.error(
        `[dead-letter] write failed for ${input.provider}:${input.eventId} — ${error.message ?? ""}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      `[dead-letter] write threw for ${input.provider}:${input.eventId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}
