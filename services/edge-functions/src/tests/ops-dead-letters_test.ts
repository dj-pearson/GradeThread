// US-882: unified dead-letter console — pure-helper tests.

import { assert, assertEquals } from "@std/assert";
import {
  buildUnifiedPage,
  bulkAudit,
  DLQ_DISCARD_AUDIT_ACTION,
  DLQ_RETRY_AUDIT_ACTION,
  discardAudit,
  type EmailDeadLetterRow,
  isDeadLetterSource,
  isWebhookReplayable,
  normalizeDiscardReason,
  parseDeadLetterQuery,
  payloadPreview,
  retryAudit,
  toUnifiedFromEmail,
  toUnifiedFromWebhook,
  type UnifiedDeadLetter,
  type WebhookDeadLetterRow,
} from "../lib/ops-dead-letters.ts";

const NOW = new Date("2026-06-14T12:00:00Z");

function wh(id: string, provider: string, createdAt: string, extra: Partial<WebhookDeadLetterRow> = {}): WebhookDeadLetterRow {
  return {
    id,
    provider,
    event_id: `evt_${id}`,
    event_type: "invoice.payment_failed",
    payload: { object: { id: "in_123" } },
    error_message: "boom",
    status: "unresolved",
    replay_attempts: 0,
    last_replay_at: null,
    created_at: createdAt,
    ...extra,
  };
}

function em(id: string, category: string, createdAt: string, extra: Partial<EmailDeadLetterRow> = {}): EmailDeadLetterRow {
  return {
    id,
    recipient: "user@example.com",
    subject: "Your grade is ready",
    category,
    status: "dead_letter",
    attempts: 6,
    max_attempts: 6,
    last_error: "smtp 550",
    created_at: createdAt,
    ...extra,
  };
}

Deno.test("isDeadLetterSource accepts only the two sources", () => {
  assert(isDeadLetterSource("webhook"));
  assert(isDeadLetterSource("email"));
  assert(!isDeadLetterSource("content"));
  assert(!isDeadLetterSource(undefined));
});

Deno.test("isWebhookReplayable — stripe + content yes, ebay/appstore no", () => {
  assert(isWebhookReplayable("stripe"));
  assert(isWebhookReplayable("content"));
  assert(!isWebhookReplayable("ebay"));
  assert(!isWebhookReplayable("appstore"));
});

Deno.test("payloadPreview truncates + single-lines", () => {
  const long = { note: "x".repeat(500) };
  const p = payloadPreview(long, 50);
  assertEquals(p.length, 50);
  assert(p.endsWith("…"));
  assertEquals(payloadPreview({ a: 1 }), '{"a":1}');
  assertEquals(payloadPreview("a\n  b\tc"), "a b c");
});

Deno.test("toUnifiedFromWebhook maps provider + replayability + age", () => {
  const u = toUnifiedFromWebhook(wh("1", "stripe", "2026-06-14T11:00:00Z", { replay_attempts: 2 }), NOW);
  assertEquals(u.source, "webhook");
  assertEquals(u.provider, "stripe");
  assertEquals(u.reference, "invoice.payment_failed");
  assertEquals(u.attempt_count, 2);
  assertEquals(u.replayable, true);
  assertEquals(u.age_seconds, 3600);

  const ebay = toUnifiedFromWebhook(wh("2", "ebay", "2026-06-14T11:00:00Z"), NOW);
  assertEquals(ebay.replayable, false);
});

Deno.test("toUnifiedFromEmail uses category as provider, always replayable", () => {
  const u = toUnifiedFromEmail(em("e1", "grade_ready", "2026-06-14T11:30:00Z"), NOW);
  assertEquals(u.source, "email");
  assertEquals(u.provider, "grade_ready");
  assertEquals(u.reference, "Your grade is ready");
  assertEquals(u.replayable, true);
  assertEquals(u.attempt_count, 6);
  assertEquals(u.age_seconds, 1800);
  // No recipient PII leaked verbatim beyond the preview field intent.
  assert(u.payload_preview.includes("Your grade is ready"));
});

