// US-2417 AC4: encrypt the MeasureCard street addresses written before the
// encryption landed.
//
// WHY THIS IS A SCRIPT AND NOT A MIGRATION. AES-256-GCM with a key held in
// EDGE_ENCRYPTION_KEY cannot be produced from SQL. pgcrypto's encrypt() offers
// AES in CBC/ECB only — no GCM, therefore no auth tag, therefore no AAD, and
// the AAD is the whole tenant-binding property (US-2417 AC7). A migration that
// used pgcrypto would produce ciphertext that the edge cannot read and that
// carries none of the security this story is about. So the backfill runs where
// the key already lives.
//
// SAFE TO RE-RUN. encryptMeasureCardAddress passes an already-encrypted value
// through untouched, so a second pass is a no-op rather than a double-wrap —
// which would be unrecoverable, since the inner envelope's AAD is invisible
// from the outside. That means an interrupted run is resumed by running it
// again, with no bookkeeping.
//
// DRY RUN BY DEFAULT. Pass --apply to write. A backfill whose blast radius was
// never measured is how a cleanup becomes an incident.
//
//   deno run --allow-net --allow-env scripts/backfill-measure-card-pii.ts
//   deno run --allow-net --allow-env scripts/backfill-measure-card-pii.ts --apply

import { createClient } from "@supabase/supabase-js";
import {
  encryptMeasureCardAddress,
  isEncrypted,
  type MeasureCardAddress,
  MEASURE_CARD_PII_COLUMNS,
} from "../src/lib/measure-card-pii.ts";

const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  Deno.exit(1);
}
if (!Deno.env.get("EDGE_ENCRYPTION_KEY")) {
  // Without this the script would encrypt under a key the edge does not hold,
  // and every backfilled address would become unreadable to the fulfilment
  // queue — silently, because the rows would still look encrypted.
  console.error("EDGE_ENCRYPTION_KEY is required, and must be the SAME key the edge runs with.");
  Deno.exit(1);
}

const apply = Deno.args.includes("--apply");
const db = createClient(url, key, { auth: { persistSession: false } });

const { data, error } = await db
  .from("measure_card_requests")
  .select("id, owner_user_id, ship_name, address_line1, address_line2, city, postal_code");
if (error) {
  console.error("read failed:", error.message);
  Deno.exit(1);
}

type Row = MeasureCardAddress & { id: string; owner_user_id: string };
const rows = (data ?? []) as Row[];

const stale = rows.filter((r) =>
  MEASURE_CARD_PII_COLUMNS.some((c) => {
    const v = r[c];
    return typeof v === "string" && v !== "" && !isEncrypted(v);
  })
);

console.log(`measure_card_requests: ${rows.length} rows, ${stale.length} with plaintext columns`);
if (!apply) {
  console.log("dry run — pass --apply to write. Row ids that would change:");
  for (const r of stale) console.log(`  ${r.id}`);
  Deno.exit(0);
}

let ok = 0;
let failed = 0;
for (const row of stale) {
  try {
    const patch = await encryptMeasureCardAddress(row.owner_user_id, row);
    const { error: upErr } = await db
      .from("measure_card_requests")
      .update(patch as never)
      .eq("id", row.id)
      // Belt and braces: the id is already unique, but scoping by owner too
      // means a mis-derived id cannot write one seller's ciphertext — bound to
      // THEIR user id — onto another seller's row, where it would then be
      // permanently undecryptable.
      .eq("owner_user_id", row.owner_user_id);
    if (upErr) throw new Error(upErr.message);
    ok++;
    console.log(`  encrypted ${row.id}`);
  } catch (err) {
    failed++;
    console.error(`  FAILED ${row.id}:`, err instanceof Error ? err.message : err);
  }
}

console.log(`done: ${ok} encrypted, ${failed} failed`);
Deno.exit(failed === 0 ? 0 : 1);
