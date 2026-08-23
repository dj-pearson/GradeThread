// US-2697: what a sold-sync batch may never carry, and what the tables may
// never have a column for.
//
// Both halves matter and they fail differently. The guard stops PII arriving;
// the column allowlist stops a future migration adding somewhere to put it.

import { assert, assertEquals } from "@std/assert";
import {
  BUYER_IDENTITY_KEYS,
  findForbiddenKey,
  SYNC_FORBIDDEN_KEYS,
} from "../lib/sync-payload-guard.ts";
import { CREDENTIAL_KEYS } from "../lib/extension-queue.ts";

// ── the list cannot be shortened ───────────────────────────────────────────

Deno.test("every credential key is still a sync forbidden key", () => {
  // Derived, not copied. If extension-queue.ts grows a key, this inherits it;
  // if someone deletes one there, this fails here too.
  for (const key of CREDENTIAL_KEYS) {
    assert(SYNC_FORBIDDEN_KEYS.includes(key), `credential key dropped: ${key}`);
  }
});

Deno.test("the buyer identity keys are pinned", () => {
  // A Poshmark order page prints all of these. Shortening this list is the
  // change that must break a build rather than pass review.
  for (
    const key of [
      "buyer",
      "buyername",
      "buyerhandle",
      "buyerusername",
      "recipient",
      "address",
      "shippingaddress",
      "street",
      "postcode",
      "zip",
      "phone",
      "email",
    ]
  ) {
    assert(
      (BUYER_IDENTITY_KEYS as readonly string[]).includes(key),
      `buyer identity key dropped: ${key}`,
    );
  }
});

// ── matching ───────────────────────────────────────────────────────────────

Deno.test("a clean observation batch passes", () => {
  assertEquals(
    findForbiddenKey({
      platform: "poshmark",
      observedAt: "2026-08-18T12:00:00.000Z",
      signedIn: true,
      sold: [{
        listingUrl: "https://poshmark.com/listing/aaa",
        title: "Carhartt Detroit Jacket",
        soldPriceCents: 8500,
        soldAt: "2026-08-18T11:00:00.000Z",
        orderRef: "PM-1",
        thumbAssetId: null,
      }],
      closet: { listingUrls: ["https://poshmark.com/listing/bbb"], pagesRead: 2, reachedEnd: true },
    }),
    null,
  );
});

Deno.test("separator and case spellings are one refusal", () => {
  assertEquals(findForbiddenKey({ buyer_name: "x" }), "buyer_name");
  assertEquals(findForbiddenKey({ buyerName: "x" }), "buyerName");
  assertEquals(findForbiddenKey({ "BUYER-NAME": "x" }), "BUYER-NAME");
  assertEquals(findForbiddenKey({ sessionCookie: "x" }), "sessionCookie");
});

Deno.test("a forbidden key nested in an object is found", () => {
  assertEquals(
    findForbiddenKey({ sold: [{ order: { recipient: "Jane" } }] }),
    "recipient",
  );
});

Deno.test("a forbidden key nested inside an array of arrays is found", () => {
  assertEquals(findForbiddenKey({ rows: [[{ shipping_address: "1 Main St" }]] }), "shipping_address");
});

Deno.test("a shipping address three levels down is still refused", () => {
  assertEquals(
    findForbiddenKey({ a: { b: { c: { address: "1 Main St" } } } }),
    "address",
  );
});

Deno.test("the walk terminates rather than recursing forever on depth", () => {
  let deep: Record<string, unknown> = { address: "buried" };
  for (let i = 0; i < 40; i++) deep = { nest: deep };
  // Past the depth bound it stops looking, which is a bound and not a hole:
  // the batch shape is three levels deep and anything at forty is not one.
  assertEquals(findForbiddenKey(deep), null);
});

Deno.test("legitimate batch keys are not caught by suffix matching", () => {
  // The suffix rule is what makes buyer_name and buyerName one refusal. It is
  // also the rule most likely to eat a real key by accident, so every field the
  // parser actually reads is asserted clean here.
  for (
    const key of [
      "platform",
      "observedAt",
      "signedIn",
      "sold",
      "closet",
      "listingUrl",
      "title",
      "soldPriceCents",
      "soldAt",
      "orderRef",
      "thumbAssetId",
      "listingUrls",
      "pagesRead",
      "reachedEnd",
    ]
  ) {
    assertEquals(findForbiddenKey({ [key]: "x" }), null, `false positive on ${key}`);
  }
});

// ── the column allowlist ───────────────────────────────────────────────────
//
// The storage-side guarantee. These tables hold typed columns and no jsonb
// payload, so there is nothing for a CHECK constraint to inspect — and pinning
// the column SET is the stronger promise anyway: it stops a PII column existing
// at all rather than rejecting PII inside one.

