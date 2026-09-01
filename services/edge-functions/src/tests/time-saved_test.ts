// US-9207: the time-saved meter's pure rules.
//
//   deno test --allow-read src/tests/time-saved_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  classifyAiLog,
  monthRange,
  sumTimeSaved,
  TIME_SAVED_MINUTES,
  TIME_SAVED_TASKS,
} from "../lib/time-saved.ts";

Deno.test("only tasks with an event count, and the breakdown lists only those", () => {
  const s = sumTimeSaved({ photo_edit: 3, comps: 0, delist: -2, relist: Number.NaN, cross_list: 2 });
  assertEquals(s.lines.map((l) => l.task), ["photo_edit", "cross_list"]);
  assertEquals(s.totalMinutes, 3 * TIME_SAVED_MINUTES.photo_edit + 2 * TIME_SAVED_MINUTES.cross_list);
  assertEquals(sumTimeSaved({}), { totalMinutes: 0, lines: [] });
});

Deno.test("every task has a positive minute figure", () => {
  for (const t of TIME_SAVED_TASKS) assert(TIME_SAVED_MINUTES[t] > 0, t);
});

Deno.test("the month is UTC, defaulted to now, and refused when malformed", () => {
  const r = monthRange("2026-09");
  assertEquals(r, { start: "2026-09-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z", month: "2026-09" });
  assertEquals(monthRange("2026-12")?.end, "2027-01-01T00:00:00.000Z");
  assertEquals(monthRange(undefined, new Date("2026-03-15T12:00:00Z"))?.month, "2026-03");
  assertEquals(monthRange("2026-13"), null);
  assertEquals(monthRange("September"), null);
});

Deno.test("an AI log row is classified by the keys its route writes", () => {
  assertEquals(classifyAiLog({ listing_title: "x", listing_description: "y" }), "title_description");
  assertEquals(classifyAiLog({ category_id: "1", aspect_suggestions: {} }), "item_specifics");
  assertEquals(classifyAiLog({ chest: 21, length: 28 }), "measurements");
  assertEquals(classifyAiLog({ title: "x", brand: "Nike" }), "title_description");
  assertEquals(classifyAiLog({ size: "M", gender: "women", confidence: 0.8 }), null, "a size guess is not a task");
  assertEquals(classifyAiLog({}), null);
  assertEquals(classifyAiLog(null), null);
});
