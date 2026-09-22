// US-3457: the carried-forward trial_end is never inside Stripe's 48-hour
// refusal window.
//
//   deno test src/tests/trial-carry-forward_test.ts

import { assertEquals } from "@std/assert";
import {
  carriedForwardTrialEnd,
  STRIPE_MIN_TRIAL_END_MS,
  TRIAL_END_FLOOR_MARGIN_MS,
} from "../lib/trial-carry-forward.ts";

const NOW = Date.parse("2026-09-22T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const floorSec = Math.floor((NOW + STRIPE_MIN_TRIAL_END_MS + TRIAL_END_FLOOR_MARGIN_MS) / 1000);

Deno.test("US-3457: a trial with 10 days left is carried forward as is", () => {
  const end = NOW + 240 * HOUR;
  assertEquals(
    carriedForwardTrialEnd({ trial_ends_at: iso(end), flipdesk_subscription_id: null }, NOW),
    Math.floor(end / 1000),
  );
});

Deno.test("US-3457: a trial ending in 20 hours is floored to now + 48h + margin", () => {
  const end = NOW + 20 * HOUR;
  assertEquals(
    carriedForwardTrialEnd({ trial_ends_at: iso(end), flipdesk_subscription_id: null }, NOW),
    floorSec,
  );
});

Deno.test("US-3457: a trial ending exactly at 48h is still lifted by the margin", () => {
  const end = NOW + STRIPE_MIN_TRIAL_END_MS;
  assertEquals(
    carriedForwardTrialEnd({ trial_ends_at: iso(end), flipdesk_subscription_id: null }, NOW),
    floorSec,
  );
});

Deno.test("US-3457: a trial ending one minute past the floor is not touched", () => {
  const end = NOW + STRIPE_MIN_TRIAL_END_MS + TRIAL_END_FLOOR_MARGIN_MS + 60_000;
  assertEquals(
    carriedForwardTrialEnd({ trial_ends_at: iso(end), flipdesk_subscription_id: null }, NOW),
    Math.floor(end / 1000),
  );
});

Deno.test("US-3457: an ended trial, no trial, or an existing subscription carries nothing", () => {
  assertEquals(
    carriedForwardTrialEnd({ trial_ends_at: iso(NOW - HOUR), flipdesk_subscription_id: null }, NOW),
    undefined,
  );
  assertEquals(
    carriedForwardTrialEnd({ trial_ends_at: null, flipdesk_subscription_id: null }, NOW),
    undefined,
  );
  assertEquals(
    carriedForwardTrialEnd(
      { trial_ends_at: iso(NOW + 240 * HOUR), flipdesk_subscription_id: "sub_123" },
      NOW,
    ),
    undefined,
  );
});
