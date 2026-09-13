// US-3151 AC6/AC7: did the structured-output fix actually stop the content
// engine failing on unparseable JSON? Ask the database, not the deploy log.
//
// The story measured the BEFORE window by hand on 2026-09-08 and then spent
// three passes unable to measure the AFTER, because content_scheduler_runs is
// admin-read under RLS and no agent environment here has a service-role key.
// That left the last two acceptance criteria as "someone should go query prod",
// which is the shape of a task nobody does. This is that query, written down.
//
//   deno run --allow-net --allow-env scripts/content-parse-failure-report.ts
//
// TWO WAYS TO GET AN ANSWER, and the second needs no credentials at all -
// deliberately the same split as check-prod-migration.ts, for the same reason:
// a script that can only run with a secret is a script that only runs when
// somebody is already worried.
//
//   1. SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY: read content_scheduler_runs
//      over both windows and bucket every error string. This is AC6 and AC7
//      verbatim - run counts, error counts, and the per-message breakdown on
//      each side of the cutover.
//
//   2. No key: fall back to the PUBLIC RSS feed and count published posts per
//      day. That is a throughput proxy, not an error count, and it is honest
//      about its ceiling below. It is what was actually measurable during the
//      agent passes, and it did detect the change.
//
// ⚠ THE BLIND SPOT IN AC7'S OWN WORDING, which is why this script does not just
// grep for the two phrases the AC names. AC7 asks for zero errors matching
// "unparseable JSON" or "invalid JSON". Those are the messages the DELETED code
// threw. The replacement guards throw different words - "AI response was not a
// JSON object" (content-ai-blog.ts:121, content-ai-social.ts:199) and "AI
// refresh response was not a JSON object" (content-ai-refresh.ts:81) - so a
// literal reading of AC7 returns zero whether the fix works or the new guard is
// firing on every run. Same defect as a guard that stops matching after a
// rename. So the buckets below cover the retired messages AND their successors,
// and the exit code is driven by the union.
//
// READ-ONLY. It writes nothing.

import { createClient } from "@supabase/supabase-js";

// ── Windows ──────────────────────────────────────────────────────────────────

/** The story's measured BEFORE window: 886 runs, 402 errors, 300 output-shape. */
const DEFAULT_BEFORE_FROM = "2026-08-09";
/** The structured-output deploy. Runs at or after this are the AFTER window. */
const DEFAULT_CUTOVER = "2026-09-08";

/** What the hand measurement on 2026-09-08 found, for an at-a-glance diff. */
export const RECORDED_BEFORE = {
  runs: 886,
  errors: 402,
  outputShape: 300,
  measuredOn: "2026-09-08",
} as const;

// ── Classification ───────────────────────────────────────────────────────────

export type ErrorBucket =
  | "output_shape_retired"
  | "output_shape_current"
  | "max_tokens"
  | "other"
  | "none";

/**
 * Which failure class a content_scheduler_runs.error string belongs to.
 *
 * Pure and exported so the buckets are unit-testable against literal strings
 * rather than only ever exercised against a prod table nobody here can read.
 *
 * `output_shape_retired` is what US-3151 set out to drive to zero.
 * `output_shape_current` is the SAME failure reported in the words the
 * post-fix guards use; a non-zero count there means the schema stopped being
 * sent or stopped being honored, and it must not read as success.
 */
export function classifyContentRunError(raw: string | null | undefined): ErrorBucket {
  const text = (raw ?? "").trim();
  if (!text) return "none";

  // Retired messages: stripCodeFence + JSON.parse + jsonParseError, deleted by
  // this story. These are the two phrases AC7 names, plus the social variant
  // that reported the same root cause as a missing text block.
  if (
    /unparseable JSON/i.test(text) ||
    /invalid JSON/i.test(text) ||
    /response contained no text block/i.test(text)
  ) {
    return "output_shape_retired";
  }

  // Truncation. Counted separately because it is a BUDGET failure, not a shape
  // failure: raising max_tokens fixes it and a schema does not. The story
  // measured 46 of these and deliberately left them alone.
  if (/max_tokens/i.test(text)) return "max_tokens";

  // The successors. Reaching one of these now means the response was not the
  // shape the schema promised, which is a different and more serious claim than
  // the message it replaced.
  if (
    /response was not a JSON object/i.test(text) ||
    /response missing (title|body_html|long_body|short_body)/i.test(text)
  ) {
    return "output_shape_current";
  }

  return "other";
}

