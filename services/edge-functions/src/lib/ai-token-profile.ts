// US-3145: what every AI phase actually SPENDS, per call, in tokens.
//
// WHY A TOKEN PROFILE AND NOT JUST A COST REPORT. unit-economics.ts already
// answers "does the plan cover the bill". It cannot answer the question this
// epic (US-3146..US-3152) turns on, because it never reads a token column:
//
//   Sonnet 5 runs adaptive thinking, and the DEFAULT effort is `high`. A call
//   site that sends no output_config is not choosing the default - it is
//   unaware there is one. Thinking tokens are billed as OUTPUT tokens, so
//   `median output_tokens per phase` is the only visible proxy for how much
//   deliberation each phase is buying.
//
// So this module reports the medians, and every later story in the epic is
// judged by moving one of them. Nothing here is an opinion about what the
// numbers should be; the script prints them and the story notes argue.
//
// MEDIAN, NOT MEAN, EVERYWHERE. One 8k-token blog article inside a window of
// 400 tag-OCR calls moves a mean and tells you nothing about either. The
// totals are sums because a bill is a sum.
//
// PURE. No Deno, no network, no clock - scripts/ai-token-profile.ts supplies
// the rows and the window, which is what makes the arithmetic unit-testable
// against fixtures instead of against production.

/** Which side of the business a phase's spend belongs to. */
export type SpendBucket = "operator" | "grading" | "action";

/**
 * Phases billed as GRADE CREDITS rather than AI actions (lib/ai-metering.ts).
 * Kept identical to the set unit-economics.ts used before this module existed;
 * that script now imports from here so there is one definition to drift.
 */
export const GRADING_PHASES: ReadonlySet<string> = new Set([
  "per_image",
  "composite",
]);

/** Phases nobody's allowance covers: the platform's own spend. */
export const OPERATOR_PHASES: ReadonlySet<string> = new Set([
  "content",
  "newsletter_editor",
  "newsletter_image",
]);

/**
 * Phases known to be user AI actions. Anything listed nowhere still classifies
 * as `action` - the conservative side, since that inflates per-action cost and
 * so cannot make a plan look safer than it is - but is REPORTED as unrecognised,
 * because the opposite error (a new operator feature landing silently in the
 * plan-risk arithmetic) is real.
 */
export const KNOWN_ACTION_PHASES: ReadonlySet<string> = new Set([
  "photo_qa",
  "catalog_extract",
  "autolister_refine",
  "size_estimate",
  "autolister",
  "autolister_verify_groups",
  "measure_extract",
  "comp_read",
  "photo_roles",
  "tag_ocr",
]);

/**
 * Phases whose call site ALREADY sends output_config.effort, as of US-3145.
 *
 * These are the CONTROLS. Their median output_tokens is what a deliberately
 * chosen effort looks like on this workload, and every other row is read
 * against them rather than against a guess. Reading a control row as a
 * candidate is the specific mistake this set exists to prevent.
 *
 * ⚠ THIS LIST MOVES AS THE EPIC LANDS. US-3146 and US-3147 convert call sites;
 * each of those stories adds its converted phases here in the same commit, so a
 * later run of the profile shows at a glance what is still on the default.
 *
 * Sources, so the next reader can verify rather than trust:
 *   per_image / composite  ai-grading.ts, via gradingSamplingParams (effort low)
 *   grading                ai-authenticity.ts:841, same helper
 *   content_social         content-ai-social.ts:276 (effort medium)
 *   content_safety         content-safety.ts:138 (effort low)
 */
export const EFFORT_TUNED_PHASES: ReadonlySet<string> = new Set([
  "per_image",
  "composite",
  "grading",
  "content_social",
  "content_safety",
]);

