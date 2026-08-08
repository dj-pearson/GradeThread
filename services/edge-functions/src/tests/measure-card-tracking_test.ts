// US-2231 AC3 (tracking half): a mailed MeasureCard can carry a tracking
// number, and the two ways that goes wrong are refused rather than trusted.
//
// The bulk transition takes up to 500 ids. Tracking is per-PARCEL. So the one
// mistake that matters is sending a number alongside a batch: the update would
// stamp ONE carrier reference onto every seller in it, and each of them would
// then see a link that tracks somebody else's parcel. That is worse than no
// tracking at all, because it looks authoritative.
//
// Read as text rather than driven through a request: the route needs an admin
// context, a scope and a seeded database, and the property here is about what
// the handler REFUSES before it reaches any of that.

import { assert } from "@std/assert";

const ADMIN = new URL("../routes/admin-measure-cards.ts", import.meta.url);
const SELLER = new URL("../routes/flipdesk-measure.ts", import.meta.url);
const MIGRATION = new URL(
  "../../../../supabase/migrations/00561_measure_card_tracking.sql",
  import.meta.url,
);

/** Comments stripped — a guard satisfied by its own prose proves nothing. */
async function code(url: URL): Promise<string> {
  return (await Deno.readTextFile(url))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

Deno.test("US-2231: one tracking number cannot be stamped on a batch", async () => {
  const src = await code(ADMIN);
  assert(
    /if \(tracking && ids\.length !== 1\)/.test(src),
    "a tracking number sent with more than one id must be REFUSED — otherwise " +
      "every seller in the batch gets a link to one other person's parcel",
  );
  assert(
    /if \(tracking && status !== "shipped"\)/.test(src),
    "tracking is only meaningful on the shipped transition; accepting it on " +
      "'exported' would record a parcel that has not been sent",
  );
});

Deno.test("US-2231: an absent tracking number stays absent", async () => {
  // Most cards go out as untracked letters. Writing "" would make the seller's
  // page render an empty tracking link, which reads as a broken feature rather
  // than as "there is no tracking for this one".
  const src = await code(ADMIN);
  assert(
    /if \(tracking\) \{\s*patch\.tracking_number = tracking;/.test(src),
    "the tracking column must only be written when there is a value",
  );
  assert(
    !/patch\.tracking_number = tracking \|\| ""/.test(src),
    "an empty-string fallback would defeat the point",
  );
});

Deno.test("US-2231: the seller reads their own tracking, and no address", async () => {
  const src = await code(SELLER);
  assert(
    src.includes("tracking_number: row.tracking_number"),
    "the seller's card-request summary must expose the tracking number",
  );
  // The address echo has always been deliberately absent from this summary
  // (US-1579), and US-2417 has since encrypted those columns — so echoing one
  // here would return ciphertext AND undo a privacy decision at the same time.
  for (const col of ["ship_name", "address_line1", "postal_code"]) {
    assert(
      !src.includes(`${col}: row.${col}`),
      `the seller summary must NOT echo ${col} — it is deliberately omitted, ` +
        "and since US-2417 it is stored encrypted anyway",
    );
  }
});

Deno.test("US-2231: the columns are nullable and the migration self-records", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assert(/ADD COLUMN IF NOT EXISTS tracking_number text/.test(sql), "idempotent add");
  assert(/ADD COLUMN IF NOT EXISTS tracking_carrier text/.test(sql), "idempotent add");
  // NOT NULL would force the operator to invent a placeholder for every
  // untracked letter, and a placeholder tracking number is worse than none
  // because the seller clicks it.
  assert(!/tracking_number text NOT NULL/i.test(sql), "tracking must stay nullable");
  assert(
    sql.includes("insert into public.applied_migrations (version) values ('00561')"),
    "US-1108 self-record footer",
  );
});