/** True for the buckets AC7's zero is really about. */
export function isOutputShapeFailure(bucket: ErrorBucket): boolean {
  return bucket === "output_shape_retired" || bucket === "output_shape_current";
}

export interface WindowSummary {
  label: string;
  from: string;
  until: string;
  runs: number;
  errors: number;
  buckets: Record<ErrorBucket, number>;
  /** The distinct error strings, most frequent first. */
  messages: Array<{ count: number; bucket: ErrorBucket; text: string }>;
}

export interface SchedulerRun {
  outcome: string;
  surface: string | null;
  error: string | null;
}

/** Bucket a window's rows. Pure, so the shape of the report is testable. */
export function summarizeWindow(
  label: string,
  from: string,
  until: string,
  rows: SchedulerRun[],
): WindowSummary {
  const buckets: Record<ErrorBucket, number> = {
    output_shape_retired: 0,
    output_shape_current: 0,
    max_tokens: 0,
    other: 0,
    none: 0,
  };
  const counts = new Map<string, { count: number; bucket: ErrorBucket }>();
  let errors = 0;

  for (const row of rows) {
    if (row.outcome !== "error") continue;
    errors++;
    const bucket = classifyContentRunError(row.error);
    buckets[bucket]++;
    const key = (row.error ?? "(no message)").trim() || "(no message)";
    const seen = counts.get(key);
    if (seen) seen.count++;
    else counts.set(key, { count: 1, bucket });
  }

  const messages = [...counts.entries()]
    .map(([text, v]) => ({ count: v.count, bucket: v.bucket, text }))
    .sort((a, b) => b.count - a.count);

  return { label, from, until, runs: rows.length, errors, buckets, messages };
}

// ── Credential-free proxy: published posts per day from the public RSS feed ───

const DEFAULT_RSS_URL = "https://gradethread.com/rss.xml";

/**
 * Published-posts-per-day out of an RSS document.
 *
 * The feed is capped (50 items when this was written), so the window it can
 * speak for is short and the OLDEST day in it is usually partial. Both are
 * reported rather than smoothed over.
 */
export function publishedPerDay(rssXml: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of rssXml.matchAll(/<pubDate>([^<]*)<\/pubDate>/g)) {
    const parsed = new Date(m[1]!.trim());
    if (Number.isNaN(parsed.getTime())) continue;
    const day = parsed.toISOString().slice(0, 10);
    out.set(day, (out.get(day) ?? 0) + 1);
  }
  return new Map([...out].sort((a, b) => a[0].localeCompare(b[0])));
}

export interface ProxyDay {
  day: string;
  posts: number;
  side: "before" | "after";
  /** Excluded from the averages. See the reasons in `splitProxy`. */
  partial: boolean;
}

export interface ProxySplit {
  days: ProxyDay[];
  oldest: string;
  newest: string;
  before: { days: number; posts: number; best: number };
  after: { days: number; posts: number; worst: number };
}

/**
 * Split published-per-day into before/after the cutover, excluding partial days.
 *
 * Pure, and extracted from the printing because the partial-day rule is where
 * this report gets a number wrong. THREE kinds of partial day: the newest is
 * today and still accruing, the oldest is clipped by the feed's item cap, and
 * the CUTOVER day is half on each side by definition — the deploy landed partway
 * through it. Counting the cutover day as a full AFTER day is what made the
 * first run of this report read 3.40/day instead of 4.00.
 */