/**
 * Phases ai-config.ts routes to the LIGHTWEIGHT model tier.
 *
 *   size_estimate  ai-size-estimate.ts:164  input.model || getSizeEstimateModel()
 *   photo_qa       ai-photo-qa.ts:195       getPhotoQaModel()
 *
 * ⚠ THE FIRST VERSION OF THIS SET ALSO LISTED tag_ocr AND photo_roles, AND WAS
 * WRONG. Both call getDefaultModel() outright (ai-tag-ocr.ts:430,
 * ai-photo-roles.ts:132), so their Sonnet rows are the code doing exactly what
 * it says. Listing them made the report cry wolf on two correctly-configured
 * phases every run, which is the fastest way to teach a reader to skip a
 * warning section. Whether those two SHOULD move to the lightweight tier is an
 * open product question; it is not a misconfiguration, and this is not the
 * place to argue it.
 *
 * SO THE MEMBERSHIP RULE IS: a phase belongs here only if its call site reaches
 * getLightweightModel() through some chain. Check the call site, not the cost.
 *
 * WHY THE CHECK IS AGAINST THE LEDGER AND NOT THE CODE. Every one of those
 * chains ends in a hardcoded claude-haiku-4-5 fallback, so an UNSET variable
 * still yields Haiku - the failure this catches is a variable set to the WRONG
 * value, or a caller passing an override. size_estimate has exactly such an
 * override, and it is deliberate: the grading pipeline passes getDefaultModel()
 * explicitly because the size result becomes grading ground truth. Expect those
 * rows and do not "fix" them.
 */
export const LIGHTWEIGHT_TIER_PHASES: ReadonlySet<string> = new Set([
  "size_estimate",
  "photo_qa",
]);

/** Model ids that ARE the lightweight tier. Matched by prefix. */
export const LIGHTWEIGHT_MODEL_PREFIXES: readonly string[] = ["claude-haiku"];

export function isLightweightModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  return LIGHTWEIGHT_MODEL_PREFIXES.some((p) => m.startsWith(p));
}

export function classifyPhase(phase: string): SpendBucket {
  if (phase.startsWith("agent:")) return "operator";
  if (OPERATOR_PHASES.has(phase)) return "operator";
  if (GRADING_PHASES.has(phase)) return "grading";
  return "action";
}

export function isRecognisedPhase(phase: string): boolean {
  return (
    phase.startsWith("agent:") ||
    OPERATOR_PHASES.has(phase) ||
    GRADING_PHASES.has(phase) ||
    KNOWN_ACTION_PHASES.has(phase)
  );
}

/** One ai_usage_events row, as the columns come back from PostgREST. */
export interface TokenProfileRow {
  phase: string | null;
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_creation_tokens?: number | null;
  cost_usd?: number | string | null;
}

export interface PhaseProfile {
  phase: string;
  bucket: SpendBucket;
  recognised: boolean;
  /** True when this phase's call site already chooses an effort (a control). */
  effortTuned: boolean;
  calls: number;
  /** Every distinct model that served this phase in the window, sorted. */
  models: string[];
  /**
   * Calls and cost per model, most calls first.
   *
   * A window can straddle a model change - the 2026-09-08 run had five phases
   * served by two models each - and when it does, EVERY median in that row is a
   * blend of two different token shapes and two different price sheets. The mix
   * is what tells the reader that, and what makes "how much is still on the old
   * model" answerable without a second query.
   */
  modelMix: Array<{ model: string; calls: number; costUsd: number }>;
  medianInputTokens: number | null;
  medianOutputTokens: number | null;
  medianCacheReadTokens: number | null;
  medianCostUsd: number | null;
  totalCostUsd: number;
  /**
   * Share of calls (0..1) that read anything from the prompt cache. A phase
   * with a cache_control breakpoint and a share of 0 is the silent-failure
   * shape US-3047 documented: below the per-model cache minimum a breakpoint is
   * ignored outright, with no error and no warning.
   */
  cacheHitShare: number;
}

