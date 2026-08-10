// US-2433 AC1: the intake, and the caller the procedure never had.
//
// src/lib/third-party-pii-purge.ts has been the PROCEDURE since 2026-08-08 with
// nothing calling it. This is the caller.
//
// ── AC1: OPERATOR-RUN, NOT SELF-SERVE ───────────────────────────────────────
// The story left the intake open and recommended an operator runbook. Taking
// that route, for the reason the module already gives: a route that erases rows
// on an unverified email claim is a deletion oracle — anyone could POST a
// stranger's address and destroy the audit record of a payout decision made
// against them. Building the verification is a bigger job than the erasure, and
// the volume here is small.
//
// Choosing operator-run does NOT foreclose self-serve. The module is what a
// verified flow would call once verification passes; this script and that flow
// end in exactly the same writes. Same call US-2434's purge-email-subject.ts
// made, so the two live side by side and read the same way.
//
// ── WHY --find EXISTS, AND WHY IT WILL NOT ACT ──────────────────────────────
// A consignor is matched by ROW ID, not by address, because contact_email is
// nullable and a consignor recorded by name alone has no address to key on. But
// a request arrives as a name or an address, never as a uuid. So there are two
// steps on purpose:
//
//   --find    read-only. Shows which rows a name or address could mean.
//   --consignor <id>[,<id>]   acts, on ids the operator chose.
//
// The tempting shortcut is to purge every consignor whose name matches. Names
// are unique only PER SELLER (UNIQUE(user_id, name), 00107), so one name can be
// several different people across several sellers, and erasing all of them to
// serve one of them is exactly the over-reach AC5 exists to prevent. The
// selection is a human judgement and this script refuses to make it.
//
// A claim buyer IS matched by address, and needs no selection step: the address
// identifies the person, and every claim they filed is theirs.
//
//   deno run --allow-net --allow-env scripts/purge-third-party-subject.ts --find "a@b.test"
//   deno run --allow-net --allow-env scripts/purge-third-party-subject.ts --claim-buyer a@b.test
//   deno run --allow-net --allow-env scripts/purge-third-party-subject.ts --claim-buyer a@b.test --apply
//   deno run --allow-net --allow-env scripts/purge-third-party-subject.ts --consignor <uuid>,<uuid> --apply

import { createClient } from "@supabase/supabase-js";
import {
  canonicalMatchValue,
  matchesAddress,
  purgeThirdPartySubject,
  RESIDUAL_FREE_TEXT,
  THIRD_PARTY_PURGE_PLAN,
  type ThirdPartyPurgeIO,
} from "../src/lib/third-party-pii-purge.ts";

const argv = Deno.args;
const apply = argv.includes("--apply");

function flagValue(name: string): string | null {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const next = argv[i + 1];
  return next && !next.startsWith("--") ? next : null;
}

const findTerm = flagValue("--find");
const claimBuyer = flagValue("--claim-buyer");
const consignorIds = (flagValue("--consignor") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!findTerm && !claimBuyer && consignorIds.length === 0) {
  console.error(
    "usage:\n" +
      "  purge-third-party-subject.ts --find <name-or-email>\n" +
      "  purge-third-party-subject.ts --claim-buyer <email> [--apply]\n" +
      "  purge-third-party-subject.ts --consignor <uuid>[,<uuid>] [--apply]",
  );
  Deno.exit(1);
}

const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  Deno.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

const PAGE = 1000;

/**
 * Read one column pair out of a table, paged.
 *
 * Deliberately NOT a server-side filter. `ILIKE` is the obvious way to match an
 * address case-insensitively and it is wrong here: PostgREST hands the pattern
 * to SQL ILIKE, where `_` matches any single character and `%` matches any run,
 * and both are legal in an email local part. `a_b@x.test` would match
 * `aXb@x.test` — a different person, whose payout audit record we would then
 * anonymize. Escaping that correctly through a URL query is a thing to get
 * wrong once and never notice, so the comparison happens in TypeScript where it
 * is exact and testable. These tables are small (claims are rare, consignors
 * are per-seller), which is what makes a scan affordable.
 */
