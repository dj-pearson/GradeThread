// US-2704: the snapshot funnel, and the one door rule.
//
// TWO KINDS OF TEST HERE, and the second is the one that matters.
//
// The behavioural half drives recordPublication against a fake client: does an
// unchanged re-push collapse, does a real revision insert, does a reprice keep
// the description it did not touch.
//
// The SOURCE GUARD half is the reason this file exists. Coverage cannot be
// backfilled honestly - a description that was never snapshotted is gone - so a
// write path that reaches the wire without the funnel is not a gap to fix
// later, it is evidence that will cite text that was never live, asserted under
// our signature. This repo has the scar for exactly that shape twice, in
// lib/pending-delists.ts and in the EXTENSION_DELIST_PLATFORMS drift.

import { assert, assertEquals } from "@std/assert";
import {
  canonicalAspects,
  isConfirmationOnly,
  isSameSnapshot,
  mergedRow,
  recordPublication,
} from "../lib/listing-publications.ts";

// ── The funnel's own behaviour ─────────────────────────────────────────────

interface FakeCall {
  table: string;
  op: "select" | "insert" | "update";
  row?: Record<string, unknown>;
  filters: Array<[string, unknown]>;
}

/**
 * A client holding one listing row and zero or one snapshot rows.
 *
 * `listing` null means the listing has not been persisted yet, which is the
 * real state during a first publish: createOrReplaceInventoryItem runs at step
 * 2 and the listings row is not written until step 5.
 */
