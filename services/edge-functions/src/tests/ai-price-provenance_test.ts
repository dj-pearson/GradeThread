// US-3342: the AI price table, checked instead of described.
//
// THE DEFECT THIS EXISTS FOR. `claude-sonnet-5` was priced at $3/$15 per MTok,
// identical to `claude-sonnet-4-6`, with a comment above it explaining that
// $3/$15 was the list price and that an introductory $2/$10 rate ran through a
// date that had already passed. The published rate was $2/$10 and had become
// the standard price; the scheduled increase was cancelled. So the default
// model - the one nearly every row in `ai_usage_events` is priced at - was
// being costed 50 percent high, in the module whose own header says a wrong
// price "would corrupt the margin figure the whole dashboard exists to report".
//
// Nothing was broken. A sentence had simply stopped being true, and a sentence
// cannot fail. That is the shape this file exists to make impossible:
//
//   1. A rate with no recorded check date is not a rate, it is a memory.
//   2. A time-bound rate names its expiry in `provisionalUntil`, and this file
//      goes RED the day that date passes - which is the whole point, because
//      the last one passed in silence.
//   3. The prose in ai-usage.ts may not name a calendar date the table does not
//      also hold. That is how the last claim hid: as a sentence beside the data
//      rather than in it.
//   4. Every model this build can actually route to has a price, or its spend
//      lands in the ledger at $0 and reads as a model nobody used.
//   5. The whole list is re-read on a clock, because one stale entry means
//      nobody swept the list - and only the sweep would have caught this one.
//
// Run: deno test --allow-env --allow-read src/tests/ai-price-provenance_test.ts

// US-2379: first, before anything that can reach lib/supabase.ts at import time.
import "./_env.ts";

import { assert, assertEquals } from "@std/assert";
import {
  computeCostUsd,
  MODEL_PRICES,
  PRICE_SWEEP_MAX_AGE_DAYS,
} from "../lib/ai-usage.ts";
import {
  CONTENT_MODEL_ALLOWLIST_FOR_TESTS,
  CURRENT_MODEL_IDS,
  GRADING_MODEL_ALLOWLIST,
} from "../lib/ai-config.ts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Any calendar date anywhere in a line of prose. */
const ANY_ISO_DATE = /\d{4}-\d{2}-\d{2}/g;

const DAY_MS = 24 * 60 * 60 * 1000;

function parseIsoDay(value: string): number {
  return Date.parse(`${value}T00:00:00Z`);
}

function today(): number {
  return parseIsoDay(new Date().toISOString().slice(0, 10));
}

Deno.test("US-3342: every rate records when it was read, and from where", () => {
  const entries = Object.entries(MODEL_PRICES);
  assert(entries.length > 0, "MODEL_PRICES is empty");

  for (const [model, price] of entries) {
    assert(
      ISO_DATE.test(price.checkedOn),
      `${model}: checkedOn must be YYYY-MM-DD, got ${JSON.stringify(price.checkedOn)}`,
    );
    assert(
      Number.isFinite(parseIsoDay(price.checkedOn)),
      `${model}: checkedOn is not a real date (${price.checkedOn})`,
    );
    assert(
      parseIsoDay(price.checkedOn) <= today(),
      `${model}: checkedOn ${price.checkedOn} is in the future - a rate cannot ` +
        `have been read off a table that has not been published yet`,
    );
    assert(
      price.source.startsWith("https://"),
      `${model}: source must be the URL the rate was read from, got ${price.source}`,
    );
    assert(
      price.inputPerMTok > 0 && price.outputPerMTok > 0,
      `${model}: a zero rate in the table is indistinguishable from an unpriced ` +
        `model - leave the entry out instead`,
    );
  }
});

Deno.test("US-3342: a provisional rate FAILS once its date has passed", () => {
  // This is the assertion the old comment needed and did not have. A rate the
  // provider has said is temporary is allowed - it just cannot outlive its own
  // expiry in silence.
  for (const [model, price] of Object.entries(MODEL_PRICES)) {
    if (price.provisionalUntil === undefined) continue;
    assert(
      ISO_DATE.test(price.provisionalUntil),
      `${model}: provisionalUntil must be YYYY-MM-DD, got ${price.provisionalUntil}`,
    );
    assert(
      parseIsoDay(price.provisionalUntil) >= today(),
      `${model}: the provisional rate ($${price.inputPerMTok}/$${price.outputPerMTok} ` +
        `per MTok) expired on ${price.provisionalUntil}. Re-read ${price.source}, ` +
        `set the rate that is actually live now, and either drop provisionalUntil ` +
        `or give it the new date.`,
    );
  }
});