/** Median with no rounding. Callers round at render time, once. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function num(v: number | string | null | undefined): number {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n as number) ? (n as number) : 0;
}

/**
 * Group the window's rows by `phase` and reduce each group to its medians.
 *
 * WHY `phase` AND NOT `feature`. Both columns are written (ai-usage.ts), and
 * for every non-grading call they hold the same string. They diverge exactly
 * where it matters: grading writes feature="grading" for BOTH of its calls, so
 * grouping by feature merges the per-image vision call with the composite text
 * synthesis - two different prompts, two different token shapes, one number
 * that describes neither. `phase` keeps them apart.
 *
 * A row with no phase is dropped rather than bucketed under "" - a nameless row
 * is a ledger defect, and inventing a bucket for it hides that.
 */
export function profileByPhase(rows: readonly TokenProfileRow[]): PhaseProfile[] {
  const groups = new Map<string, TokenProfileRow[]>();
  for (const r of rows) {
    const phase = (r.phase ?? "").trim();
    if (!phase) continue;
    const g = groups.get(phase);
    if (g) g.push(r);
    else groups.set(phase, [r]);
  }

  const out: PhaseProfile[] = [];
  for (const [phase, mine] of groups) {
    const costs = mine.map((r) => num(r.cost_usd));
    const cacheReads = mine.map((r) => num(r.cache_read_tokens));
    const mix = new Map<string, { model: string; calls: number; costUsd: number }>();
    for (const r of mine) {
      const model = (r.model ?? "").trim() || "?";
      const e = mix.get(model) ?? { model, calls: 0, costUsd: 0 };
      e.calls += 1;
      e.costUsd += num(r.cost_usd);
      mix.set(model, e);
    }
    out.push({
      phase,
      bucket: classifyPhase(phase),
      recognised: isRecognisedPhase(phase),
      effortTuned: EFFORT_TUNED_PHASES.has(phase),
      calls: mine.length,
      models: [...new Set(mine.map((r) => (r.model ?? "").trim()).filter(Boolean))]
        .sort(),
      modelMix: [...mix.values()].sort((a, b) =>
        b.calls - a.calls || a.model.localeCompare(b.model)
      ),
      medianInputTokens: median(mine.map((r) => num(r.input_tokens))),
      medianOutputTokens: median(mine.map((r) => num(r.output_tokens))),
      medianCacheReadTokens: median(cacheReads),
      medianCostUsd: median(costs),
      totalCostUsd: costs.reduce((a, b) => a + b, 0),
      cacheHitShare: mine.length === 0
        ? 0
        : cacheReads.filter((n) => n > 0).length / mine.length,
    });
  }

  // Most expensive first, then by name so two phases that cost the same in a
  // quiet window still order identically on a re-run (AC3: two runs of the same
  // window print the same thing).
  return out.sort((a, b) =>
    b.totalCostUsd - a.totalCostUsd || a.phase.localeCompare(b.phase)
  );
}

export interface ProfileWindow {
  /** Inclusive lower bound, ISO. */
  since: string;
  /** Exclusive upper bound, ISO. */
  until: string;
}

/** Start of the UTC day containing `d`. */
export function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Resolve the reporting window, DAY-ALIGNED by default.
 *
 * `--days 30` means the 30 whole UTC days ending at the start of today, NOT
 * "now minus 720 hours". That distinction is the entire content of US-3145 AC3:
 * a BEFORE table is only quotable if a second run an hour later reads the same
 * rows and prints the same numbers. A rolling now-anchored window silently
 * drops its oldest hour and gains a new one on every run, so two operators
 * comparing notes would disagree and neither would know why.
 *
 * An explicit --since / --until wins over --days, unaligned, because an
 * operator naming exact bounds is answering a different question.
 */
export function resolveWindow(input: {
  days?: number;
  since?: string;
  until?: string;
  now?: Date;
}): ProfileWindow {
  const now = input.now ?? new Date();
  const until = input.until ? new Date(input.until) : utcDayStart(now);
  if (Number.isNaN(until.getTime())) {
    throw new Error(`not a date: ${input.until}`);
  }
  const days = input.days && input.days > 0 ? Math.floor(input.days) : 30;
  const since = input.since
    ? new Date(input.since)
    : new Date(until.getTime() - days * 86_400_000);
  if (Number.isNaN(since.getTime())) {
    throw new Error(`not a date: ${input.since}`);
  }
  if (since >= until) {
    throw new Error(
      `empty window: ${since.toISOString()} >= ${until.toISOString()}`,
    );
  }
  return { since: since.toISOString(), until: until.toISOString() };
}

