#!/usr/bin/env node
// US-2339 AC4 — find flipdesk_expenses rows whose spent_on has drifted backwards.
//
// THE BUG. The Android money screen re-derived spent_on from a UTC-midnight
// epoch through ZoneId.systemDefault(). One code path serves insert and edit, so
// for a seller west of Greenwich every edit-sync cycle moved the date back one
// more day. Fixed client-side in d660095e (ExpenseDraft.EXPENSE_ZONE = UTC).
//
// ⚠ THE FIX IS IN THE APP, so it lands per seller as they update. A device still
// on an older build keeps drifting. That is the reason to run this after the
// release has had time to roll out, and to run it more than once.
//
// WHAT CAN AND CANNOT BE PROVEN, because this is the part that decides whether
// the output is worth acting on:
//
//   RECURRING CHILDREN CAN BE PROVEN WRONG. A child row is generated server-side
//   by monthlyDueDates(): its day-of-month is always
//   min(template day, days in the child's month), never anything else, and never
//   the previous occurrence — the anti-drift rule is in the generator. So a child
//   sitting on a different day is a date the generator could not have produced.
//   That is arithmetic, not a heuristic.
//
//   STANDALONE ROWS CANNOT. A one-off expense has no ground truth: a seller
//   entering last month's receipts backdates legitimately, and nothing
//   distinguishes that from three drift cycles. This prints the population and
//   the distribution and says so, rather than inventing a threshold.
//
//   ROWS NEVER EDITED ARE DEFINITIVELY CLEAN, and that is the useful bound.
//   Drift happens on re-save. A row whose updated_at still matches its created_at
//   has been saved once and cannot have drifted, however far back its date looks.
//
// NO REPAIR, deliberately. The drift is compounding — an affected row is off by
// one day per cycle it went through — so there is no single offset to apply, and
// a repair that guesses would replace a wrong date with a differently wrong one
// while making it look reviewed. This reports; a human decides.
//
// Run: node scripts/audit-expense-date-drift.mjs
//   RETENTION_DB_URL=postgres://…  reads that database (this is the prod audit)
//   otherwise the local throwaway stack's container, which is a dry run.

import { execFileSync } from "node:child_process";

// US-2788: this script is named in that story as one of the three that hung on
// a wedged daemon. The catch below already turns a failure into null; without a
// timeout there was never a failure to catch.
import { DOCKER_QUERY_MS } from "./lib/docker-timeout.mjs";

const CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_gradethread";

function query(sql) {
  const url = process.env.RETENTION_DB_URL;
  const argv = url
    ? ["psql", url, "-tAF|", "-c", sql]
    : ["docker", "exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d",
       "postgres", "-tAF|", "-c", sql];
  try {
    const raw = execFileSync(argv[0], argv.slice(1), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: DOCKER_QUERY_MS,
    });
    return raw.trim() ? raw.trim().split("\n").map((l) => l.split("|")) : [];
  } catch {
    return null;
  }
}

/**
 * The day-of-month the generator would have used for a child in `month`.
 *
 * Exported so the arithmetic is testable without a database — it is the whole
 * basis of the only finding here that is certain, and getting the end-of-month
 * clamp wrong would report every February 30th-of-the-month row as drifted.
 */
export function generatedDay(anchorDay, year, month) {
  return Math.min(anchorDay, new Date(Date.UTC(year, month, 0)).getUTCDate());
}

/** Rows the generator could not have produced. Certain, given the anchor. */
export function driftedChildren(rows) {
  const out = [];
  for (const [id, userId, childDate, anchorDate, updatedAt, createdAt] of rows) {
    const [cy, cm, cd] = childDate.split("-").map(Number);
    const anchorDay = Number(anchorDate.split("-")[2]);
    const expected = generatedDay(anchorDay, cy, cm);
    if (cd === expected) continue;
    out.push({
      id,
      userId,
      childDate,
      anchorDate,
      expectedDay: expected,
      actualDay: cd,
      // Negative = earlier than generated, which is the drift direction. A
      // positive delta is something else and should not be read as this bug.
      deltaDays: cd - expected,
      edited: updatedAt > createdAt,
    });
  }
  return out;
}