async function readRows<T extends Record<string, unknown>>(
  table: string,
  columns: string,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from(table)
      .select(columns)
      .range(from, from + PAGE - 1);
    if (error) {
      console.error(`FATAL: ${table} unreadable: ${error.message}`);
      // Fatal rather than reported-and-continued: an empty read here means
      // "found nothing", and "found nothing" is what this script prints right
      // before an operator closes an erasure request.
      Deno.exit(1);
    }
    const rows = (data ?? []) as unknown as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

// Address equality is imported, never written here. See matchesAddress.

// ── --find ──────────────────────────────────────────────────────────────────
if (findTerm) {
  const canonical = canonicalMatchValue("claim_buyer", findTerm);
  const needle = findTerm.trim().toLowerCase();

  const claims = await readRows<{ id: string; claimant_email: string | null; claimant_name: string | null; created_at: string }>(
    "guarantee_claims",
    "id, claimant_email, claimant_name, created_at",
  );
  const claimHits = claims.filter((r) => matchesAddress(r.claimant_email, canonical));
  console.log(`guarantee_claims matching that address exactly: ${claimHits.length}`);
  for (const r of claimHits) console.log(`  ${r.id}  filed ${r.created_at}`);
  if (claimHits.length > 0) {
    console.log(`  -> purge with: --claim-buyer ${canonical} --apply`);
  }

  const consignors = await readRows<{ id: string; user_id: string; name: string; contact_email: string | null }>(
    "consignors",
    "id, user_id, name, contact_email",
  );
  // Name is matched as a substring because a consignor is whatever the seller
  // typed — "J. Smith", "Jane Smith (eBay)". An address is matched exactly.
  const consignorHits = consignors.filter((r) =>
    matchesAddress(r.contact_email, canonical) || r.name.toLowerCase().includes(needle)
  );
  console.log(`\nconsignors possibly matching: ${consignorHits.length}`);
  for (const r of consignorHits) {
    // seller shown because ONE name can be several people across sellers, and
    // that is the distinction the operator has to make.
    console.log(
      `  ${r.id}  seller ${r.user_id}  ${JSON.stringify(r.name)}` +
        (matchesAddress(r.contact_email, canonical) ? "  [email matches]" : "  [name only]"),
    );
  }
  if (consignorHits.length > 0) {
    console.log(
      "\n  These are CANDIDATES, not a selection. Consignor names are unique only\n" +
        "  per seller, so one name can be several different people. Confirm which\n" +
        "  rows are the subject's, then pass those ids explicitly:\n" +
        "    --consignor <id>[,<id>] --apply",
    );
  }
  console.log("\nread-only — --find never writes.");
  Deno.exit(0);
}

// ── act ─────────────────────────────────────────────────────────────────────
const kind = claimBuyer ? "claim_buyer" as const : "consignor" as const;
const plan = THIRD_PARTY_PURGE_PLAN.filter((t) => t.kind === kind);
for (const t of plan) {
  console.log(`table:    ${t.table}`);
  console.log(`writes:   ${[...t.nulls, ...Object.keys(t.redact), ...Object.keys(t.redactUnique)].join(", ")}`);
  console.log(`keeps:    ${t.reason}`);
}
// Printed on every run, not buried in the module: the operator is the one who
// answers the subject, and "we erased everything" is false if free text they
// wrote about themselves is still there.
console.log(`untouched: ${RESIDUAL_FREE_TEXT.join(", ")} (free text — see RESIDUAL_FREE_TEXT)`);
console.log("");

const targets: string[] = claimBuyer ? [claimBuyer] : consignorIds;

for (const target of targets) {
  const canonical = canonicalMatchValue(kind, target);

  const io: ThirdPartyPurgeIO = {
    findRows: async (table, column, value) => {
      if (column === "id") {
        const { data, error } = await db.from(table).select("id").eq("id", value);
        return {
          rows: ((data ?? []) as Array<{ id: string }>),
          error: error ? { message: error.message } : null,
        };
      }
      // Address columns compare in TypeScript, canonical form on both ends —
      // see readRows for why this is not a server-side ILIKE.
      const rows = await readRows<Record<string, unknown>>(table, `id, ${column}`);
      return {
        rows: rows.filter((r) => matchesAddress(r[column], value)).map((r) => ({ id: String(r.id) })),
        error: null,
      };
    },
    update: async (table, id, patch) => {
      if (!apply) return { error: null };
      const { error } = await db.from(table).update(patch).eq("id", id);
      return { error: error ? { message: error.message } : null };
    },
    report: (message) => console.error(message),
  };

  const result = await purgeThirdPartySubject(kind, canonical, io);

  if (result.notFound) {
    console.log(`${target}: no rows matched.`);
    continue;
  }
  for (const [table, ids] of Object.entries(result.anonymized)) {
    if (ids.length === 0) continue;
    console.log(
      apply
        ? `${table}: anonymized ${ids.length} row(s) — ${ids.join(", ")}`
        : `${table}: WOULD anonymize ${ids.length} row(s) — ${ids.join(", ")}`,
    );
  }
  for (const [table, ids] of Object.entries(result.failed)) {
    if (ids.length > 0) {
      console.log(`${table}: FAILED ${ids.join(", ")} — re-run; the pass is idempotent.`);
    }
  }
}

console.log(apply ? "\ndone." : "\ndry run — pass --apply to write.");
