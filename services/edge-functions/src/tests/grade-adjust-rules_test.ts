// US-478: a grade adjustment swinging the overall score by MORE than 1.5 points
// requires super_admin. The route enforces this server-side; here we prove the
// pure rule that backs it.

import { assertEquals } from "@std/assert";
import {
  requiresSuperAdmin,
  ADMIN_MAX_ADJUST_DELTA,
} from "../lib/grade-adjust-rules.ts";

Deno.test("a swing > 1.5 points requires super_admin", () => {
  assertEquals(requiresSuperAdmin(5.0, 7.0), true); // 2.0
  assertEquals(requiresSuperAdmin(8.0, 6.0), true); // 2.0 (downward)
  assertEquals(requiresSuperAdmin(5.0, 6.6), true); // 1.6
});

Deno.test("a swing <= 1.5 points does NOT require super_admin", () => {
  assertEquals(requiresSuperAdmin(5.0, 6.5), false); // exactly 1.5
  assertEquals(requiresSuperAdmin(5.0, 6.0), false); // 1.0
  assertEquals(requiresSuperAdmin(7.0, 7.0), false); // 0
});

Deno.test("an exactly-threshold swing isn't tripped by float noise", () => {
  // 9.0 - 7.5 = 1.5 exactly — must stay allowed despite FP representation.
  assertEquals(requiresSuperAdmin(9.0, 7.5), false);
  assertEquals(ADMIN_MAX_ADJUST_DELTA, 1.5);
});
