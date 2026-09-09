import { assertEquals } from "@std/assert";
import { addMonthsClamped, startOfNextMonth } from "../lib/month-math.ts";

/** Local-time yyyy-mm-dd, so a case reads as the date a seller would see. */
function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

Deno.test("a month from the 31st is the last day of the next month, not the 3rd", () => {
  // The case that shipped: pause on 31 January for one month and the seller was
  // told 3 March. Every one of these was wrong before, and every one of them
  // looks right if you only ever test on the 15th.
  assertEquals(ymd(addMonthsClamped(new Date(2026, 0, 31), 1)), "2026-02-28");
  assertEquals(ymd(addMonthsClamped(new Date(2026, 0, 30), 1)), "2026-02-28");
  assertEquals(ymd(addMonthsClamped(new Date(2026, 0, 29), 1)), "2026-02-28");
  assertEquals(ymd(addMonthsClamped(new Date(2026, 7, 31), 1)), "2026-09-30");
  assertEquals(ymd(addMonthsClamped(new Date(2026, 9, 31), 1)), "2026-11-30");
});

Deno.test("February gets its 29th in a leap year", () => {
  assertEquals(ymd(addMonthsClamped(new Date(2028, 0, 31), 1)), "2028-02-29");
});

Deno.test("a day that exists in the target month is left alone", () => {
  assertEquals(ymd(addMonthsClamped(new Date(2026, 0, 15), 1)), "2026-02-15");
  assertEquals(ymd(addMonthsClamped(new Date(2026, 0, 1), 2)), "2026-03-01");
  assertEquals(ymd(addMonthsClamped(new Date(2026, 4, 20), 3)), "2026-08-20");
});

Deno.test("crossing a year boundary keeps the day and moves the year", () => {
  assertEquals(ymd(addMonthsClamped(new Date(2026, 11, 15), 1)), "2027-01-15");
  assertEquals(ymd(addMonthsClamped(new Date(2026, 11, 31), 2)), "2027-02-28");
  assertEquals(ymd(addMonthsClamped(new Date(2026, 10, 30), 14)), "2028-01-30");
});

Deno.test("going backwards clamps the same way", () => {
  assertEquals(ymd(addMonthsClamped(new Date(2026, 2, 31), -1)), "2026-02-28");
  assertEquals(ymd(addMonthsClamped(new Date(2026, 0, 15), -1)), "2025-12-15");
});

Deno.test("the time of day survives untouched", () => {
  const from = new Date(2026, 0, 31, 13, 45, 30, 250);
  const out = addMonthsClamped(from, 1);
  assertEquals(
    [out.getHours(), out.getMinutes(), out.getSeconds(), out.getMilliseconds()],
    [13, 45, 30, 250],
  );
});

Deno.test("the free-tier reset lands on the 1st of NEXT month, from any day", () => {
  // The old expression was +1 month then setDate(1). On 31 January that gave
  // 3 March clamped to 1 March: a whole month late, so a free seller waited an
  // extra cycle for their included grades.
  assertEquals(ymd(startOfNextMonth(new Date(2026, 0, 31))), "2026-02-01");
  assertEquals(ymd(startOfNextMonth(new Date(2026, 0, 1))), "2026-02-01");
  assertEquals(ymd(startOfNextMonth(new Date(2026, 11, 31))), "2027-01-01");
});

Deno.test("the reset is midnight, not the time of day it happened to be computed", () => {
  const out = startOfNextMonth(new Date(2026, 0, 31, 23, 59, 59, 999));
  assertEquals(
    [out.getHours(), out.getMinutes(), out.getSeconds(), out.getMilliseconds()],
    [0, 0, 0, 0],
  );
});
