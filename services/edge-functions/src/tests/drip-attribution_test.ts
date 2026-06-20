// US-937: conversion attribution is computed by the PURE
// `computeConversionAttribution` (drip-graph.ts) so the webhook
// (lib/drip-conversion.ts) and these tests share one source of truth. Runs with
// no DB/env. Asserts the ACs directly: last-touch credit, first-touch recorded,
// days-to-convert, the organic fallback (AC4), and engagement-after-conversion
// being ignored.

import { assertEquals } from "@std/assert";
import {
  computeConversionAttribution,
  type DripSendRecord,
} from "../lib/drip-graph.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000; // arbitrary fixed clock start (enrollment)

function send(
  ordinal: number,
  phase: "in_trial" | "win_back",
  sentDay: number,
  opts: { openedDay?: number; clickedDay?: number; variant?: string } = {},
): DripSendRecord {
  return {
    ordinal,
    phase,
    variant: opts.variant ?? null,
    sentAtMs: T0 + sentDay * DAY,
    openedAtMs: opts.openedDay != null ? T0 + opts.openedDay * DAY : null,
    clickedAtMs: opts.clickedDay != null ? T0 + opts.clickedDay * DAY : null,
  };
}

Deno.test("last-touch credits the last engaged email; first-touch the first (AC1)", () => {
  const convertedAt = T0 + 9 * DAY;
  const a = computeConversionAttribution(
    [
      send(1, "in_trial", 0, { openedDay: 1, variant: "a" }),
      send(2, "in_trial", 3, { clickedDay: 4, variant: "b" }),
      send(3, "in_trial", 7, { openedDay: 8, variant: "c" }),
    ],
    T0,
    convertedAt,
  );
  assertEquals(a.model, "last_touch");
  assertEquals(a.step, 3, "canonical step is the last-touch step");
  assertEquals(a.lastTouchStep, 3);
  assertEquals(a.firstTouchStep, 1);
  assertEquals(a.variant, "c");
  assertEquals(a.lastTouchAtMs, T0 + 8 * DAY);
  assertEquals(a.daysToConvert, 9);
});

Deno.test("a click counts as engagement (not just an open)", () => {
  const a = computeConversionAttribution(
    [send(1, "win_back", 0, { clickedDay: 1, variant: "x" })],
    T0,
    T0 + 2 * DAY,
  );
  assertEquals(a.model, "last_touch");
  assertEquals(a.step, 1);
  assertEquals(a.phase, "win_back");
});

Deno.test("organic: converted without opening/clicking any drip email (AC4)", () => {
  const a = computeConversionAttribution(
    [
      send(1, "in_trial", 0),
      send(2, "in_trial", 3, { variant: "b" }),
    ],
    T0,
    T0 + 5 * DAY,
  );
  assertEquals(a.model, "organic");
  assertEquals(a.firstTouchStep, null);
  assertEquals(a.lastTouchStep, null);
  assertEquals(a.lastTouchAtMs, null);
  // Still names the last step that was in flight before conversion.
  assertEquals(a.step, 2);
  assertEquals(a.variant, "b");
  assertEquals(a.daysToConvert, 5);
});

Deno.test("organic with nothing sent → step null", () => {
  const a = computeConversionAttribution([], T0, T0 + DAY);
  assertEquals(a.model, "organic");
  assertEquals(a.step, null);
  assertEquals(a.variant, null);
  assertEquals(a.phase, "in_trial");
});

Deno.test("engagement AFTER conversion is ignored", () => {
  const convertedAt = T0 + 5 * DAY;
  const a = computeConversionAttribution(
    [
      send(1, "in_trial", 0, { openedDay: 1 }), // engaged before → counts
      send(2, "in_trial", 3, { openedDay: 6 }), // opened after convert → ignored
    ],
    T0,
    convertedAt,
  );
  assertEquals(a.model, "last_touch");
  assertEquals(a.step, 1, "the post-conversion open must not win the credit");
  assertEquals(a.lastTouchStep, 1);
});

Deno.test("a step sent after conversion cannot be credited", () => {
  const convertedAt = T0 + 2 * DAY;
  const a = computeConversionAttribution(
    [
      send(1, "in_trial", 0, { openedDay: 1 }),
      send(2, "in_trial", 4, { openedDay: 4 }), // sent after conversion
    ],
    T0,
    convertedAt,
  );
  assertEquals(a.step, 1);
  assertEquals(a.lastTouchStep, 1);
});

Deno.test("days-to-convert is fractional and never negative", () => {
  const a = computeConversionAttribution([], T0, T0 + Math.round(1.5 * DAY));
  assertEquals(a.daysToConvert, 1.5);
  const b = computeConversionAttribution([], T0 + DAY, T0); // converted "before" start
  assertEquals(b.daysToConvert, 0);
});