function usd(n: number | null, dp = 4): string {
  if (n === null) return "-";
  return `$${n.toFixed(dp)}`;
}

function tok(n: number | null): string {
  return n === null ? "-" : String(Math.round(n));
}

/**
 * The models that served a phase, short enough for a column.
 *
 * THIS COLUMN EARNED ITS WIDTH ON THE FIRST PROD RUN. ai-config.ts routes
 * size_estimate, photo_qa, photo_roles and tag_ocr to the LIGHTWEIGHT tier, and
 * the 2026-09-08 profile showed all four billing at Sonnet rates - the tier is
 * a default in code that no deploy had ever set. Without the model printed
 * beside the cost, the only way to notice was to divide $/call by tokens by
 * hand, which nobody does. A tier that silently is not in effect looks exactly
 * like a tier that is.
 */
function modelLabel(models: readonly string[]): string {
  if (models.length === 0) return "?";
  const short = models.map((m) =>
    m.replace(/^claude-/, "").replace(/-\d{8}$/, "")
  );
  if (short.length === 1) return short[0]!;
  if (short.length === 2) return short.join(",");
  return `${short[0]!}+${short.length - 1}`;
}

const BUCKET_HEADINGS: Record<SpendBucket, string> = {
  operator: "operator spend (blog, newsletter, agent fleet - no allowance covers this)",
  grading: "grading (billed as grade credits, not AI actions)",
  action: "user AI actions",
};

/**
 * The report, as text. Grouped by bucket so a content-generation regression
 * cannot hide inside a per-action average (US-3145 AC2).
 *
 * The `eff` column is the whole point of the table: `set` means that phase's
 * call site chooses an effort, `HIGH` means it sends no output_config and is
 * therefore running Sonnet 5's default. Sorting the HIGH rows by median output
 * tokens gives the work order for US-3146 and US-3147.
 */
