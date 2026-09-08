// US-3145: the BEFORE table the AI cost epic (US-3146..US-3152) is judged against.
//
// Prints, per `phase` in ai_usage_events over a window: call count, median
// input / output / cache-read tokens, cache hit share, median and total cost -
// grouped into operator / grading / user-action so a content regression cannot
// hide inside a per-action average.
//
// THE COLUMN THAT MATTERS IS out/call. Sonnet 5 runs adaptive thinking and its
// DEFAULT effort is `high`; 39 of 45 call sites in this service send no
// output_config at all, so they are not choosing that default, they are unaware
// of it. Thinking bills as output tokens. Every story in the epic is a claim
// that one of those medians comes down without the work getting worse.
//
// READ-ONLY. It writes nothing, so it is safe against prod - which is the only
// place a meaningful answer lives, since a local stack has no ledger rows.
//
//   deno run --allow-net --allow-env scripts/ai-token-profile.ts \
//     [--days 30] [--since 2026-08-01] [--until 2026-09-01] [--json]
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. ai_usage_events is
// service-role only, so an anon read returns [] whether the table is empty or
// full - which is the one answer this script must not give. The key is shape-
// checked before the first query for the same reason.
//
// THE WINDOW IS DAY-ALIGNED, DELIBERATELY. `--days 30` means the 30 whole UTC
// days ending at the start of today, not "now minus 720 hours". Two runs an
// hour apart therefore read the SAME rows and print the SAME numbers, which is
// what makes a BEFORE table quotable in a story note. Pass --since/--until for
// an explicit window.

import { createClient } from "@supabase/supabase-js";
import {
  profileByPhase,
  renderProfile,
  resolveWindow,
  type ProfileWindow,
  type TokenProfileRow,
} from "../src/lib/ai-token-profile.ts";

const url = Deno.env.get("SUPABASE_URL")?.trim();
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  Deno.exit(1);
}
const badChar = /[^\x21-\x7e]/.exec(key);
if (badChar || key.split(".").length !== 3 || key.length < 100) {
  console.error(
    `! SUPABASE_SERVICE_ROLE_KEY is not a usable JWT (${key.length} characters, ` +
      `${key.split(".").length} segments${
        badChar ? `, bad character at index ${badChar.index}` : ""
      }). Refusing to run rather than report a confident zero.`,
  );
  Deno.exit(1);
}

const args = Deno.args;
function opt(name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}
function intOpt(name: string, fallback: number): number {
  const n = Number(opt(name));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const AS_JSON = args.includes("--json");
const DAYS = intOpt("--days", 30);

// The day-alignment rule and the reason for it live with the pure function, so
// the determinism claim in US-3145 AC3 is unit-tested rather than asserted here.
// Named `reportWindow` rather than `window` so it cannot be read as the DOM
// global that Deno also defines.
function windowOrExit(): ProfileWindow {
  try {
    return resolveWindow({
      days: DAYS,
      since: opt("--since"),
      until: opt("--until"),
    });
  } catch (e) {
    console.error(`! ${e instanceof Error ? e.message : String(e)}`);
    Deno.exit(1);
  }
}
const reportWindow = windowOrExit();

const db = createClient(url, key, { auth: { persistSession: false } });

async function readLedger(): Promise<TokenProfileRow[]> {
  const page = 1000;
  const out: TokenProfileRow[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await db
      .from("ai_usage_events")
      .select(
        "phase, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd",
      )
      .gte("created_at", reportWindow.since)
      .lt("created_at", reportWindow.until)
      // Ordered so paging is stable: without an order the same row can appear
      // in two pages and a median quietly counts it twice.
      .order("created_at", { ascending: true })
      .range(from, from + page - 1);
    if (error) {
      console.error(`! ai_usage_events unreadable: ${error.message}`);
      Deno.exit(1);
    }
    const rows = (data ?? []) as unknown as TokenProfileRow[];
    out.push(...rows);
    if (rows.length < page) return out;
  }
}

const rows = await readLedger();

if (rows.length === 0) {
  console.log(
    `No ai_usage_events between ${reportWindow.since} and ${reportWindow.until}. ` +
      `Either nothing ran, or the ledger stopped being written - check before ` +
      `reading this as $0 spend.`,
  );
  Deno.exit(0);
}

const profiles = profileByPhase(rows);

if (AS_JSON) {
  console.log(JSON.stringify({ window: reportWindow, calls: rows.length, profiles }, null, 2));
} else {
  console.log(renderProfile(profiles, reportWindow));
}
