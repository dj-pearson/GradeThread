// US-2434: the census counts, and the census refuses.
//
// Most of these assert an ABSENCE — no third bucket, no delete path, no address
// in the output. That is the shape of this story: the risk is not a wrong
// number, it is a right number read as a work list and acted on.

import { assert, assertEquals } from "@std/assert";
import { EMAIL_PURGE_PLAN } from "../lib/account-email-purge.ts";
import {
  buildResidueCensus,
  censusNotes,
  classifyAddress,
  formatCensus,
  LEAD_BEARING_TABLES,
  normalizeAddress,
} from "../lib/email-residue-census.ts";

const CTX = { deletionsLogged: 14, retentionSweepLastRunAt: "2026-08-09T04:00:00Z" };

Deno.test("an address on a live account is not residue", () => {
  const live = new Set(["kept@example.test"]);
  assertEquals(classifyAddress("kept@example.test", live), "live_account");
  assertEquals(classifyAddress("gone@example.test", live), "unattributable");
});

Deno.test("classification normalizes the way every write path does", () => {
  const live = new Set(["kept@example.test"]);
  assertEquals(classifyAddress("  KEPT@Example.TEST ", live), "live_account");
  assertEquals(normalizeAddress("  A@B.Test "), "a@b.test");
});

Deno.test("the census counts DISTINCT people, not rows", () => {
  // email_deliveries holds one row per message. Counting rows would report a
  // chatty account as many subjects, which is the number that ends up quoted.
  const census = buildResidueCensus(
    { email_deliveries: ["a@x.test", "a@x.test", "A@X.test", "b@x.test"] },
    new Set(),
  );
  const table = census.perTable.find((t) => t.table === "email_deliveries");
  assertEquals(table?.distinct, 2);
  assertEquals(table?.unattributable, 2);
});

Deno.test("one address across several tables is one person overall", () => {
  const census = buildResidueCensus(
    {
      email_deliveries: ["a@x.test"],
      waitlist_entries: ["a@x.test"],
      email_subscribers: ["a@x.test", "b@x.test"],
    },
    new Set(),
  );
  assertEquals(census.distinctOverall, 2);
  assertEquals(census.unattributableOverall, 2);
});

Deno.test("blank and whitespace addresses are not counted as subjects", () => {
  const census = buildResidueCensus(
    { email_deliveries: ["", "   ", "a@x.test"] },
    new Set(),
  );
  assertEquals(census.perTable.find((t) => t.table === "email_deliveries")?.distinct, 1);
});

Deno.test("every planned table appears, even when empty", () => {
  // A table missing from the report reads as "nothing there" when it may simply
  // not have been queried. Absence has to be visible as a zero.
  const census = buildResidueCensus({}, new Set());
  assertEquals(census.perTable.length, EMAIL_PURGE_PLAN.length);
  for (const t of census.perTable) assertEquals(t.distinct, 0);
});

Deno.test("the census is driven by EMAIL_PURGE_PLAN, not its own table list", () => {
  // A second list of tables would drift from the plan the first time one is
  // added — the exact failure US-2005 built the shared plan to prevent.
  const census = buildResidueCensus({}, new Set());
  assertEquals(
    census.perTable.map((t) => `${t.table}.${t.column}`),
    EMAIL_PURGE_PLAN.map((t) => `${t.table}.${t.column}`),
  );
});

Deno.test("there is no deleted-account bucket", () => {
  // THE LOAD-BEARING ABSENCE. account_deletion_log stores no address (00064) and
  // email_deliveries has no user_id (00095), so a bucket named for erased
  // subjects could never be populated honestly — and a bucket named after a
  // group it cannot identify is how a census becomes a work list.
  const census = buildResidueCensus({ email_deliveries: ["a@x.test"] }, new Set());
  const table = census.perTable[0]!;
  assertEquals(table.distinct, table.liveAccount + table.unattributable);
  assert(!Object.keys(table).some((k) => /deleted|erased|purge_?target/i.test(k)));
});