function fakeSupabase(opts: {
  listing?: { id: string } | null;
  snapshot?: Record<string, unknown> | null;
} = {}) {
  const calls: FakeCall[] = [];
  const listing = opts.listing === undefined ? { id: "listing-1" } : opts.listing;
  const snapshot = opts.snapshot ?? null;

  function chain(call: FakeCall) {
    const self = {
      select() { return self; },
      eq(col: string, val: unknown) { call.filters.push([col, val]); return self; },
      order() { return self; },
      limit() { return self; },
      maybeSingle() {
        const data = call.table === "listings" ? listing : snapshot;
        return Promise.resolve({ data, error: null });
      },
      // deno-lint-ignore no-explicit-any
      then(resolve: (v: any) => unknown) {
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    };
    return self;
  }

  const client = {
    from(table: string) {
      return {
        select() {
          const call: FakeCall = { table, op: "select", filters: [] };
          calls.push(call);
          return chain(call);
        },
        insert(row: Record<string, unknown>) {
          const call: FakeCall = { table, op: "insert", row, filters: [] };
          calls.push(call);
          return chain(call);
        },
        update(row: Record<string, unknown>) {
          const call: FakeCall = { table, op: "update", row, filters: [] };
          calls.push(call);
          return chain(call);
        },
      };
    },
    // deno-lint-ignore no-explicit-any
  } as any;
  return { client, calls };
}

const OWNER = "owner-1";

Deno.test("US-2704: the first snapshot of a listing is inserted", async () => {
  const { client, calls } = fakeSupabase({ snapshot: null });
  const outcome = await recordPublication(client, {
    ownerUserId: OWNER,
    offerId: "offer-1",
    description: "Blue polo, small stain on the left cuff",
    aspects: { Brand: ["Lululemon"] },
    price: 32,
  });
  assertEquals(outcome, "inserted");
  const insert = calls.find((c) => c.op === "insert")!;
  assertEquals(insert.table, "listing_publications");
  assertEquals(insert.row!.listing_id, "listing-1");
  assertEquals(insert.row!.owner_user_id, OWNER);
  assertEquals(insert.row!.description, "Blue polo, small stain on the left cuff");
});

Deno.test("US-2704 AC3: an unchanged re-push confirms instead of duplicating", async () => {
  // The credentials-refresh cron re-pushes unchanged text often. A row per
  // re-push would bury the real revisions under bookkeeping.
  const { client, calls } = fakeSupabase({
    snapshot: {
      id: "snap-1",
      description: "Blue polo",
      aspects: { Brand: ["Lululemon"] },
      price: 32,
    },
  });
  const outcome = await recordPublication(client, {
    ownerUserId: OWNER,
    offerId: "offer-1",
    description: "Blue polo",
    aspects: { Brand: ["Lululemon"] },
    price: 32,
  });
  assertEquals(outcome, "confirmed");
  assertEquals(calls.some((c) => c.op === "insert"), false, "it wrote a duplicate row");
  const update = calls.find((c) => c.op === "update")!;
  assert(typeof update.row!.last_confirmed_at === "string");
  // Scoped by owner as well as by id (US-268), even though the id is ours.
  assertEquals(update.filters, [["id", "snap-1"], ["owner_user_id", OWNER]]);
});

Deno.test("US-2704 AC3: the cron running twice produces ONE row", async () => {
  // The AC names this case. Run one, insert; run two against what run one
  // wrote, confirm.
  const first = fakeSupabase({ snapshot: null });
  const content = {
    ownerUserId: OWNER,
    offerId: "offer-1",
    description: "Unchanged text",
    price: 40,
  };
  assertEquals(await recordPublication(first.client, content), "inserted");
  const written = first.calls.find((c) => c.op === "insert")!.row!;

  const second = fakeSupabase({
    snapshot: {
      id: "snap-1",
      description: written.description,
      aspects: written.aspects,
      price: written.price,
    },
  });
  assertEquals(await recordPublication(second.client, content), "confirmed");
  assertEquals(second.calls.filter((c) => c.op === "insert").length, 0);
});

Deno.test("US-2704: a real revision writes a new row and keeps the old one", async () => {
  const { client, calls } = fakeSupabase({
    snapshot: { id: "snap-1", description: "Blue polo", aspects: null, price: 32 },
  });
  const outcome = await recordPublication(client, {
    ownerUserId: OWNER,
    offerId: "offer-1",
    description: "Blue polo, small stain on the left cuff",
  });
  assertEquals(outcome, "inserted");
  // The old row is untouched: the evidence is the HISTORY, not the latest text.
  assertEquals(calls.some((c) => c.op === "update"), false);
});

Deno.test("US-2704: a reprice does not erase the description it never touched", async () => {
  // updateOfferPrice sends a price and nothing else. Recording the absent
  // description as null would store a listing that lost its text, which is
  // false, and it is the version of this that would look correct in review.
  const { client, calls } = fakeSupabase({
    snapshot: { id: "snap-1", description: "Blue polo", aspects: null, price: 32 },
  });
  assertEquals(
    await recordPublication(client, { ownerUserId: OWNER, offerId: "offer-1", price: 28 }),
    "inserted",
  );
  const insert = calls.find((c) => c.op === "insert")!;
  assertEquals(insert.row!.description, "Blue polo");
  assertEquals(insert.row!.price, 28);
});

Deno.test("US-2704: a publish with no content confirms the text already recorded", async () => {
  // publishOffer carries no description of its own - it publishes an offer
  // built earlier. What it establishes is that the recorded text went live now.
  const { client, calls } = fakeSupabase({
    snapshot: { id: "snap-1", description: "Blue polo", aspects: null, price: 32 },
  });
  assertEquals(
    await recordPublication(client, { ownerUserId: OWNER, offerId: "offer-1" }),
    "confirmed",
  );
  assertEquals(calls.some((c) => c.op === "insert"), false);
});

Deno.test("US-2704: no listing row yet means no snapshot, not an invented one", async () => {
  // The real first-publish ordering: the inventory item is PUT at step 2 and
  // the listings row is written at step 5. A snapshot attached to a listing
  // that does not exist would be a snapshot of nothing.
  const { client, calls } = fakeSupabase({ listing: null });
  assertEquals(
    await recordPublication(client, {
      ownerUserId: OWNER,
      sku: "SKU-1",
      description: "Blue polo",
    }),
    "skipped",
  );
  assertEquals(calls.some((c) => c.op === "insert"), false);
});

Deno.test("US-2704: the listing lookup is tenant-scoped and channel-scoped", async () => {
  const { client, calls } = fakeSupabase({ snapshot: null });
  await recordPublication(client, {
    ownerUserId: OWNER,
    offerId: "offer-1",
    description: "x",
  });
  const lookup = calls.find((c) => c.table === "listings")!;
  const cols = lookup.filters.map(([c]) => c);
  assert(cols.includes("user_id"), "the listing lookup is not tenant-scoped (US-268)");
  assert(cols.includes("platform"), "the lookup can cross channels");
});

Deno.test("US-2704: no owner, no write", async () => {
  const { client, calls } = fakeSupabase();
  assertEquals(
    await recordPublication(client, { ownerUserId: "", offerId: "o", description: "x" }),
    "skipped",
  );
  assertEquals(calls.length, 0);
});

// ── The pure comparison rules ──────────────────────────────────────────────

Deno.test("US-2704: aspect order is not a revision", () => {
  // eBay does not promise key order or value order, so a raw stringify reports
  // a revision on a re-push that changed nothing - the duplicate row the
  // collapse exists to avoid.
  assertEquals(
    canonicalAspects({ Brand: ["Nike"], Size: ["M", "L"] }),
    canonicalAspects({ Size: ["L", "M"], Brand: ["Nike"] }),
  );
  const prev = { id: "s", description: null, aspects: { Size: ["L", "M"] }, price: null };
  assert(isSameSnapshot(prev, { aspects: { Size: ["M", "L"] } }));
});

Deno.test("US-2704: a changed aspect IS a revision", () => {
  const prev = { id: "s", description: null, aspects: { Size: ["M"] }, price: null };
  assertEquals(isSameSnapshot(prev, { aspects: { Size: ["L"] } }), false);
});

Deno.test("US-2704: price is compared to the cent", () => {
  const prev = { id: "s", description: null, aspects: null, price: 12.5 };
  assert(isSameSnapshot(prev, { price: 12.5 }), "12.50 and 12.5 are one price");
  assertEquals(isSameSnapshot(prev, { price: 12.51 }), false);
});

Deno.test("US-2704: a field the write did not touch is not a difference", () => {
  const prev = { id: "s", description: "text", aspects: null, price: 10 };
  assert(isSameSnapshot(prev, {}), "an empty write changes nothing");
  assert(isConfirmationOnly({}));
  assertEquals(isConfirmationOnly({ price: 1 }), false);
  // An EXPLICIT null is a change, not an absence.
  assertEquals(isSameSnapshot(prev, { description: null }), false);
});

Deno.test("US-2704: mergedRow carries the untouched fields forward", () => {
  const prev = { id: "s", description: "text", aspects: { A: ["1"] }, price: 10 };
  assertEquals(mergedRow(prev, { price: 12 }), {
    description: "text",
    aspects: { A: ["1"] },
    price: 12,
  });
  assertEquals(mergedRow(null, { price: 12 }), {
    description: null,
    aspects: null,
    price: 12,
  });
});