export function renderProfile(
  profiles: readonly PhaseProfile[],
  window: ProfileWindow,
): string {
  const lines: string[] = [];
  const totalCalls = profiles.reduce((a, p) => a + p.calls, 0);
  const totalCost = profiles.reduce((a, p) => a + p.totalCostUsd, 0);

  lines.push(`AI token profile  ${window.since}  ..  ${window.until}`);
  lines.push(
    `${totalCalls} call(s), $${totalCost.toFixed(2)} total, ` +
      `${profiles.length} distinct phase(s).`,
  );
  lines.push("");
  lines.push(
    "eff=HIGH means the call site sends no output_config, so it runs Sonnet 5's",
  );
  lines.push(
    "default effort (high) with adaptive thinking. Thinking bills as OUTPUT",
  );
  lines.push("tokens, so out/call is the column US-3146 and US-3147 move.");

  for (const bucket of ["action", "operator", "grading"] as const) {
    const mine = profiles.filter((p) => p.bucket === bucket);
    if (mine.length === 0) continue;
    const cost = mine.reduce((a, p) => a + p.totalCostUsd, 0);
    lines.push("");
    lines.push(`-- ${BUCKET_HEADINGS[bucket]}  $${cost.toFixed(2)} --`);
    lines.push(
      "  phase                        model                     eff   calls   in/call  out/call  cacheRd  hit%    $/call      total",
    );
    for (const p of mine) {
      lines.push(
        "  " +
          p.phase.padEnd(28) +
          modelLabel(p.models).padEnd(26) +
          (p.effortTuned ? "set " : "HIGH").padEnd(6) +
          String(p.calls).padStart(5) +
          tok(p.medianInputTokens).padStart(10) +
          tok(p.medianOutputTokens).padStart(10) +
          tok(p.medianCacheReadTokens).padStart(9) +
          `${Math.round(p.cacheHitShare * 100)}%`.padStart(6) +
          usd(p.medianCostUsd).padStart(12) +
          `$${p.totalCostUsd.toFixed(2)}`.padStart(11) +
          (p.recognised ? "" : "  (unrecognised phase)"),
      );
    }
  }

  const unknown = profiles.filter((p) => !p.recognised);
  if (unknown.length > 0) {
    lines.push("");
    lines.push("-- phases this profile does not recognise --");
    lines.push(
      "  Counted as user actions above. If one is really operator spend, add it",
    );
    lines.push(
      "  to OPERATOR_PHASES in src/lib/ai-token-profile.ts or the plan math in",
    );
    lines.push("  unit-economics.ts overstates customer cost.");
    for (const p of unknown) {
      lines.push(
        `  ${p.phase.padEnd(28)} ${String(p.calls).padStart(5)} calls  ` +
          `$${p.totalCostUsd.toFixed(2)}`,
      );
    }
  }

  // The tier check, before the effort work order: a phase on the wrong MODEL is
  // a bigger and cheaper win than any effort setting, and it is a config fix
  // rather than a code change.
  const misRouted = profiles.filter((p) =>
    LIGHTWEIGHT_TIER_PHASES.has(p.phase) &&
    p.models.length > 0 &&
    !p.models.every(isLightweightModel)
  );
  if (misRouted.length > 0) {
    lines.push("");
    lines.push("-- ! routed to the lightweight tier in code, served by a full model --");
    lines.push(
      "  ai-config.ts sends these to getLightweightModel(). The calls counted",
    );
    lines.push(
      "  below did not run on it, so LIGHTWEIGHT_AI_MODEL (or the phase's own",
    );
    lines.push(
      "  override) is unset on that deploy. The fix is a Coolify variable, not a",
    );
    lines.push(
      "  commit. A partial count means the window straddles the change.",
    );
    for (const p of misRouted) {
      const wrong = p.modelMix.filter((m) => !isLightweightModel(m.model));
      const wrongCalls = wrong.reduce((a, m) => a + m.calls, 0);
      const wrongCost = wrong.reduce((a, m) => a + m.costUsd, 0);
      lines.push(
        `  ${p.phase.padEnd(28)} ${String(wrongCalls).padStart(4)}/${
          String(p.calls).padEnd(4)
        } call(s)  $${wrongCost.toFixed(2)} on  ` +
          wrong.map((m) => `${m.model} (${m.calls})`).join(", "),
      );
    }
  }

  // A window that straddles a model change blends two price sheets into one
  // median. Say so rather than letting the reader quote a number that describes
  // neither model.
  const mixed = profiles.filter((p) => p.modelMix.length > 1);
  if (mixed.length > 0) {
    lines.push("");
    lines.push("-- phases served by more than one model in this window --");
    lines.push(
      "  Their medians above BLEND both. Narrow the window with --since/--until",
    );
    lines.push("  before quoting one as a baseline.");
    for (const p of mixed) {
      lines.push(
        `  ${p.phase.padEnd(28)} ` +
          p.modelMix
            .map((m) => `${m.model} x${m.calls} $${m.costUsd.toFixed(2)}`)
            .join("  |  "),
      );
    }
  }

  const untuned = profiles
    .filter((p) => !p.effortTuned && p.medianOutputTokens !== null)
    .sort((a, b) =>
      (b.medianOutputTokens ?? 0) - (a.medianOutputTokens ?? 0) ||
      a.phase.localeCompare(b.phase)
    )
    .slice(0, 10);
  if (untuned.length > 0) {
    lines.push("");
    lines.push("-- work order: default-effort phases by median output tokens --");
    for (const p of untuned) {
      lines.push(
        `  ${p.phase.padEnd(28)} ${tok(p.medianOutputTokens).padStart(6)} out/call  ` +
          `x ${String(p.calls).padStart(5)} calls  = $${p.totalCostUsd.toFixed(2)}`,
      );
    }
  }

  return lines.join("\n");
}
