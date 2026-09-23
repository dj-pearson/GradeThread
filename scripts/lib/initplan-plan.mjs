// The plan-text half of scripts/db-rls-initplan-check.mjs, kept apart so a
// test can feed it real plans without a database.
//
// "InitPlan" appearing anywhere is not enough — it has to be what the row
// filter actually references, which is the difference between hoisted and
// merely present.
//
// TWO SPELLINGS OF THE SAME PLAN. Postgres 17 prints the hoisted value as
// `(InitPlan 1).col1` inside the filter. Postgres 16 and earlier declare the
// node as `InitPlan 1 (returns $0)` and reference it as `$0` in the filter.
// The CI stack prints the 17 form (this check passed there matching nothing
// else), the cloud-session cluster is 16, and until 2026-09-23 this matched only
// the 17 form, so on 16 it called a correctly hoisted policy a regression. Both forms still require the FILTER to reference the
// InitPlan's output, which the bare-form probe never does.
export function usesInitPlan(plan) {
  if (!/InitPlan/.test(plan)) return false;
  // PG17+: the filter names the InitPlan directly.
  if (/\(InitPlan \d+\)\.col\d+/.test(plan)) return true;
  // PG16 and earlier: the node declares the params it returns, and a Filter
  // line has to use one of them. A `$N` anywhere else does not count.
  for (const m of plan.matchAll(/InitPlan \d+ \(returns ((?:\$\d+,?)+)\)/g)) {
    for (const param of m[1].split(",")) {
      const n = param.slice(1);
      if (new RegExp(`Filter:[^\\n]*\\$${n}(?!\\d)`).test(plan)) return true;
    }
  }
  return false;
}
