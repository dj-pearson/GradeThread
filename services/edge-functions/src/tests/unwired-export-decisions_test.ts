// US-2363 AC3/AC4: the wire-or-delete decisions, pinned by the PROPERTY each
// one protects rather than by the absent name.
//
// Ten exported functions had zero callers anywhere — not even at home, which is
// the audit's own threshold for "built, tested, never connected"
// (scripts/audit-unwired-exports.mjs). All ten were deleted. A test that just
// asserted each name is gone would be worthless: the name being absent is not
// the point, and re-adding a function is legitimate the day something needs it.
//
// What is worth guarding is the reason. Three of these deletions removed a
// SHORTCUT PAST A PROTECTION, and the shortcut is what must not come back —
// under any name.
//
// The remaining deletions (signReferenceUrl, generateAndPersistEmailIssue,
// getReturn, getCancellation, and the three publish-side bulk helpers) are
// judgement calls recorded at the deletion site, and the reasoning lives in the
// comment that replaced each one. Only two of them left a rule behind that
// outlives the function; both are below.

import { assertEquals, assertStringIncludes } from "@std/assert";

const read = (rel: string) =>
  Deno.readTextFileSync(new URL(rel, import.meta.url));

Deno.test("no marketing-class North Star email bypasses the coordinator", () => {
  // THE DELETION THAT MATTERED MOST. `sendNorthStarWeeklyEmail` and
  // `sendNorthStarMilestoneEmail` called `sendEmail` directly. US-934 split
  // these into build-then-coordinate precisely so `coordinateMarketingSend`
  // could apply suppression, the per-recipient daily cap, quiet hours and drip
  // precedence — every one of which a direct send skips silently, because a
  // bypassed suppression looks exactly like a delivered email.
  //
  // Matched on the CATEGORY, not on the old function names: a new wrapper with a
  // different name would be the same defect.
  const email = read("../lib/email.ts");
  assertEquals(
    /category:\s*"north_star/.test(email),
    false,
    "email.ts sends a north_star category directly — marketing-class email must " +
      "go through coordinateMarketingSend, not sendEmail",
  );

  // The other direction. Asserting only the absence above would keep passing if
  // the cron stopped coordinating and simply sent nothing.
  const cron = read("../routes/jobs-north-star.ts");
  assertStringIncludes(cron, "coordinateMarketingSend");
  assertStringIncludes(cron, "buildNorthStarWeeklyEmail");
  assertStringIncludes(cron, "buildNorthStarMilestoneEmail");
});

// `signReferenceUrl` is NOT guarded here, because it was NOT deleted. It was on
// the list and the decision came back the other way: it is the only reader in
// authenticity-references.ts, and US-2218's privacy contract requires that
// module's reads to be signed — `authenticity-references_test.ts` already
// asserts `createSignedUrl` appears in it. Deleting it would have removed the
// sanctioned way to read a private bucket and left the next person to invent
// one. "Nothing calls it" meant the reviewer surface is not built yet, which is
// a different fact from "nothing needs it".

Deno.test("the claim path decides against the pool only through the RPC", () => {
  // `getPoolPeriodState` was the unlocked ledger read that fed the pure gate.
  // Together they are the read-then-decide sequence US-2144 replaced, where two
  // concurrent claims evaluate the same pre-drawdown totals and both pass one
  // budget. The pure gate survives as the readable policy; the loader does not,
  // so the sequence cannot be reassembled from two imports.
  const claim = read("../lib/buyer-guarantee-claim.ts");
  assertEquals(
    claim.includes('from("guarantee_pool_ledger")'),
    false,
    "the claim path must not read the ledger itself — reservePoolDrawdown " +
      "decides and records under one advisory lock",
  );
  assertStringIncludes(claim, "reservePoolDrawdown");
});

Deno.test("every exported eBay bulk helper has a caller", () => {
  // AC4, as a rule rather than as three names. Three bulk helpers were exported
  // and unused; two others are load-bearing. The difference is whether anything
  // calls them, so that is what this checks — a new bulk_* wrapper added "for
  // later" fails here instead of aging into the next audit.
  const client = read("../lib/ebay-client.ts");
  const names = [...client.matchAll(/export async function (bulk[A-Za-z]+)/g)].map(
    (m) => m[1],
  );
  // Canary: the file must still export SOME bulk helper, or an empty list would
  // make this pass by finding nothing to check.
  assertEquals(names.length > 0, true, "no bulk helpers found — scan is broken");

  const callers = ["../routes/flipdesk-ebay.ts", "../lib/ebay-bulk.ts"]
    .map((p) => {
      try {
        return read(p);
      } catch {
        return "";
      }
    })
    .join("\n");
  const orphans = names.filter((n) => !new RegExp(`\\b${n}\\s*\\(`).test(callers));
  assertEquals(
    orphans,
    [],
    "these bulk helpers are exported but called by nothing — wire them or " +
      "delete them (US-2363 AC4)",
  );
});
