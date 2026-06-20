import { Hono } from "hono";
import { applySesFeedback } from "../lib/email-suppression.ts";
import { type SnsMessage, verifySnsSignature } from "../lib/sns-verify.ts";
import { captureException, recordMetric } from "../lib/observability.ts";

// US-914: SES bounce/complaint feedback via SNS — the canonical, signature-
// verified ingestion endpoint.
//
// Mounted PUBLIC at /api/email (no JWT). SES publishes bounce/complaint
// notifications to an SNS topic that POSTs here. Because the endpoint is
// unauthenticated and acts on arbitrary recipient addresses, every message is
// SNS-signature-verified (sns-verify.ts) before we trust it — a forged
// suppression would be a deliverability DoS.
//
// Flow:
//   • SubscriptionConfirmation → auto-confirm by fetching SubscribeURL.
//   • Notification → classify (hard bounce / complaint) and suppress; transient
//     bounces never suppress. A complaint also flips marketing consent off and
//     re-checks the rolling complaint rate (alert / auto-pause) — all inside
//     applySesFeedback.
//
// Always returns 2xx for accepted-but-ignored payloads so SNS doesn't storm
// retries; a forged/invalid signature returns 403.
export const emailSnsRoutes = new Hono();

emailSnsRoutes.post("/ses-notifications", async (c) => {
  let envelope: SnsMessage;
  try {
    envelope = (await c.req.json()) as SnsMessage;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Optional topic pin: reject envelopes from an unexpected topic outright.
  const expectedArn = Deno.env.get("SES_SNS_TOPIC_ARN")?.trim();
  if (expectedArn && envelope.TopicArn !== expectedArn) {
    console.warn(`[SES] SNS message from unexpected TopicArn=${String(envelope.TopicArn ?? "?")}`);
    return c.json({ received: true, ignored: true });
  }

  // Signature verification (fail closed). An operator can disable it for a
  // controlled environment with no outbound cert fetch (SES_SNS_SKIP_VERIFICATION).
  const skipVerify = Deno.env.get("SES_SNS_SKIP_VERIFICATION")?.trim() === "true";
  if (!skipVerify) {
    const valid = await verifySnsSignature(envelope);
    if (!valid) {
      recordMetric("email.sns_signature_rejected", 1);
      console.warn(`[SES] Rejected SNS message with invalid signature (type=${String(envelope.Type ?? "?")})`);
      return c.json({ error: "Invalid SNS signature" }, 403);
    }
  }

  const snsType = c.req.header("x-amz-sns-message-type") ?? envelope.Type;

  // SNS subscription handshake: confirm by fetching the one-time SubscribeURL.
  if (snsType === "SubscriptionConfirmation") {
    const subscribeUrl = typeof envelope.SubscribeURL === "string" ? envelope.SubscribeURL : undefined;
    if (subscribeUrl) {
      try {
        const res = await fetch(subscribeUrl);
        await res.body?.cancel();
      } catch (err) {
        captureException(err, { route: "email-sns.confirm" });
      }
    }
    return c.json({ received: true, confirmed: !!subscribeUrl });
  }

  if (snsType === "UnsubscribeConfirmation") {
    return c.json({ received: true });
  }

  // Notification: the SES payload lives in the JSON-string `Message` field. Some
  // setups deliver the SES notification at the top level — fall back to that.
  let message: unknown = envelope.Message;
  if (typeof message === "string") {
    try {
      message = JSON.parse(message);
    } catch {
      message = undefined;
    }
  }

  let suppressed: string[] = [];
  try {
    suppressed = await applySesFeedback(message ?? envelope, "ses");
  } catch (err) {
    captureException(err, { route: "email-sns.feedback" });
  }
  if (suppressed.length > 0) {
    recordMetric("email.sns_suppressed", suppressed.length);
    console.log(`[SES] SNS feedback suppressed ${suppressed.length} recipient(s)`);
  }
  return c.json({ received: true, suppressed: suppressed.length });
});
