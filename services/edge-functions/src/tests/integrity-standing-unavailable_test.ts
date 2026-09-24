// R14: a failed integrity read says so, rather than posing as "no history".
//
// The rewards page used to receive the empty "Building history" standing when
// the read failed, which told a Trusted seller they had no standing at all.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { installFakePostgrest } from "./_fake-postgrest.ts";
import { loadSellerIntegrityStanding } from "../lib/buyer-grade-confirmation.ts";

Deno.test("R14: a failed integrity read is flagged unavailable", async () => {
  const db = installFakePostgrest();
  try {
    db.reset({ seller_grade_integrity: [] });
    db.failNext("seller_grade_integrity", "GET");
    const standing = await loadSellerIntegrityStanding(crypto.randomUUID());
    assertEquals(standing.unavailable, true);
    // Still a valid shape for any caller that ignores the flag.
    assertEquals(standing.displayable, false);
  } finally {
    db.restore();
  }
});

Deno.test("R14: a seller with no row is building history, not unavailable", async () => {
  const db = installFakePostgrest();
  try {
    db.reset({ seller_grade_integrity: [] });
    const standing = await loadSellerIntegrityStanding(crypto.randomUUID());
    assert(!standing.unavailable);
    assertEquals(standing.tier, "building");
  } finally {
    db.restore();
  }
});
