// US-914: SNS signature verification helpers. The string-to-sign builder and
// cert-URL validator are pure; pin their behavior here (no network needed). The
// full RSA verify is exercised live against AWS in prod — not unit-testable
// without a real signed message + cert.
//
// sns-verify.ts statically imports lib/observability.ts which can chain into
// lib/supabase.ts (throws "SUPABASE_URL is not set" at import) — set the env
// FIRST, then dynamic-import.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");

const { buildStringToSign, isValidSigningCertUrl, isSnsTimestampFresh, SNS_MAX_AGE_MS } =
  await import("../lib/sns-verify.ts");

Deno.test("buildStringToSign: Notification uses the documented field order", () => {
  const s = buildStringToSign({
    Type: "Notification",
    MessageId: "id-1",
    Message: "hello",
    Timestamp: "2026-06-20T00:00:00.000Z",
    TopicArn: "arn:aws:sns:us-east-1:1:feedback",
    Subject: "subj",
  });
  assertEquals(
    s,
    "Message\nhello\nMessageId\nid-1\nSubject\nsubj\nTimestamp\n2026-06-20T00:00:00.000Z\n" +
      "TopicArn\narn:aws:sns:us-east-1:1:feedback\nType\nNotification\n",
  );
});

Deno.test("buildStringToSign: Subject is omitted when absent", () => {
  const s = buildStringToSign({
    Type: "Notification",
    MessageId: "id-1",
    Message: "hello",
    Timestamp: "t",
    TopicArn: "arn",
  });
  assert(s && !s.includes("Subject"), "Subject must be omitted when not present");
});

Deno.test("buildStringToSign: SubscriptionConfirmation includes Token + SubscribeURL", () => {
  const s = buildStringToSign({
    Type: "SubscriptionConfirmation",
    MessageId: "id-2",
    Message: "confirm",
    Token: "tok",
    SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription",
    Timestamp: "t",
    TopicArn: "arn",
  });
  assert(s);
  assert(s.includes("SubscribeURL\n"), "must include SubscribeURL");
  assert(s.includes("Token\ntok\n"), "must include Token");
});

Deno.test("buildStringToSign: unknown type or missing required field → null", () => {
  assertEquals(buildStringToSign({ Type: "Nope" }), null);
  // Missing the required Message field.
  assertEquals(
    buildStringToSign({ Type: "Notification", MessageId: "x", Timestamp: "t", TopicArn: "a" }),
    null,
  );
});

Deno.test("isValidSigningCertUrl: only https AWS SNS hosts pass", () => {
  assert(isValidSigningCertUrl("https://sns.us-east-1.amazonaws.com/cert.pem"));
  assert(isValidSigningCertUrl("https://sns.eu-west-1.amazonaws.com.cn/cert.pem"));
  // http, wrong host, or an attacker-controlled lookalike must all be rejected.
  assert(!isValidSigningCertUrl("http://sns.us-east-1.amazonaws.com/cert.pem"));
  assert(!isValidSigningCertUrl("https://evil.com/cert.pem"));
  assert(!isValidSigningCertUrl("https://sns.us-east-1.amazonaws.com.evil.com/cert.pem"));
  assert(!isValidSigningCertUrl("not a url"));
});

// US-1641: Timestamp freshness (replay guard).
Deno.test("isSnsTimestampFresh: accepts a recent message, rejects a stale one", () => {
  const now = Date.parse("2026-06-20T12:00:00.000Z");
  // 5 minutes old → fresh.
  assert(
    isSnsTimestampFresh({ Timestamp: "2026-06-20T11:55:00.000Z" }, now),
  );
  // Just under the 1h window → fresh.
  assert(
    isSnsTimestampFresh({ Timestamp: new Date(now - SNS_MAX_AGE_MS + 1000).toISOString() }, now),
  );
  // Over 1h old → stale (replayed).
  assert(
    !isSnsTimestampFresh({ Timestamp: new Date(now - SNS_MAX_AGE_MS - 1000).toISOString() }, now),
  );
});

Deno.test("isSnsTimestampFresh: rejects a far-future or unparseable/missing timestamp", () => {
  const now = Date.parse("2026-06-20T12:00:00.000Z");
  // Far-future (beyond skew allowance) → rejected.
  assert(
    !isSnsTimestampFresh({ Timestamp: new Date(now + SNS_MAX_AGE_MS + 1000).toISOString() }, now),
  );
  assert(!isSnsTimestampFresh({ Timestamp: "not-a-date" }, now));
  assert(!isSnsTimestampFresh({}, now));
});