const MIGRATION = new URL(
  "../../../../supabase/migrations/00632_marketplace_sync.sql",
  import.meta.url,
);

const MIGRATIONS_DIR = new URL(
  "../../../../supabase/migrations/",
  import.meta.url,
);

/**
 * Columns a LATER migration adds to `table`, anywhere in the corpus.
 *
 * ⚠ WITHOUT THIS THE STORAGE HALF OF THIS FILE GUARDED NOTHING, and the header
 * above claims otherwise: "it stops a PII column existing at all". It read one
 * file and parsed only its CREATE TABLE, so a one-line
 * `ALTER TABLE public.marketplace_sync_observations ADD COLUMN buyer_name text`
 * in any later migration was invisible. Found by sabotage 2026-08-23 — three
 * probes (buyer_name, shipping_address, and a generic raw_payload jsonb) all
 * left this suite green.
 *
 * That is the exact change this guard exists to stop. A Poshmark order page
 * prints the buyer's name and their shipping address; the whole argument for
 * reading those pages is that there is nowhere in the schema to put either.
 */
function addedColumnsOf(table: string): string[] {
  const out: string[] = [];
  for (const entry of Deno.readDirSync(MIGRATIONS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    const sql = Deno.readTextFileSync(new URL(entry.name, MIGRATIONS_DIR))
      .replace(/--[^\n]*/g, "");
    // One ALTER may add several columns, comma-separated, so each statement is
    // taken whole and then split rather than matched a column at a time.
    const stmt = new RegExp(
      `ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(?:public\\.)?${table}\\b([^;]*);`,
      "gis",
    );
    for (const m of sql.matchAll(stmt)) {
      const add = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
      for (const c of (m[1] ?? "").matchAll(add)) out.push(c[1]!.toLowerCase());
    }
  }
  return out;
}

/** Everything the table holds today: created plus added. */
function allColumnsOf(sql: string, table: string): string[] {
  return [...new Set([...columnsOf(sql, table), ...addedColumnsOf(table)])];
}

function columnsOf(rawSql: string, table: string): string[] {
  // Strip line comments FIRST. A comment containing a comma or a paren -- and
  // one of them contains both -- otherwise splits a column off mid-sentence and
  // the allowlist starts asserting the word "else" is a column.
  const sql = rawSql.replace(/--[^\n]*/g, "");

  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS public.${table} (`);
  if (start === -1) throw new Error(`table not found in migration: ${table}`);
  const open = sql.indexOf("(", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = sql.slice(open + 1, end);
  const cols: string[] = [];
  let depth2 = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth2++;
    if (ch === ")") depth2--;
    if (ch === "," && depth2 === 0) {
      cols.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  cols.push(current);
  return cols
    .map((line) => line.replace(/--[^\n]*/g, "").trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(/\s+/)[0] ?? "")
    .filter((name) => name.length > 0 && !/^(CONSTRAINT|CHECK|UNIQUE|PRIMARY|FOREIGN)$/i.test(name));
}

Deno.test("the sync tables have exactly the columns they are allowed", async () => {
  const sql = await Deno.readTextFile(MIGRATION);

  assertEquals(allColumnsOf(sql, "marketplace_sync_observations").sort(), [
    "created_at",
    "dedupe_key",
    "id",
    "listing_id",
    "observed_at",
    "platform",
    "sold_at",
    "user_id",
  ]);

  assertEquals(allColumnsOf(sql, "marketplace_sync_reviews").sort(), [
    "cap",
    "claimed",
    "created_at",
    "dedupe_key",
    "id",
    "inventory_item_id",
    "listing_id",
    "listing_url",
    "platform",
    "reason",
    "sold_at",
    "sold_price_cents",
    "status",
    "title",
    "unexplained",
    "updated_at",
    "user_id",
  ]);

  assertEquals(allColumnsOf(sql, "marketplace_sync_state").sort(), [
    "failure_reason",
    "id",
    "last_ok_at",
    "last_read_at",
    "listings_seen",
    "platform",
    "status",
    "updated_at",
    "user_id",
  ]);
});

Deno.test("no sync table has a column whose name is a forbidden key", () => {
  // Belt and braces against the allowlist above being updated carelessly: even
  // if someone adds a column AND updates the expected list, a buyer-identity
  // name still fails.
  const tables = [
    "marketplace_sync_observations",
    "marketplace_sync_reviews",
    "marketplace_sync_state",
  ];
  const sql = Deno.readTextFileSync(new URL(MIGRATION));
  for (const table of tables) {
    for (const col of allColumnsOf(sql, table)) {
      assertEquals(
        findForbiddenKey({ [col]: 1 }),
        null,
        `${table}.${col} is a forbidden key name`,
      );
    }
  }
});