Deno.test("the lead-bearing tables are flagged so a big number is not misread", () => {
  const census = buildResidueCensus(
    { waitlist_entries: ["a@x.test"], email_deliveries: ["b@x.test"] },
    new Set(),
  );
  assertEquals(census.perTable.find((t) => t.table === "waitlist_entries")?.leadsExpected, true);
  assertEquals(census.perTable.find((t) => t.table === "email_deliveries")?.leadsExpected, false);
  for (const table of LEAD_BEARING_TABLES) {
    assert(
      EMAIL_PURGE_PLAN.some((t) => t.table === table),
      `${table} is flagged as lead-bearing but is not on the purge plan`,
    );
  }
});

Deno.test("the notes say plainly that unattributable is not a backlog", () => {
  const census = buildResidueCensus({ waitlist_entries: ["a@x.test"] }, new Set());
  const notes = censusNotes(census, CTX).join(" ");
  assert(notes.includes("IS NOT A DELETION BACKLOG"), notes);
  assert(notes.includes("DO NOT run EMAIL_PURGE_PLAN"), notes);
  assert(notes.includes("00064"), "the note must cite why, not just assert it");
});

Deno.test("the deletion count is reported as unjoinable, not as a target", () => {
  const notes = censusNotes(buildResidueCensus({}, new Set()), CTX).join(" ");
  assert(notes.includes("14 deletion"), notes);
  assert(notes.includes("cannot be subtracted"), notes);
});

Deno.test("a missing retention sweep is reported as a live problem", () => {
  // The sweep is what actually bounds email_deliveries. If it is not running,
  // every count above is growing rather than draining, and reading them as
  // stable would be wrong.
  const census = buildResidueCensus({}, new Set());
  const running = censusNotes(census, CTX).join(" ");
  assert(running.includes("last ran"), running);
  const stopped = censusNotes(census, {
    deletionsLogged: 0,
    retentionSweepLastRunAt: null,
  }).join(" ");
  assert(stopped.includes("NO data-retention cron run found"), stopped);
});

Deno.test("no address survives into the census, structure or rendering", () => {
  // The output is written for a ticket, and the counted addresses are exactly
  // the PII this story is about — a census that carried samples "for debugging"
  // would create the exposure it exists to measure.
  //
  // Asserted against the STRUCTURE and not only the rendered string, because a
  // string check alone passes trivially today (no current field can hold an
  // address) and would keep passing if someone added one that could.
  const addresses = ["subject@private.test", "lead@private.test"];
  const census = buildResidueCensus(
    { email_deliveries: [addresses[0]!], waitlist_entries: [addresses[1]!] },
    new Set(["live@private.test"]),
  );
  const serialized = JSON.stringify(census);
  const rendered = formatCensus(census, CTX);
  for (const address of addresses) {
    assert(!serialized.includes(address), `census structure carries ${address}`);
    assert(!rendered.includes(address), `rendered census carries ${address}`);
  }
  assert(!serialized.includes("@private.test"), serialized);
  assert(!rendered.includes("@private.test"), rendered);
});

Deno.test("the census module has no way to delete anything", async () => {
  // Guards the shape rather than the behaviour: the module is the place someone
  // would reach for when asked to "just clean it up", and the answer has to be
  // that there is nothing there to call.
  const src = await Deno.readTextFile(
    new URL("../lib/email-residue-census.ts", import.meta.url),
  );
  for (const forbidden of [".delete(", ".update(", "purgeEmailKeyedPii("]) {
    assert(
      !src.includes(forbidden),
      `email-residue-census.ts contains "${forbidden}". It counts; it does not act.`,
    );
  }
});

Deno.test("the operator scripts keep their guardrails", async () => {
  const census = await Deno.readTextFile(
    new URL("../../scripts/email-residue-census.ts", import.meta.url),
  );
  // No --apply, because there is no population an --apply could safely act on.
  assert(!census.includes('"--apply"'), "the census script must stay read-only");

  const purge = await Deno.readTextFile(
    new URL("../../scripts/purge-email-subject.ts", import.meta.url),
  );
  // Same plan, not a hand-written one (AC2).
  assert(purge.includes("purgeEmailKeyedPii("), "the purge must call the shared plan");
  // Refuses a live account: running the plan on one is a half-erasure of a
  // current customer, and it is the easiest mistake to make from a ticket.
  assert(purge.includes("REFUSED"), "the purge must refuse a live account");
  assert(purge.includes("--apply"), "the purge must be dry-run by default");
});
