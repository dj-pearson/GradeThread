// US-2417 AC4: encrypt the users.business_phone / users.ship_from_address rows
// written before the encryption landed.
//
// Same shape and same reasoning as backfill-measure-card-pii.ts, which the
// header there sets out in full: AES-256-GCM with an edge-held key cannot come
// from SQL (pgcrypto has no GCM, therefore no auth tag, therefore no AAD, and
// the AAD is the entire tenant-binding property), so the backfill runs where the
// key lives. Safe to re-run — an already-encrypted value passes through untouched
// rather than being double-wrapped, which would be unrecoverable. Dry run by
// default; pass --apply to write.
//
// ONE DIFFERENCE WORTH KNOWING. The measure-card table's columns are all text,
// so "plaintext" there is "a string without the v1:/v2: prefix". Here
// ship_from_address is jsonb, and the discriminator is the JSON TYPE: an OBJECT
// is a row this script has not reached, a STRING is an envelope. business_phone
// is text and uses the prefix test.
//
//   deno run --allow-net --allow-env scripts/backfill-user-shipping-pii.ts
//   deno run --allow-net --allow-env scripts/backfill-user-shipping-pii.ts --apply

import { createClient } from "@supabase/supabase-js";
import {
  encryptBusinessPhone,
  encryptShipFrom,
  isEncrypted,
} from "../src/lib/user-shipping-pii.ts";

const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  Deno.exit(1);
}
if (!Deno.env.get("EDGE_ENCRYPTION_KEY")) {
  // Without this the script encrypts under a key the edge does not hold, and
  // every backfilled profile becomes unreadable — silently, because the rows
  // still LOOK encrypted.
  console.error("EDGE_ENCRYPTION_KEY is required, and must be the SAME key the edge runs with.");
  Deno.exit(1);
}

const apply = Deno.args.includes("--apply");
const db = createClient(url, key, { auth: { persistSession: false } });

const { data, error } = await db
  .from("users")
  .select("id, business_phone, ship_from_address");
if (error) {
  console.error("read failed:", error.message);
  Deno.exit(1);
}

interface Row {
  id: string;
  business_phone: string | null;
  ship_from_address: unknown;
}
const rows = (data ?? []) as unknown as Row[];

function phoneIsPlaintext(r: Row): boolean {
  return typeof r.business_phone === "string" && r.business_phone !== "" &&
    !isEncrypted(r.business_phone);
}
function addressIsPlaintext(r: Row): boolean {
  // An object, not a string — see the header.
  return Boolean(r.ship_from_address) && typeof r.ship_from_address === "object";
}

const stale = rows.filter((r) => phoneIsPlaintext(r) || addressIsPlaintext(r));

console.log(`users: ${rows.length} rows, ${stale.length} with plaintext shipping PII`);
if (!apply) {
  console.log("dry run — pass --apply to write. Row ids that would change:");
  for (const r of stale) {
    const what = [phoneIsPlaintext(r) && "phone", addressIsPlaintext(r) && "address"]
      .filter(Boolean).join("+");
    console.log(`  ${r.id} (${what})`);
  }
  Deno.exit(0);
}

let ok = 0;
let failed = 0;
for (const row of stale) {
  try {
    // Only the stale halves are written. Re-encrypting an already-encrypted
    // column would be a no-op anyway, but not touching it keeps the UPDATE
    // narrow and the log honest about what actually changed.
    const patch: Record<string, unknown> = {};
    if (phoneIsPlaintext(row)) {
      patch.business_phone = await encryptBusinessPhone(row.id, row.business_phone);
    }
    if (addressIsPlaintext(row)) {
      patch.ship_from_address = await encryptShipFrom(row.id, row.ship_from_address);
    }
    const { error: upErr } = await db
      .from("users")
      .update(patch as never)
      // The row's own id IS the AAD here, so unlike the measure-card script
      // there is no second column to scope by — writing to the wrong id would
      // mean encrypting under that id too, and the mismatch is structural.
      .eq("id", row.id);
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