function main() {
  const reachable = query("select 1");
  if (reachable === null) {
    console.error(
      "✗ no database reachable.\n" +
        `  Set RETENTION_DB_URL for the prod audit, or start the local stack (${CONTAINER}).\n` +
        "  Not printing an empty result as though it were a clean one.",
    );
    process.exit(2);
  }
  const target = process.env.RETENTION_DB_URL ? "RETENTION_DB_URL" : `local container ${CONTAINER}`;
  console.log(`flipdesk_expenses date-drift audit — reading ${target}\n`);

  // ── The population bound ────────────────────────────────────────
  const totals = query(`
    select count(*),
           count(*) filter (where updated_at > created_at + interval '2 seconds'),
           count(*) filter (where recurrence_source_id is not null)
    from public.flipdesk_expenses;`);
  if (!totals || totals.length === 0) {
    console.error("✗ the count query returned nothing — the table or the connection is wrong.");
    process.exit(2);
  }
  const [total, edited, children] = totals[0].map(Number);
  if (total === 0) {
    console.log("  flipdesk_expenses is empty — nothing to audit.");
    return;
  }
  console.log(`  ${total} row(s) total`);
  console.log(`  ${total - edited} never re-saved — CANNOT have drifted, whatever their date looks like`);
  console.log(`  ${edited} re-saved at least once — the only rows at risk`);
  console.log(`  ${children} of them are recurring children, where drift is provable\n`);

  if (edited === 0) {
    console.log("✓ no row has ever been re-saved, so nothing has drifted. Audit complete.");
    return;
  }

  // ── The certain finding ─────────────────────────────────────────
  const childRows = query(`
    select c.id::text, c.user_id::text, c.spent_on::text, t.spent_on::text,
           c.updated_at::text, c.created_at::text
    from public.flipdesk_expenses c
    join public.flipdesk_expenses t on t.id = c.recurrence_source_id
    where c.recurrence_source_id is not null
    order by c.spent_on;`) ?? [];

  const drifted = driftedChildren(childRows);
  if (drifted.length === 0) {
    console.log("✓ every recurring child sits on the day the generator would produce.");
  } else {
    const backwards = drifted.filter((d) => d.deltaDays < 0);
    console.log(
      `✗ ${drifted.length} recurring child row(s) are NOT on a generated date` +
        (backwards.length ? `, ${backwards.length} of them EARLIER (the drift direction)` : "") + ":",
    );
    for (const d of drifted.slice(0, 40)) {
      console.log(
        `    ${d.childDate}  expected day ${d.expectedDay}, got ${d.actualDay} ` +
          `(${d.deltaDays > 0 ? "+" : ""}${d.deltaDays}d)  anchor ${d.anchorDate}  ` +
          `${d.edited ? "re-saved" : "NEVER re-saved — not this bug"}  id=${d.id}`,
      );
    }
    if (drifted.length > 40) console.log(`    … and ${drifted.length - 40} more (capped for readability)`);
    console.log(
      "\n  A generated child is always on min(anchor day, days in month). A row that is not\n" +
        "  either drifted or was edited by hand; a NEVER-re-saved row above is the second case,\n" +
        "  because this bug only fires on re-save.",
    );
  }

  // ── The honest limit ────────────────────────────────────────────
  const spread = query(`
    select (spent_on - created_at::date) as delta, count(*)
    from public.flipdesk_expenses
    where recurrence_source_id is null
      and updated_at > created_at + interval '2 seconds'
    group by 1 order by 1 limit 30;`) ?? [];

  console.log("\n  Standalone re-saved rows, spent_on minus the date they were entered:");
  if (spread.length === 0) {
    console.log("    none.");
  } else {
    for (const [delta, count] of spread) {
      console.log(`    ${String(delta).padStart(6)}d  ${count} row(s)`);
    }
    console.log(
      "\n  ⚠ THIS IS NOT A FINDING. Backdating a receipt produces the same shape as drift,\n" +
        "  and there is no ground truth to separate them. Read it for an implausible tail —\n" +
        "  a cluster far in the negative on rows re-saved many times — and treat anything\n" +
        "  you act on as a judgement call, not a detection.",
    );
  }
}

if (process.argv[1]?.endsWith("audit-expense-date-drift.mjs")) main();