export function splitProxy(perDay: Map<string, number>, cutover: string): ProxySplit {
  const keys = [...perDay.keys()].sort((a, b) => a.localeCompare(b));
  const oldest = keys[0] ?? "";
  const newest = keys[keys.length - 1] ?? "";

  const days: ProxyDay[] = [];
  const before = { days: 0, posts: 0, best: 0 };
  const after = { days: 0, posts: 0, worst: Number.POSITIVE_INFINITY };

  for (const day of keys) {
    const posts = perDay.get(day)!;
    const side: "before" | "after" = day < cutover ? "before" : "after";
    const partial = day === oldest || day === newest || day === cutover;
    days.push({ day, posts, side, partial });
    if (partial) continue;
    if (side === "before") {
      before.days++;
      before.posts += posts;
      before.best = Math.max(before.best, posts);
    } else {
      after.days++;
      after.posts += posts;
      after.worst = Math.min(after.worst, posts);
    }
  }

  return { days, oldest, newest, before, after };
}

async function runProxy(cutover: string, rssUrl: string): Promise<number> {
  console.log("No SUPABASE_SERVICE_ROLE_KEY — falling back to the public RSS proxy.\n");

  let xml: string;
  try {
    const res = await fetch(rssUrl, {
      headers: { "user-agent": "gradethread-ops/1.0 (+content-parse-failure-report)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    xml = await res.text();
  } catch (err) {
    console.error(`Could not read ${rssUrl}: ${(err as Error).message}`);
    return 1;
  }

  const perDay = publishedPerDay(xml);
  if (perDay.size === 0) {
    console.error("The feed parsed to zero dated items — nothing to report.");
    return 1;
  }

  const split = splitProxy(perDay, cutover);
  console.log(
    `Published blog posts per day, ${split.oldest} .. ${split.newest} (${perDay.size} days)\n`,
  );

  for (const d of split.days) {
    const side = d.side === "before" ? "before" : "after ";
    console.log(
      `  ${d.day}  ${String(d.posts).padStart(2)}  ${side}${d.partial ? "   (partial)" : ""}`,
    );
  }

  console.log("");
  if (split.before.days > 0) {
    console.log(
      `  BEFORE ${cutover}: ${split.before.posts} posts over ${split.before.days} full days ` +
        `= ${(split.before.posts / split.before.days).toFixed(2)}/day, best day ${split.before.best}`,
    );
  }
  if (split.after.days > 0) {
    console.log(
      `  AFTER  ${cutover}: ${split.after.posts} posts over ${split.after.days} full days ` +
        `= ${(split.after.posts / split.after.days).toFixed(2)}/day, worst day ${split.after.worst}`,
    );
  }

  console.log(`
  ⚠ WHAT THIS CANNOT TELL YOU. Throughput is a proxy. A scheduler saturating
    its daily cadence every day is consistent with zero parse failures, but it
    is also consistent with the operator having RAISED post_cadence_per_day_blog
    on the same day the fix deployed. It cannot see social or refresh at all,
    and it cannot produce the per-message counts AC7 asks for. Re-run with
    SUPABASE_SERVICE_ROLE_KEY for the real answer.`);

  return 0;
}

// ── Credentialed path: the real AC6/AC7 read ─────────────────────────────────

async function fetchWindow(
  // deno-lint-ignore no-explicit-any
  client: any,
  fromIso: string,
  untilIso: string,
): Promise<SchedulerRun[]> {
  const rows: SchedulerRun[] = [];
  const PAGE = 1000;
  for (let offset = 0;; offset += PAGE) {
    const { data, error } = await client
      .from("content_scheduler_runs")
      .select("outcome, surface, error")
      .gte("ran_at", fromIso)
      .lt("ran_at", untilIso)
      .order("ran_at", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`content_scheduler_runs read failed: ${error.message}`);
    const page = (data ?? []) as SchedulerRun[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

function printWindow(s: WindowSummary): void {
  const rate = s.runs > 0 ? ((s.errors / s.runs) * 100).toFixed(1) : "0.0";
  console.log(`${s.label}  ${s.from} .. ${s.until}`);
  console.log(`  runs ${s.runs}, errors ${s.errors} (${rate}%)`);
  console.log(`  output-shape, retired wording : ${s.buckets.output_shape_retired}`);
  console.log(`  output-shape, current wording : ${s.buckets.output_shape_current}`);
  console.log(`  max_tokens truncation         : ${s.buckets.max_tokens}`);
  console.log(`  everything else               : ${s.buckets.other}`);
  if (s.messages.length > 0) {
    console.log("  messages:");
    for (const m of s.messages.slice(0, 15)) {
      console.log(`    ${String(m.count).padStart(4)}  [${m.bucket}]  ${m.text.slice(0, 120)}`);
    }
  }
  console.log("");
}

async function main(): Promise<number> {
  const args = new Map<string, string>();
  for (const a of Deno.args) {
    const m = a.match(/^--([a-z-]+)=(.*)$/);
    if (m) args.set(m[1]!, m[2]!);
  }
  const beforeFrom = args.get("before-from") ?? DEFAULT_BEFORE_FROM;
  const cutover = args.get("cutover") ?? DEFAULT_CUTOVER;
  const until = args.get("until") ?? new Date().toISOString().slice(0, 10);
  const rssUrl = args.get("rss-url") ?? DEFAULT_RSS_URL;

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // A placeholder from .env.example is not a credential. Treating it as one is
  // how a run reports "0 errors" because every read was refused.
  const keyLooksReal = !!key && key.length > 40 && !/your-|placeholder|changeme/i.test(key);

  console.log("US-3151 — content scheduler output-shape failures\n");

  if (!url || !keyLooksReal) {
    return await runProxy(cutover, rssUrl);
  }

  const client = createClient(url, key!, { auth: { persistSession: false } });

  let before: WindowSummary, after: WindowSummary;
  try {
    before = summarizeWindow(
      "BEFORE",
      beforeFrom,
      cutover,
      await fetchWindow(client, beforeFrom, cutover),
    );
    after = summarizeWindow("AFTER ", cutover, until, await fetchWindow(client, cutover, until));
  } catch (err) {
    console.error((err as Error).message);
    console.error(
      "\nIf this is a permissions error, the key is not service-role: " +
        "content_scheduler_runs is admin-read under RLS (00198).",
    );
    return 1;
  }

  printWindow(before);
  printWindow(after);

  console.log(
    `Hand measurement on ${RECORDED_BEFORE.measuredOn} recorded ` +
      `${RECORDED_BEFORE.runs} runs / ${RECORDED_BEFORE.errors} errors / ` +
      `${RECORDED_BEFORE.outputShape} output-shape for the BEFORE window.\n`,
  );

  const shapeAfter = after.buckets.output_shape_retired + after.buckets.output_shape_current;
  if (after.runs === 0) {
    console.log("AC7: NOT MEASURABLE — the AFTER window holds no runs at all.");
    return 1;
  }
  if (shapeAfter > 0) {
    console.log(`AC7: FAIL — ${shapeAfter} output-shape failures after ${cutover}.`);
    return 1;
  }
  console.log(`AC7: PASS — zero output-shape failures across ${after.runs} runs after ${cutover}.`);

  const beforeRate = before.runs > 0 ? before.errors / before.runs : 0;
  const afterRate = after.errors / after.runs;
  console.log(
    afterRate <= beforeRate
      ? `AC6: PASS — error rate ${(afterRate * 100).toFixed(1)}% is at or below ` +
        `the ${(beforeRate * 100).toFixed(1)}% before it.`
      : `AC6: FAIL — error rate rose from ${(beforeRate * 100).toFixed(1)}% to ` +
        `${(afterRate * 100).toFixed(1)}%.`,
  );
  return afterRate <= beforeRate ? 0 : 1;
}

if (import.meta.main) {
  Deno.exit(await main());
}