Deno.test("US-3342: prose in ai-usage.ts names no date the table does not hold", () => {
  // Mode 1 in guards-that-do-not-guard runs the other way here: the comment IS
  // the corpus, deliberately. Block comments are stripped as blocks first (mode
  // 1b) and only then line comments, so a /** */ continuation line cannot slip
  // a date past this. The test file itself is never scanned - it is full of
  // dates by necessity, and scanning it would be mode 7.
  const src = Deno.readTextFileSync(new URL("../lib/ai-usage.ts", import.meta.url));

  const held = new Set<string>();
  for (const price of Object.values(MODEL_PRICES)) {
    held.add(price.checkedOn);
    if (price.provisionalUntil) held.add(price.provisionalUntil);
  }

  // Comment text only: block comments as blocks, then whole-line // comments,
  // then trailing // on a code line.
  const blocks = src.match(/\/\*[\s\S]*?\*\//g) ?? [];
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "\n");
  const lineComments = codeOnly
    .split("\n")
    .map((line) => {
      const at = line.indexOf("//");
      return at === -1 ? "" : line.slice(at);
    })
    .filter((s) => s.length > 0);

  const prose = [...blocks, ...lineComments].join("\n");
  const found = prose.match(ANY_ISO_DATE) ?? [];

  for (const date of found) {
    assert(
      held.has(date),
      `ai-usage.ts prose names the date ${date}, which no MODEL_PRICES entry ` +
        `holds as a checkedOn or provisionalUntil value. A dated rate claim in a ` +
        `comment is exactly what US-3342 was: it cannot expire, because nothing ` +
        `reads it. Put the date in the table or take it out of the sentence.`,
    );
  }
});

Deno.test("US-3342: every model this build can route to has a price", () => {
  // Same union as ai-effort-model-match_test.ts: if an operator can point
  // DEFAULT_AI_MODEL, GRADING_COMPOSITE_MODEL or CONTENT_MODEL_<KIND> at it,
  // its spend has to land in the ledger as money. An unpriced model records
  // tokens at cost 0 - not an error anywhere, just a model that looks free.
  const routable = new Set<string>([
    ...CURRENT_MODEL_IDS,
    ...CONTENT_MODEL_ALLOWLIST_FOR_TESTS,
    ...GRADING_MODEL_ALLOWLIST,
  ]);

  for (const model of routable) {
    // Non-Anthropic ids (gpt-image-1) are priced in system_settings only, by
    // design - see newsletter-imagery.ts. This table is the Anthropic half.
    if (!model.startsWith("claude-")) continue;
    assert(
      MODEL_PRICES[model] !== undefined,
      `${model} is routable but has no MODEL_PRICES entry, so every call to it ` +
        `is recorded at $0.00`,
    );
  }
});

Deno.test("US-3342: the table is re-swept on a clock, not when someone notices", () => {
  const newest = Math.max(
    ...Object.values(MODEL_PRICES).map((p) => parseIsoDay(p.checkedOn)),
  );
  const ageDays = Math.floor((today() - newest) / DAY_MS);
  assert(
    ageDays <= PRICE_SWEEP_MAX_AGE_DAYS,
    `the newest checkedOn in MODEL_PRICES is ${ageDays} days old (limit ` +
      `${PRICE_SWEEP_MAX_AGE_DAYS}). Re-read the published pricing table, set ` +
      `every rate to what it says, and bump every checkedOn - the sweep, not ` +
      `the one model you came here for.`,
  );
});

Deno.test("US-3342: Sonnet 5 is cheaper than Sonnet 4.6, and costs what it costs", () => {
  const s5 = MODEL_PRICES["claude-sonnet-5"];
  const s46 = MODEL_PRICES["claude-sonnet-4-6"];
  assert(s5 !== undefined && s46 !== undefined);

  // The headline of the story, as a relation rather than a remembered number:
  // a newer Sonnet priced identically to the one it replaced is the tell that
  // nobody checked. Both halves, because input and output moved together.
  assert(
    s5.inputPerMTok < s46.inputPerMTok,
    `Sonnet 5 input ($${s5.inputPerMTok}) is not below Sonnet 4.6 ($${s46.inputPerMTok})`,
  );
  assert(
    s5.outputPerMTok < s46.outputPerMTok,
    `Sonnet 5 output ($${s5.outputPerMTok}) is not below Sonnet 4.6 ($${s46.outputPerMTok})`,
  );

  // End to end through the priced path, so a correct table with a broken
  // computeCostUsd still fails: 1 MTok in + 1 MTok out at $2/$10.
  assertEquals(
    computeCostUsd({
      model: "claude-sonnet-5",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    }),
    12,
  );
});

Deno.test("US-3342: the cache multipliers are the ones the table's models use", () => {
  // CACHE_WRITE_MULTIPLIER / CACHE_READ_MULTIPLIER are module-level constants,
  // so they are a claim about EVERY model in the table, not about one. It holds
  // for the Opus / Sonnet / Haiku families (1.25x write, 0.1x read) and breaks
  // for Fable and Mythos, which read cache at 0.025x. Adding one of those here
  // without moving the read multiplier onto ModelPrice would over-bill its cache
  // reads fourfold, so the table refuses them until that is done.
  for (const model of Object.keys(MODEL_PRICES)) {
    assert(
      !/fable|mythos/i.test(model),
      `${model} prices cache reads at a different multiple of input than the ` +
        `module-level CACHE_READ_MULTIPLIER. Move the read multiplier onto ` +
        `ModelPrice before adding it.`,
    );
  }

  // A cache read costs a tenth of input: 10 MTok read at $2/MTok = $2.
  assertEquals(
    computeCostUsd({
      model: "claude-sonnet-5",
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 10_000_000,
    }),
    2,
  );
});
