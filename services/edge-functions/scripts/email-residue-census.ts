// US-2434 AC1: count the pre-US-2005 email-keyed residue. Count only.
//
// THIS SCRIPT HAS NO --apply AND NEVER WILL. That is not caution, it is the
// finding: the population the story asks to purge cannot be identified from
// retained data, so there is nothing safe for an --apply to act on. The full
// reasoning is in src/lib/email-residue-census.ts; the short version is that
// account_deletion_log stores no address by design and every planned table
// either severs its user link on delete or never had one, so "erased subject"
// and "ordinary lead" are indistinguishable.
//
// It never prints an address. Output is meant for a ticket.
//
//   deno run --allow-net --allow-env scripts/email-residue-census.ts

import { createClient } from "@supabase/supabase-js";
import { EMAIL_PURGE_PLAN } from "../src/lib/account-email-purge.ts";
import {
  buildResidueCensus,
  formatCensus,
  normalizeAddress,
} from "../src/lib/email-residue-census.ts";

const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  Deno.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

/** Page through a column so a large table cannot silently truncate the count. */
async function readColumn(table: string, column: string): Promise<string[]> {
  const page = 1000;
  const out: string[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await db
      .from(table)
      .select(column)
      .range(from, from + page - 1);
    if (error) {
      // Reported, not thrown: one unreadable table must not hide the counts for
      // the other six. A silent zero would read as "nothing here".
      console.error(`! ${table}.${column} unreadable: ${error.message}`);
      return out;
    }
    // Through `unknown`: supabase-js types a dynamic .select(column) as a
    // GenericStringError union, which never overlaps a plain row shape.
    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
    for (const row of rows) {
      const value = row[column];
      if (typeof value === "string") out.push(value);
    }
    if (rows.length < page) return out;
  }
}

const addressesByTable: Record<string, string[]> = {};
for (const target of EMAIL_PURGE_PLAN) {
  addressesByTable[target.table] = await readColumn(target.table, target.column);
}

const liveAccounts = new Set<string>();
{
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await db
      .from("users")
      .select("email")
      .range(from, from + page - 1);
    if (error) {
      // Unlike a single table above, this one is fatal. Without the live-account
      // set EVERY address classifies as unattributable, and that number would be
      // read as an erasure backlog roughly the size of the user base.
      console.error(`live-account read failed: ${error.message}`);
      Deno.exit(1);
    }
    const rows = (data ?? []) as Array<{ email: string | null }>;
    for (const row of rows) {
      const address = normalizeAddress(row.email);
      if (address) liveAccounts.add(address);
    }
    if (rows.length < page) break;
  }
}

const { count: deletionsLogged } = await db
  .from("account_deletion_log")
  .select("id", { count: "exact", head: true });

// job_name is the last path segment of /api/jobs/<name> (00164), and `success`
// specifically — an errored tick proves the cron fires, not that it purged.
const { data: lastRun } = await db
  .from("cron_runs")
  .select("created_at")
  .eq("job_name", "data-retention")
  .eq("status", "success")
  .order("created_at", { ascending: false })
  .limit(1);

const census = buildResidueCensus(addressesByTable, liveAccounts);
console.log(
  formatCensus(census, {
    deletionsLogged: deletionsLogged ?? 0,
    retentionSweepLastRunAt:
      (lastRun as Array<{ created_at: string }> | null)?.[0]?.created_at ?? null,
  }),
);
