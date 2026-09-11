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
//
// EXIT CODES (US-3396). 0 means every count in the output came back from the
// database. 1 means at least one read failed; the tables that DID read are
// still printed, because the seven counts are independent, but the failures are
// named above and below the table and the run is non-zero. A count this script
// could not take is never rendered as 0 - this output goes on a GDPR ticket.

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

/**
 * Tables whose count is a FLOOR or a fabrication rather than a count, because
 * the read failed part-way or at once. Named here and reported; the run then
 * exits non-zero (US-3396). Empty is the only state in which this output can be
 * pasted into a ticket.
 */
const unreadable: Array<{ table: string; column: string; reason: string; rowsRead: number }> = [];

/** Page through a column so a large table cannot silently truncate the count. */
async function readColumn(table: string, column: string): Promise<string[]> {
  const page = 1000;
  const out: string[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await db
      .from(table)
      .select(column)
      // Stable paging: without an order a row can land on two pages and inflate
      // a distinct-address count, or on none and deflate it (US-3396).
      .order("id", { ascending: true })
      .range(from, from + page - 1);
    if (error) {
      // Reported, not thrown: one unreadable table must not hide the counts for
      // the other six. But the partial count is NOT a count, so the table is
      // recorded here, called out in the output, and the run exits 1 - a silent
      // zero on a GDPR ticket reads as "nothing here".
      console.error(`! ${table}.${column} unreadable: ${error.message}`);
      unreadable.push({ table, column, reason: error.message, rowsRead: out.length });
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
      // Stable paging (US-3396): a user missed here classifies every one of
      // their addresses as unattributable.
      .order("id", { ascending: true })
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

// FATAL, not defaulted (US-3396). This line renders as "account_deletion_log
// holds N deletion(s)" on a GDPR ticket, and a dropped error printed
// "0 deletion(s)" - a compliance claim built from a failed read. There is no
// "unknown" slot for it: formatCensus takes a number, so the run stops instead.
const { count: deletionsLogged, error: deletionsErr } = await db
  .from("account_deletion_log")
  .select("id", { count: "exact", head: true });
if (deletionsErr || deletionsLogged === null) {
  console.error(
    `account_deletion_log count failed: ${deletionsErr?.message ?? "no count returned"}\n` +
      `Refusing to print "holds 0 deletion(s)" for a count that was never taken.`,
  );
  Deno.exit(1);
}

// job_name is the last path segment of /api/jobs/<name> (00164), and `success`
// specifically — an errored tick proves the cron fires, not that it purged.
//
// FATAL for the same reason (US-3396): no row and a failed read both arrive as
// an empty `lastRun`, and the empty case prints the single most actionable line
// in the whole report - "the html bodies are not expiring at all". That is an
// operator instruction, and it must not come out of a dropped error.
const { data: lastRun, error: lastRunErr } = await db
  .from("cron_runs")
  .select("created_at")
  .eq("job_name", "data-retention")
  .eq("status", "success")
  .order("created_at", { ascending: false })
  .limit(1);
if (lastRunErr) {
  console.error(
    `cron_runs read failed: ${lastRunErr.message}\n` +
      `Refusing to print "NO data-retention cron run found" for a read that did ` +
      `not happen - that line tells an operator the retention sweep is not ` +
      `scheduled.`,
  );
  Deno.exit(1);
}

// The tables that could not be read are named BEFORE the numbers, because the
// numbers are what gets copied into the ticket.
if (unreadable.length > 0) {
  console.log(
    `!! ${unreadable.length} table(s) below carry a FLOOR, not a count. Do not ` +
      `quote this census until they read clean:`,
  );
  for (const u of unreadable) {
    console.log(
      `!!   ${u.table}.${u.column} = UNKNOWN, not 0 (${u.rowsRead} row(s) read, ` +
        `then: ${u.reason})`,
    );
  }
  console.log("");
}

const census = buildResidueCensus(addressesByTable, liveAccounts);
console.log(
  formatCensus(census, {
    deletionsLogged,
    retentionSweepLastRunAt:
      (lastRun as Array<{ created_at: string }> | null)?.[0]?.created_at ?? null,
  }),
);

if (unreadable.length > 0) {
  console.error(
    `\n! ${unreadable.length} of ${EMAIL_PURGE_PLAN.length} planned table(s) did ` +
      `not read: ${unreadable.map((u) => u.table).join(", ")}. Their rows above ` +
      `are floors. Exiting 1.`,
  );
  Deno.exit(1);
}
