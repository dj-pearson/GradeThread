#!/usr/bin/env node
// 00836 -- prove the FlipDesk Analytics RPCs read ONE workspace.
//
// The invoker RPCs (sell-through, grading ROI, returns, listing performance)
// read items_full / listings, and RLS admits every workspace the caller
// belongs to, so a seller who was also a member elsewhere saw both blended.
// The definer RPCs (seller_scorecard, community_benchmarks) built their "you"
// figures from auth.uid(), so a member inside an owner's workspace saw their
// own figures. 00836 gives every one p_owner_id, checked against membership.
//
// IT ASSERTS BOTH DIRECTIONS. A function that refused everyone would satisfy
// "the stranger is refused" on its own and blank the Analytics page, so the
// owner, both members and the service role must all get their numbers.
//
// AND IT PINS THE COHORT. seller_scorecard and community_benchmarks read every
// seller to build a k-anonymous cohort; 00836 must move the "you" slice and
// nothing else. The cohort hash must be the same whoever asks, and every
// community_benchmarks_v2 answer outside `you` must equal v1's for that caller.
//
// Usage:
//   node scripts/check-analytics-owner-scope.mjs --dsn "postgresql://..."
//   node scripts/check-analytics-owner-scope.mjs                  # docker
//
// Writes nothing: the fixture runs inside a transaction that rolls back.

import { join } from "node:path";
import { psqlTarget, runFixture } from "./lib/psql-target.mjs";

const psql = psqlTarget();
const { ok, out } = runFixture(
  psql,
  join(import.meta.dirname, "fixtures", "analytics-owner-scope.sql"),
);
if (!ok || !/RESULT /.test(out)) {
  console.error(
    `✗ could not reach ${psql.how}, or it answered nothing.\n  ${psql.hint}\n  ` +
      (out.split("\n").find(Boolean) ?? "no output"),
  );
  process.exit(2);
}

const read = (kind, name) => {
  const m = new RegExp(`${kind} ${name.replace(".", "\\.")}=(\\S+)`).exec(out);
  return m ? m[1] : null;
};

// A owns six items: three completed sales, one refunded, two still on eBay
// (30 and 0 views); three are graded. B owns five: one completed sale, four
// on eBay at 100 views each. Blended, sell-through would read listed:11,
// the tiles n:6 and so on, so every A or B answer below excludes the other.
const A = {
  st: "listed:6,sold:4",
  roisum: "g:3/2,u:3/2",
  roi: "sold:4",
  ret: "sold:4,returns:1",
  lps: "n:2,views:30",
  lpp: "total:2,rows:2",
  sc: "own:0.5000,n:6,fulfilled:4,returns:1",
  // peers:6 is every seller but A. The peer set follows the owner too.
  cb: "listed:6,sold:4,peers:6,cohort:same",
};
const B = {
  st: "listed:5,sold:1",
  roisum: "g:1/1,u:4/0",
  roi: "sold:1",
  ret: "sold:1,returns:0",
  lps: "n:4,views:400",
  lpp: "total:4,rows:4",
  sc: "own:0.2000,n:5,fulfilled:1,returns:0",
  cb: "listed:5,sold:1,peers:6,cohort:same",
};
// A caller with no rows of their own. peers:7 is all seven sellers.
const EMPTY = {
  st: "listed:0,sold:0",
  roisum: "g:0/0,u:0/0",
  roi: "sold:0",
  ret: "sold:0,returns:0",
  lps: "n:0,views:0",
  lpp: "total:0,rows:0",
  sc: "own:null,n:0,fulfilled:0,returns:0",
  cb: "listed:0,sold:0,peers:7,cohort:same",
};
// The service role with no owner has no uid, so no peer set is left out
// either way; v1 answers exactly the same (no peer comparison).
const SERVICE_EMPTY = { ...EMPTY, cb: "listed:0,sold:0,peers:none,cohort:same" };
const REFUSED = Object.fromEntries(Object.keys(A).map((k) => [k, "REFUSED_42501"]));

const RPCS = {
  st: "flipdesk_sell_through",
  roisum: "flipdesk_grading_roi_summary",
  roi: "flipdesk_grading_roi",
  ret: "flipdesk_return_reduction_v2",
  lps: "flipdesk_listing_performance_summary",
  lpp: "flipdesk_listing_performance_page",
  sc: "seller_scorecard",
  cb: "community_benchmarks_v2",
};

// [key, what the caller is, expected]
const CASES = [
  ["owner_a", "A reads A's workspace", A],
  ["owner_a_null", "A with no owner (an old client): A's own", A],
  ["a_in_b", "A switched into B's workspace", B],
  ["member_b", "M (member of both) reads B's workspace", B],
  ["member_a", "M reads A's workspace", A],
  ["member_null", "M with no owner: M's own, which is empty", EMPTY],
  ["stranger_a", "S names A's workspace", REFUSED],
  ["stranger_null", "S with no owner: S's own, which is empty", EMPTY],
  ["anon_a", "anon names A's workspace", REFUSED],
  ["anon_null", "anon with no owner", REFUSED],
  ["service_role_a", "the service role names A's workspace", A],
  ["service_role_null", "the service role with no owner: nothing", SERVICE_EMPTY],
];

const failures = [];
for (const [rpc, fn] of Object.entries(RPCS)) {
  console.log(`  ${fn}`);
  for (const [key, label, want] of CASES) {
    const got = read("RESULT", `${rpc}.${key}`);
    const pass = got === want[rpc];
    console.log(`    ${pass ? "✓" : "✗"} ${label.padEnd(46)} ${got ?? "(no result)"}`);
    if (!pass) failures.push(`${fn}, ${label}: got ${got ?? "nothing"}, expected ${want[rpc]}`);
  }
}

// The cohort is the same whoever asks and whichever workspace they name.
for (const rpc of ["sc", "cb"]) {
  const hashes = CASES.map(([key]) => read("COHORT", `${rpc}.${key}`)).filter(Boolean);
  const distinct = new Set(hashes);
  const pass = hashes.length >= 8 && distinct.size === 1;
  console.log(
    `  ${pass ? "✓" : "✗"} ${RPCS[rpc]} cohort is owner-independent ` +
      `(${hashes.length} answers, ${distinct.size} cohort hash${distinct.size === 1 ? "" : "es"})`,
  );
  if (!pass) failures.push(`${RPCS[rpc]}: the cohort moved with the caller or owner`);
}

const total = Object.keys(RPCS).length * CASES.length + 2;
if (failures.length > 0) {
  console.error(
    `\n✗ ${failures.length} of ${total} check(s) failed:\n  - ${failures.join("\n  - ")}\n` +
      "  Each analytics RPC must count only the p_owner_id workspace (NULL = the\n" +
      "  caller's own), refuse a caller who is not its owner, a member of it, or the\n" +
      "  service role with 42501, refuse anon, and (the two cohort RPCs) move only\n" +
      "  the caller's own slice. That is 00836.",
  );
  process.exit(1);
}

console.log(
  `\n✓ ${total}/${total}: the Analytics RPCs read one workspace, a stranger and ` +
    "anon get 42501, the owner, members and the service role still get their " +
    "numbers, and the community cohort is unchanged.",
);