Deno.test("parseDeadLetterQuery clamps + filters", () => {
  const params: Record<string, string> = { source: "email", provider: "grade_ready", page: "3", page_size: "200" };
  const q = parseDeadLetterQuery((k) => params[k]);
  assertEquals(q.source, "email");
  assertEquals(q.provider, "grade_ready");
  assertEquals(q.page, 3);
  assertEquals(q.pageSize, 100); // clamped to max 100

  const empty = parseDeadLetterQuery(() => undefined);
  assertEquals(empty.source, null);
  assertEquals(empty.provider, null);
  assertEquals(empty.page, 1);
  assertEquals(empty.pageSize, 50);

  const bad = parseDeadLetterQuery((k) => ({ source: "nope", page: "0" }[k]));
  assertEquals(bad.source, null);
  assertEquals(bad.page, 1);
});

Deno.test("buildUnifiedPage filters by source, sorts newest-first, paginates", () => {
  const rows: UnifiedDeadLetter[] = [
    toUnifiedFromWebhook(wh("w1", "stripe", "2026-06-14T09:00:00Z"), NOW),
    toUnifiedFromWebhook(wh("w2", "content", "2026-06-14T11:00:00Z"), NOW),
    toUnifiedFromEmail(em("e1", "grade_ready", "2026-06-14T10:00:00Z"), NOW),
  ];

  // No filter → all three, newest first.
  const all = buildUnifiedPage(rows, { source: null, provider: null, page: 1, pageSize: 50 }, NOW);
  assertEquals(all.total, 3);
  assertEquals(all.items.map((i) => i.id), ["w2", "e1", "w1"]);
  assertEquals(all.providers, ["content", "grade_ready", "stripe"]);

  // Source filter.
  const webhooksOnly = buildUnifiedPage(rows, { source: "webhook", provider: null, page: 1, pageSize: 50 }, NOW);
  assertEquals(webhooksOnly.total, 2);
  assertEquals(webhooksOnly.providers, ["content", "stripe"]);

  // Provider filter within source.
  const stripeOnly = buildUnifiedPage(rows, { source: "webhook", provider: "stripe", page: 1, pageSize: 50 }, NOW);
  assertEquals(stripeOnly.total, 1);
  assertEquals(stripeOnly.items[0]!.id, "w1");
  // providers list reflects the by-source set, not the by-provider narrowing.
  assertEquals(stripeOnly.providers, ["content", "stripe"]);
});

Deno.test("buildUnifiedPage paginates", () => {
  const rows: UnifiedDeadLetter[] = Array.from({ length: 5 }, (_, i) =>
    toUnifiedFromWebhook(wh(`w${i}`, "stripe", `2026-06-14T1${i}:00:00Z`), NOW));
  const p2 = buildUnifiedPage(rows, { source: null, provider: null, page: 2, pageSize: 2 }, NOW);
  assertEquals(p2.total, 5);
  assertEquals(p2.items.length, 2);
  assertEquals(p2.page, 2);
});

Deno.test("normalizeDiscardReason requires non-empty + bounds length", () => {
  assertEquals(normalizeDiscardReason(""), null);
  assertEquals(normalizeDiscardReason("   "), null);
  assertEquals(normalizeDiscardReason(42), null);
  assertEquals(normalizeDiscardReason("  duplicate  "), "duplicate");
  assertEquals(normalizeDiscardReason("x".repeat(2000))!.length, 1000);
});

Deno.test("audit shapes carry source/provider/reason and stable actions", () => {
  const r = retryAudit("webhook", "w1", "stripe");
  assertEquals(r.action, DLQ_RETRY_AUDIT_ACTION);
  assertEquals(r.targetId, "webhook:w1");
  assertEquals(r.details.provider, "stripe");

  const d = discardAudit("email", "e1", "grade_ready", "spam");
  assertEquals(d.action, DLQ_DISCARD_AUDIT_ACTION);
  assertEquals(d.details.reason, "spam");

  const b = bulkAudit("retry", { source: "webhook", provider: "stripe" }, { processed: 3, succeeded: 2, failed: 1 });
  assertEquals(b.details.bulk_action, "retry");
  assertEquals(b.details.succeeded, 2);
  assertEquals(b.details.failed, 1);
});
