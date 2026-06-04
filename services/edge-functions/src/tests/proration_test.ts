// US-399: proration math for an immediate admin paid→free cancel.
import { assertEquals } from "@std/assert";
import { remainingFraction, unusedProrationCents } from "../lib/proration.ts";

const MONTH = 30 * 24 * 60 * 60; // seconds

Deno.test("remainingFraction: clamps to [0,1] and tracks elapsed time", () => {
  // Exactly half the period left.
  assertEquals(remainingFraction(0, MONTH, MONTH / 2), 0.5);
  // Just started → ~all remaining.
  assertEquals(remainingFraction(0, MONTH, 0), 1);
  // Period over → none remaining (clamped, never negative).
  assertEquals(remainingFraction(0, MONTH, MONTH * 2), 0);
  // Degenerate / zero-length period → 0 (no divide-by-zero).
  assertEquals(remainingFraction(100, 100, 100), 0);
});

Deno.test("unusedProrationCents uses the REAL amount paid (honors coupons)", () => {
  // Paid $9.00 (a grandfathered/coupon price, not the list $10), half unused.
  assertEquals(
    unusedProrationCents({ basePaidCents: 900, periodStartSec: 0, periodEndSec: MONTH, nowSec: MONTH / 2 }),
    450,
  );
  // Whole period unused → full refund of what was paid.
  assertEquals(
    unusedProrationCents({ basePaidCents: 1999, periodStartSec: 0, periodEndSec: MONTH, nowSec: 0 }),
    1999,
  );
  // Period fully consumed → nothing to credit.
  assertEquals(
    unusedProrationCents({ basePaidCents: 1999, periodStartSec: 0, periodEndSec: MONTH, nowSec: MONTH }),
    0,
  );
  // A $0 invoice (100%-off coupon) → nothing to refund regardless of timing.
  assertEquals(
    unusedProrationCents({ basePaidCents: 0, periodStartSec: 0, periodEndSec: MONTH, nowSec: MONTH / 4 }),
    0,
  );
});

Deno.test("unusedProrationCents never returns a negative credit", () => {
  assertEquals(
    unusedProrationCents({ basePaidCents: -500, periodStartSec: 0, periodEndSec: MONTH, nowSec: 0 }),
    0,
  );
});
