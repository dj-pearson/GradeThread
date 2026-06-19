// US-955: auto-publish green drafts — triage rule + completion-notification copy.

import { assertEquals } from "@std/assert";
import {
  AUTO_PUBLISH_QA_MIN,
  buildAutoPublishNotification,
  emptySkips,
  isGreenDraft,
  totalSkipped,
} from "../lib/auto-publish-green.ts";

// ── green triage (mirrors the frontend tierOf, US-550) ─────────────────

Deno.test("green = confident AND clean QA (or unscored)", () => {
  assertEquals(isGreenDraft({ needsReview: false, photoQaScore: null }), true);
  assertEquals(isGreenDraft({ needsReview: false, photoQaScore: 95 }), true);
  assertEquals(
    isGreenDraft({ needsReview: false, photoQaScore: AUTO_PUBLISH_QA_MIN }),
    true,
  );
});

Deno.test("needs_review is never green", () => {
  assertEquals(isGreenDraft({ needsReview: true, photoQaScore: 100 }), false);
});

Deno.test("low photo-QA is never green", () => {
  assertEquals(
    isGreenDraft({ needsReview: false, photoQaScore: AUTO_PUBLISH_QA_MIN - 1 }),
    false,
  );
});

// ── skip accounting ────────────────────────────────────────────────────

Deno.test("totalSkipped sums every reason", () => {
  assertEquals(totalSkipped(emptySkips()), 0);
  assertEquals(
    totalSkipped({ needs_review: 1, blocked: 2, scheduled: 3, plan_limit: 4 }),
    10,
  );
});

// ── completion notification copy ───────────────────────────────────────

Deno.test("notification reports published count when some went live", () => {
  const { title, message } = buildAutoPublishNotification({
    published: 3,
    failed: 0,
    skipped: emptySkips(),
  });
  assertEquals(title, "Auto-published 3 listings");
  assertEquals(message, "3 high-confidence drafts went live.");
});

Deno.test("notification folds in skipped reasons", () => {
  const { title, message } = buildAutoPublishNotification({
    published: 2,
    failed: 1,
    skipped: { needs_review: 4, blocked: 1, scheduled: 2, plan_limit: 0 },
  });
  assertEquals(title, "Auto-published 2 listings");
  assertEquals(
    message,
    "2 high-confidence drafts went live — skipped 8 (1 failed to publish, 4 need review, 1 blocked, 2 scheduled).",
  );
});

Deno.test("notification handles the nothing-published case", () => {
  const { title, message } = buildAutoPublishNotification({
    published: 0,
    failed: 0,
    skipped: { needs_review: 5, blocked: 0, scheduled: 0, plan_limit: 0 },
  });
  assertEquals(title, "Auto-publish finished — nothing went live");
  assertEquals(
    message,
    "No drafts were eligible to auto-publish — skipped 5 (5 need review).",
  );
});

Deno.test("singular grammar for one published listing", () => {
  const { title, message } = buildAutoPublishNotification({
    published: 1,
    failed: 0,
    skipped: emptySkips(),
  });
  assertEquals(title, "Auto-published 1 listing");
  assertEquals(message, "1 high-confidence draft went live.");
});
