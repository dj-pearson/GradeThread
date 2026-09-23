// scripts/db-rls-initplan-check.mjs reads EXPLAIN text, and the text differs by
// Postgres version. These plans were captured from the local Postgres 16.13
// cluster on 2026-09-23 with the check's own probe SQL; the PG17 one is the
// shape the CI image prints. Until then the detector knew only the PG17 form
// and called every correctly hoisted PG16 plan a regression.

import { describe, expect, it } from "vitest";
import { usesInitPlan } from "./lib/initplan-plan.mjs";

const JWT_SUB =
  "(NULLIF(((COALESCE(NULLIF(current_setting('request.jwt.claims'::text, true), ''::text), '{}'::text))::jsonb ->> 'sub'::text), ''::text))::uuid";

const PG16_GOOD = `
 Seq Scan on public.gt_initplan_probe_good (actual rows=250 loops=1)
   Output: gt_initplan_probe_good.id, gt_initplan_probe_good.payload
   Filter: ($0 = gt_initplan_probe_good.user_id)
   Rows Removed by Filter: 4750
   InitPlan 1 (returns $0)
     ->  Result (actual rows=1 loops=1)
           Output: ${JWT_SUB}
`;

const PG16_BARE = `
 Seq Scan on public.gt_initplan_probe_bare (actual rows=250 loops=1)
   Output: id, payload
   Filter: (${JWT_SUB} = gt_initplan_probe_bare.user_id)
   Rows Removed by Filter: 4750
`;

const PG16_SUBMISSIONS = `
 Limit (actual rows=0 loops=1)
   Output: submissions.id, submissions.title, submissions.status, submissions.created_at
   InitPlan 1 (returns $0)
     ->  Result (never executed)
           Output: ${JWT_SUB}
   InitPlan 2 (returns $1)
     ->  Result (never executed)
           Output: ${JWT_SUB}
   ->  Sort (actual rows=0 loops=1)
         Sort Key: submissions.created_at DESC
         ->  Seq Scan on public.submissions (actual rows=0 loops=1)
               Filter: (($0 = submissions.user_id) OR is_workspace_member_with_role(submissions.user_id, 'viewer'::workspace_role) OR ($1 = submissions.user_id) OR is_admin())
`;

const PG17_GOOD = `
 Seq Scan on public.gt_initplan_probe_good (actual rows=250 loops=1)
   Output: gt_initplan_probe_good.id, gt_initplan_probe_good.payload
   Filter: ((InitPlan 1).col1 = gt_initplan_probe_good.user_id)
   Rows Removed by Filter: 4750
   InitPlan 1
     ->  Result (actual rows=1 loops=1)
           Output: ${JWT_SUB}
`;

describe("usesInitPlan reads both Postgres plan formats", () => {
  it("PG16: the (select auth.uid()) probe is hoisted", () => {
    expect(usesInitPlan(PG16_GOOD)).toBe(true);
  });

  it("PG16: public.submissions is hoisted", () => {
    expect(usesInitPlan(PG16_SUBMISSIONS)).toBe(true);
  });

  it("PG16: the bare auth.uid() probe is NOT, which is the self-check", () => {
    expect(usesInitPlan(PG16_BARE)).toBe(false);
  });

  it("PG17: the (InitPlan 1).col1 form still counts", () => {
    expect(usesInitPlan(PG17_GOOD)).toBe(true);
  });

  it("an InitPlan the filter does not use is not a hoisted filter", () => {
    // The node is present but the filter re-evaluates the expression per row.
    const plan = PG16_BARE + "   InitPlan 1 (returns $0)\n     ->  Result\n";
    expect(usesInitPlan(plan)).toBe(false);
  });

  it("a $N in the filter that no InitPlan returns does not count", () => {
    // $1 here is some other parameter; the InitPlan returns $0.
    const plan =
      " Seq Scan on t\n   Filter: ($1 = t.user_id)\n   InitPlan 1 (returns $0)\n";
    expect(usesInitPlan(plan)).toBe(false);
  });

  it("$1 is not read as $10", () => {
    const plan =
      " Seq Scan on t\n   Filter: ($10 = t.user_id)\n   InitPlan 1 (returns $1)\n";
    expect(usesInitPlan(plan)).toBe(false);
  });
});
