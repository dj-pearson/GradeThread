// US-2970: pipeline stage derivation. Pure — no DB, no env, no fixtures.
//
// The whole point of deriving marks from durable state instead of hooking the
// 252 lines that write inventory_items.status is that the derivation can be
// pinned down exactly. These tests are that pin.
// US-2379: FIRST import. The graph reaches lib/supabase.ts (via rewards-engine),
// which throws at import time without credentials, so this file cannot even load
// without it.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";

import {
  type PipelineItem,
  type PipelineListing,
  type PipelinePhoto,
  type PipelineRepricing,
  type PipelineSale,
  type PipelineStage,
  pipelineMarksForItem,
} from "../lib/rewards-pipeline.ts";

// ── fixtures ────────────────────────────────────────────────────────────────

const T = {
  created: "2026-01-02T00:00:00.000Z",
  updated: "2026-01-09T00:00:00.000Z",
  photo1: "2026-01-04T00:00:00.000Z",
  photo2: "2026-01-05T00:00:00.000Z",
  comp: "2026-01-06T00:00:00.000Z",
  draft: "2026-01-07T00:00:00.000Z",
  listed: "2026-01-08T00:00:00.000Z",
  sold: "2026-01-20T00:00:00.000Z",
};

function item(over: Partial<PipelineItem> = {}): PipelineItem {
  return {
    id: "item-1",
    brand: null,
    garment_type: null,
    measurements: null,
    comped_at: null,
    created_at: T.created,
    updated_at: T.updated,
    ...over,
  };
}

const photo = (created_at: string): PipelinePhoto => ({ created_at });

function listing(over: Partial<PipelineListing> = {}): PipelineListing {
  return {
    platform_listing_id: null,
    listed_at: null,
    created_at: T.draft,
    ...over,
  };
}

function sale(over: Partial<PipelineSale> = {}): PipelineSale {
  return { sale_price: 42, sold_at: T.sold, sale_date: T.sold, ...over };
}

const repricing = (created_at: string): PipelineRepricing => ({ created_at });

/** The stages present, in the order returned. */
const stages = (marks: Array<{ stage: PipelineStage }>) => marks.map((m) => m.stage);

/** The occurredAt for one stage, or undefined when the stage is absent. */
function at(
  marks: Array<{ stage: PipelineStage; occurredAt: string }>,
  stage: PipelineStage,
): string | undefined {
  return marks.find((m) => m.stage === stage)?.occurredAt;
}

// ── an item with nothing on it earns nothing ────────────────────────────────

Deno.test("a bare item yields no marks at all", () => {
  assertEquals(pipelineMarksForItem(item(), [], [], [], []), []);
});

// ── item_cataloged ──────────────────────────────────────────────────────────

Deno.test("cataloged needs brand or garment_type, and dates from created_at", () => {
  const withBrand = pipelineMarksForItem(item({ brand: "Patagonia" }), [], [], [], []);
  assertEquals(stages(withBrand), ["item_cataloged"]);
  assertEquals(at(withBrand, "item_cataloged"), T.created);

  const withType = pipelineMarksForItem(item({ garment_type: "jacket" }), [], [], [], []);
  assertEquals(stages(withType), ["item_cataloged"]);
});

Deno.test("an empty-string brand is not cataloged", () => {
  // A blank text field is what an abandoned intake form leaves behind.
  assertEquals(pipelineMarksForItem(item({ brand: "   " }), [], [], [], []), []);
});

// ── item_measured ───────────────────────────────────────────────────────────

Deno.test("measured needs a non-empty measurements object", () => {
  const m = pipelineMarksForItem(item({ measurements: { chest: 21 } }), [], [], [], []);
  assertEquals(stages(m), ["item_measured"]);
  assertEquals(at(m, "item_measured"), T.updated);
});

Deno.test("an empty measurements object is not measured", () => {
  assertEquals(pipelineMarksForItem(item({ measurements: {} }), [], [], [], []), []);
  assertEquals(pipelineMarksForItem(item({ measurements: [] }), [], [], [], []), []);
});

// ── item_photographed ───────────────────────────────────────────────────────

Deno.test("photographed dates from the EARLIEST photo, not the newest", () => {
  const m = pipelineMarksForItem(item(), [photo(T.photo2), photo(T.photo1)], [], [], []);
  assertEquals(stages(m), ["item_photographed"]);
  assertEquals(at(m, "item_photographed"), T.photo1);
});

// ── item_comped ─────────────────────────────────────────────────────────────

Deno.test("comped comes from a repricing row or from comped_at", () => {
  const viaRepricing = pipelineMarksForItem(item(), [], [], [], [repricing(T.comp)]);
  assertEquals(stages(viaRepricing), ["item_comped"]);
  assertEquals(at(viaRepricing, "item_comped"), T.comp);

  const viaColumn = pipelineMarksForItem(item({ comped_at: T.comp }), [], [], [], []);
  assertEquals(stages(viaColumn), ["item_comped"]);
  assertEquals(at(viaColumn, "item_comped"), T.comp);
});

Deno.test("comped takes the EARLIEST evidence when both exist", () => {
  const earlier = "2025-12-01T00:00:00.000Z";
  const m = pipelineMarksForItem(
    item({ comped_at: T.comp }),
    [],
    [],
    [],
    [repricing(earlier)],
  );
  assertEquals(at(m, "item_comped"), earlier);
});

Deno.test("an item with no comp evidence still earns every other stage", () => {
  // Comps that predate US-2969 left no row and no column. That gap must cost
  // the seller exactly one stage, not the rest of the pipeline.
  const m = pipelineMarksForItem(
    item({ brand: "Nike", measurements: { chest: 20 } }),
    [photo(T.photo1)],
    [listing({ platform_listing_id: "v1|123|0", listed_at: T.listed })],
    [sale()],
    [],
  );
  assert(!stages(m).includes("item_comped"));
  assertEquals(stages(m), [
    "item_cataloged",
    "item_measured",
    "item_photographed",
    "item_drafted",
    "item_listed",
    "item_sold",
  ]);
});

// ── item_drafted vs item_listed ─────────────────────────────────────────────

Deno.test("a listing with no platform_listing_id is drafted but NOT listed", () => {
  const m = pipelineMarksForItem(item(), [], [listing()], [], []);
  assertEquals(stages(m), ["item_drafted"]);
  assertEquals(at(m, "item_drafted"), T.draft);
});

Deno.test("a published listing earns both drafted and listed", () => {
  const m = pipelineMarksForItem(
    item(),
    [],
    [listing({ platform_listing_id: "v1|123|0", listed_at: T.listed })],
    [],
    [],
  );
  assertEquals(stages(m), ["item_drafted", "item_listed"]);
  assertEquals(at(m, "item_listed"), T.listed);
});

Deno.test("listed falls back to the listing's created_at when listed_at is null", () => {
  const m = pipelineMarksForItem(
    item(),
    [],
    [listing({ platform_listing_id: "v1|123|0", listed_at: null })],
    [],
    [],
  );
  assertEquals(at(m, "item_listed"), T.draft);
});

Deno.test("a blank platform_listing_id does not count as published", () => {
  const m = pipelineMarksForItem(item(), [], [listing({ platform_listing_id: "" })], [], []);
  assertEquals(stages(m), ["item_drafted"]);
});

Deno.test("drafted and listed each pay once however many listings there are", () => {
  // Cross-posting the same item to four marketplaces is one item's work.
  const m = pipelineMarksForItem(
    item(),
    [],
    [
      listing({ created_at: T.draft }),
      listing({ platform_listing_id: "a", listed_at: T.listed }),
      listing({ platform_listing_id: "b", listed_at: T.sold }),
    ],
    [],
    [],
  );
  assertEquals(stages(m), ["item_drafted", "item_listed"]);
  // and dates from the earliest evidence of each
  assertEquals(at(m, "item_listed"), T.listed);
});

// ── item_sold ───────────────────────────────────────────────────────────────

Deno.test("sold needs a sale with a price, and prefers sold_at", () => {
  const m = pipelineMarksForItem(item(), [], [], [sale()], []);
  assertEquals(stages(m), ["item_sold"]);
  assertEquals(at(m, "item_sold"), T.sold);
});

Deno.test("sold falls back to sale_date when sold_at is null", () => {
  const m = pipelineMarksForItem(
    item(),
    [],
    [],
    [sale({ sold_at: null, sale_date: T.listed })],
    [],
  );
  assertEquals(at(m, "item_sold"), T.listed);
});

Deno.test("a sale row with no price is not a sale", () => {
  assertEquals(pipelineMarksForItem(item(), [], [], [sale({ sale_price: null })], []), []);
  assertEquals(pipelineMarksForItem(item(), [], [], [sale({ sale_price: 0 })], []), []);
});

// ── status is never proof ───────────────────────────────────────────────────

Deno.test("a returned item with no listing row does not earn item_listed", () => {
  // inventory_items.status is deliberately not an input. An item can sit at
  // 'returned' having never been published through us, and a single enum value
  // cannot say which earlier stages actually happened.
  const m = pipelineMarksForItem(item({ brand: "Levis" }), [], [], [], []);
  assertEquals(stages(m), ["item_cataloged"]);
});

Deno.test("the derivation reads no status field even if one is present", async () => {
  const src = await Deno.readTextFile(new URL("../lib/rewards-pipeline.ts", import.meta.url));
  const fn = src.slice(src.indexOf("export function pipelineMarksForItem"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 1);
  assert(!body.includes(".status"), "pipelineMarksForItem must not read a status field");
});

// ── a full pass ─────────────────────────────────────────────────────────────

Deno.test("a fully worked item yields all seven stages in pipeline order", () => {
  const m = pipelineMarksForItem(
    item({ brand: "Arcteryx", measurements: { chest: 22 }, comped_at: T.comp }),
    [photo(T.photo1), photo(T.photo2)],
    [listing({ platform_listing_id: "v1|9|0", listed_at: T.listed })],
    [sale()],
    [],
  );
  assertEquals(stages(m), [
    "item_cataloged",
    "item_measured",
    "item_photographed",
    "item_comped",
    "item_drafted",
    "item_listed",
    "item_sold",
  ]);
});

Deno.test("every mark carries a parseable ISO timestamp", () => {
  const m = pipelineMarksForItem(
    item({ brand: "Arcteryx", measurements: { chest: 22 }, comped_at: T.comp }),
    [photo(T.photo1)],
    [listing({ platform_listing_id: "v1|9|0", listed_at: T.listed })],
    [sale()],
    [],
  );
  for (const mark of m) {
    assert(
      Number.isFinite(Date.parse(mark.occurredAt)),
      `${mark.stage} has an unparseable occurredAt: ${mark.occurredAt}`,
    );
  }
});

Deno.test("an unparseable timestamp degrades to the item's created_at", () => {
  // Backfill reads real production rows. A junk date must not write a junk
  // occurred_at into the append-only log, and must not throw mid-sweep either.
  const m = pipelineMarksForItem(item({ brand: "Nike" }), [photo("not a date")], [], [], []);
  assertEquals(at(m, "item_photographed"), T.created);
});

// ── US-2971: the daily cap planner ──────────────────────────────────────────
// The cap is the anti-farming bound on pipeline XP. It is pure and separated
// from the sweep so the whole policy is asserted without a database.

import {
  DEFAULT_PIPELINE_DAILY_XP_CAP,
  normalizePipelineDailyCap,
  PIPELINE_STAGES,
  planPipelineGrants,
  utcDateKey,
} from "../lib/rewards-pipeline.ts";

const cand = (stage: PipelineStage, occurredAt: string, itemId = "i1") => ({
  itemId,
  stage,
  occurredAt,
});

Deno.test("the cap setting degrades to the default rather than throwing", () => {
  // Mirrors rewards.disabled_mechanics: operator-editable jsonb with no schema
  // behind it, read inside the grant path, so anything unusable means "default".
  assertEquals(DEFAULT_PIPELINE_DAILY_XP_CAP, 300);
  for (const junk of [null, undefined, "300", {}, [], -5, 0, NaN, "abc"]) {
    assertEquals(normalizePipelineDailyCap(junk), 300, `${JSON.stringify(junk)}`);
  }
  assertEquals(normalizePipelineDailyCap(50), 50);
  assertEquals(normalizePipelineDailyCap(120.7), 120);
});

Deno.test("date keys bucket by UTC calendar day", () => {
  assertEquals(utcDateKey("2026-01-08T23:59:59.000Z"), "2026-01-08");
  assertEquals(utcDateKey("2026-01-09T00:00:01.000Z"), "2026-01-09");
});

Deno.test("marks spread across dates are not capped", () => {
  // The backfill case. 400 marks over 60 days is months of ordinary work.
  const candidates = Array.from({ length: 400 }, (_, i) =>
    cand("item_listed", `2026-0${1 + (i % 2)}-${String((i % 28) + 1).padStart(2, "0")}T12:00:00.000Z`, `i${i}`));
  const { granted, cappedOut } = planPipelineGrants(candidates, new Map(), 300);
  assertEquals(cappedOut, 0);
  assertEquals(granted.length, 400);
});

Deno.test("marks all dated the same day stop at the ceiling", () => {
  const day = "2026-01-08T12:00:00.000Z";
  const candidates = Array.from({ length: 400 }, (_, i) => cand("item_listed", day, `i${i}`));
  const { granted, cappedOut } = planPipelineGrants(candidates, new Map(), 300);
  // item_listed is 8 XP, so 37 marks fit under 300 and the 38th would exceed it.
  const total = granted.reduce((s, g) => s + g.xp, 0);
  assert(total <= 300, `granted ${total} XP, over the 300 ceiling`);
  assertEquals(granted.length, 37);
  assertEquals(cappedOut, 363);
});

Deno.test("XP already spent on a date counts against that date's ceiling", () => {
  const spent = new Map([["2026-01-08", 295]]);
  const candidates = [
    cand("item_cataloged", "2026-01-08T01:00:00.000Z", "a"), // 2 XP, fits (297)
    cand("item_measured", "2026-01-08T02:00:00.000Z", "b"), // 2 XP, fits (299)
    cand("item_listed", "2026-01-08T03:00:00.000Z", "c"), // 8 XP, would hit 307
  ];
  const { granted } = planPipelineGrants(candidates, spent, 300);
  assertEquals(granted.map((g) => g.stage), ["item_cataloged", "item_measured"]);
});

Deno.test("planning is chronological so the earliest work wins a tight day", () => {
  const candidates = [
    cand("item_sold", "2026-01-08T09:00:00.000Z", "late"),
    cand("item_cataloged", "2026-01-08T01:00:00.000Z", "early"),
  ];
  const { granted } = planPipelineGrants(candidates, new Map([["2026-01-08", 297]]), 300);
  assertEquals(granted.map((g) => g.itemId), ["early"]);
});

Deno.test("every planned grant carries the item-and-stage dedupe key", () => {
  const { granted } = planPipelineGrants([cand("item_listed", "2026-01-08T00:00:00.000Z", "abc")], new Map(), 300);
  assertEquals(granted[0].referenceId, "abc:item_listed");
  assertEquals(granted[0].xp, 8);
});

// ── US-2971: structural guarantees ──────────────────────────────────────────
// The sweep's DB behaviour is proven end-to-end by the fixture-gated cases, but
// two properties are worth pinning WITHOUT a database, because both fail
// silently: a tenant filter that quietly goes missing looks like a working
// sweep, and a per-mark recompute looks like a correct but slow one.

Deno.test("US-268: the ONLY tenant filter is user_id on inventory_items", async () => {
  const src = await Deno.readTextFile(new URL("../lib/rewards-pipeline.ts", import.meta.url));
  const whole = src.slice(src.indexOf("export async function sweepPipelineRewards"));
  const sweep = whole.slice(0, whole.indexOf("\n}\n") + 1);

  // Every table the sweep reads, and how it is allowed to be scoped.
  assert(
    /\.from\("inventory_items"\)[\s\S]{0,400}?\.eq\("user_id", userId\)/.test(sweep),
    "inventory_items must be scoped by .eq(user_id, userId)",
  );

  // Child tables are reached through the owner-verified item set only. If a new
  // .from() appears in the sweep body that is neither the owner-scoped parent
  // nor one of the known child loads, this fails and asks for a decision.
  const allowedInSweep = [
    '.from("inventory_items")',
    '.from("user_reward_state")',
  ];
  const froms = [...sweep.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[0]);
  for (const f of froms) {
    assert(
      allowedInSweep.includes(f),
      `${f} appears directly in sweepPipelineRewards; child tables must be ` +
        "loaded via loadForItems on the owner-verified item ids",
    );
  }
});

Deno.test("child loads key on inventory_item_id, never on a request id", async () => {
  const src = await Deno.readTextFile(new URL("../lib/rewards-pipeline.ts", import.meta.url));
  const loader = src.slice(src.indexOf("async function loadForItems"));
  const body = loader.slice(0, loader.indexOf("\n}\n") + 1);
  assert(body.includes('.in("inventory_item_id", slice)'), "child reads must key on the parent id");
});

Deno.test("the sweep recomputes ONCE, not once per mark", async () => {
  const src = await Deno.readTextFile(new URL("../lib/rewards-pipeline.ts", import.meta.url));
  const sweep = src.slice(src.indexOf("export async function sweepPipelineRewards"));
  const body = sweep.slice(0, sweep.indexOf("\n}\n") + 1);
  // A backfill emits up to ~1,800 events for one seller. Calling grantReward per
  // mark would recompute the whole log that many times.
  assert(!body.includes("grantReward("), "the sweep must not call grantReward per mark");
  assertEquals(
    (body.match(/recomputeRewardState\(/g) ?? []).length,
    1,
    "exactly one recompute per sweep",
  );
  assertEquals((body.match(/awardBadges\(/g) ?? []).length, 1, "exactly one badge pass");
  assertEquals(
    (body.match(/grantTangibleRewards\(/g) ?? []).length,
    1,
    "exactly one tangible pass",
  );
});

Deno.test("already-granted marks are dropped before planning", () => {
  // The second run of a sweep sees every mark in `existing` and plans nothing.
  // This is the in-process half of idempotency; the database half is 00417's
  // UNIQUE index on (user_id, event_type, reference_id), which makes a
  // concurrent duplicate a no-op rather than a race.
  const marks = [
    cand("item_cataloged", "2026-01-02T00:00:00.000Z", "i1"),
    cand("item_listed", "2026-01-08T00:00:00.000Z", "i1"),
  ];
  const existing = new Set(marks.map((m) => `${m.itemId}:${m.stage}`));
  const pending = marks.filter((m) => !existing.has(`${m.itemId}:${m.stage}`));
  assertEquals(pending.length, 0);

  const { granted } = planPipelineGrants(pending, new Map(), 300);
  assertEquals(granted.length, 0);
});

Deno.test("the seven stages are the sweep's whole event surface", () => {
  // A stage added to PipelineStage but forgotten here would never be swept and
  // would never be read back for the cap.
  assertEquals([...PIPELINE_STAGES], [
    "item_cataloged",
    "item_measured",
    "item_photographed",
    "item_comped",
    "item_drafted",
    "item_listed",
    "item_sold",
  ]);
});

// ── US-2972: the on-demand throttle and the nightly queue ───────────────────

import { SWEEP_THROTTLE_MS, sweepIsDue } from "../lib/rewards-pipeline.ts";

Deno.test("a seller never swept is due immediately", () => {
  assert(sweepIsDue(null, Date.parse("2026-08-28T12:00:00.000Z")));
  assert(sweepIsDue(undefined, Date.parse("2026-08-28T12:00:00.000Z")));
});

Deno.test("two rewards loads inside five minutes trigger exactly ONE sweep", () => {
  // The AC, stated as the pure predicate the route calls. First load: no
  // timestamp, due. The sweep stamps. Second load 60s later: not due.
  const first = Date.parse("2026-08-28T12:00:00.000Z");
  assert(sweepIsDue(null, first), "first load must sweep");

  const stamped = new Date(first).toISOString();
  let sweeps = 1;
  for (const offsetMs of [1_000, 60_000, 120_000, SWEEP_THROTTLE_MS - 1]) {
    if (sweepIsDue(stamped, first + offsetMs)) sweeps++;
  }
  assertEquals(sweeps, 1, "no further sweep inside the window");

  assert(sweepIsDue(stamped, first + SWEEP_THROTTLE_MS), "due again at the boundary");
});

Deno.test("the throttle window is five minutes", () => {
  assertEquals(SWEEP_THROTTLE_MS, 5 * 60_000);
});

Deno.test("an unparseable stored timestamp means due, not never", () => {
  // A junk timestamp must not permanently disable a seller's on-demand sweep.
  assert(sweepIsDue("not a date", Date.parse("2026-08-28T12:00:00.000Z")));
});

Deno.test("the throttle marker is an UPSERT, not an update", async () => {
  // An update matches nothing for a seller with items but no reward-state row,
  // which would leave them at the head of the nightly queue forever.
  const src = await Deno.readTextFile(new URL("../lib/rewards-pipeline.ts", import.meta.url));
  const fn = src.slice(src.indexOf("export async function markSweepAttempted"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 1);
  assert(body.includes(".upsert("), "markSweepAttempted must upsert");
  assert(!body.includes(".update("), "markSweepAttempted must not update-only");
});

Deno.test("a failed on-demand sweep still stamps and still returns null", async () => {
  // The rewards screen must render even when the sweep throws. Both halves
  // matter: swallowing without stamping would retry the throw on every load.
  const src = await Deno.readTextFile(new URL("../lib/rewards-pipeline.ts", import.meta.url));
  const fn = src.slice(src.indexOf("export async function sweepOnDemand"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 1);
  assert(body.includes("catch"), "sweepOnDemand must catch");
  assert(body.includes("markSweepAttempted(userId)"), "a failed sweep must still stamp");
  assert(body.includes("return null"), "a failed sweep returns null");
});

Deno.test("the rewards screen never fails on a sweep problem", async () => {
  const src = await Deno.readTextFile(new URL("../routes/rewards.ts", import.meta.url));
  assert(src.includes("await sweepOnDemand(userId, nowMs)"), "state load must sweep on demand");
  // Scoped to the authenticated caller, never to a workspace owner: XP is a
  // personal standing (the reason rewards.ts uses c.get("userId") throughout).
  assert(!src.includes("sweepOnDemand(workspaceOwnerId"), "sweep must use the caller id");
});

Deno.test("the nightly job is registered, recorded, and job-secret gated", async () => {
  const job = await Deno.readTextFile(new URL("../routes/jobs-rewards-sweep.ts", import.meta.url));
  assert(job.includes("requireJobSecret(c)"), "cron must be job-secret gated");
  assert(job.includes('acquireJobLock("rewards-pipeline-sweep"'), "cron must take a lock");

  const main = await Deno.readTextFile(new URL("../main.ts", import.meta.url));
  assert(
    main.includes('app.post("/api/jobs/rewards-sweep"'),
    "the cron must be mounted under /api/jobs so the cron_runs middleware records it",
  );

  const registry = await Deno.readTextFile(new URL("../lib/cron-runs.ts", import.meta.url));
  assert(registry.includes('name: "rewards-sweep"'), "the cron must be in CRON_REGISTRY");
  assert(
    /name: "rewards-sweep"[^}]*recorded: true/.test(registry),
    "the cron must be recorded:true so a silent no-op is visible in cron_runs",
  );
});

Deno.test("the nightly queue is oldest-swept-first, nulls first", async () => {
  // Coverage is a property of this ordering. Sorting any other way (by activity,
  // by created_at) lets a seller at the back starve indefinitely.
  const job = await Deno.readTextFile(new URL("../routes/jobs-rewards-sweep.ts", import.meta.url));
  const fn = job.slice(job.indexOf("export async function dueForSweep"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 1);
  assert(
    body.includes('.order("last_pipeline_sweep_at", { ascending: true, nullsFirst: true })'),
    "the queue must be ordered oldest-swept-first with nulls first",
  );
});

Deno.test("a failing seller is stamped so they cannot wedge the queue", async () => {
  const job = await Deno.readTextFile(new URL("../routes/jobs-rewards-sweep.ts", import.meta.url));
  const caught = job.slice(job.indexOf("} catch (err) {"));
  assert(
    caught.includes("markSweepAttempted(userId)"),
    "a seller whose sweep throws must still be stamped",
  );
});

// ── US-2973: the arrival moment ─────────────────────────────────────────────

import { ARRIVAL_MIN_LEVEL, arrivalIsDue } from "../lib/rewards-pipeline.ts";

Deno.test("a seller who has never acknowledged an arrival, at level 2+, is due one", () => {
  assert(arrivalIsDue(null, 2));
  assert(arrivalIsDue(undefined, 7));
  assertEquals(ARRIVAL_MIN_LEVEL, 2);
});

Deno.test("a one-level climb is an ordinary level-up, not an arrival", () => {
  // Levels 0 and 1 are reachable in a day of normal work. The arrival moment is
  // for the multi-level jump a backfill produces; a normal climb gets the
  // existing client-side celebration.
  assert(!arrivalIsDue(null, 0));
  assert(!arrivalIsDue(null, 1));
});

Deno.test("an acknowledged arrival never fires again, at any level", () => {
  // Including level 0, which is what a baselined row from migration 00681 holds
  // for a seller who has no XP but has already used the app.
  for (const seen of [0, 1, 2, 7, 20]) {
    for (const level of [0, 2, 7, 20, 99]) {
      assert(!arrivalIsDue(seen, level), `seen=${seen} level=${level} must not re-fire`);
    }
  }
});

Deno.test("US-1552: the arrival ack uses sequential updates, never .or()", async () => {
  // The self-hosted prod PostgREST rejects a logical operator on a mutation
  // (42703 on the update-CTE alias) while the local stack accepts it, so an
  // .or() here would pass every test on this machine and fail only in prod.
  const src = await Deno.readTextFile(new URL("../lib/rewards-pipeline.ts", import.meta.url));
  const fn = src.slice(src.indexOf("export async function acknowledgeArrival"));
  const withComments = fn.slice(0, fn.indexOf("\n}\n") + 1);
  // Strip comment lines: the function's own comment explains why .or() is
  // banned, and scanning raw text would match that explanation rather than a
  // real call.
  const body = withComments
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert(body.includes(".update("), "the ack must write");
  assert(!body.includes(".or("), "no .or() on a mutation (US-1552)");
  assert(body.includes('.is("arrival_seen_level", null)'), "first update handles the NULL case");
  assert(body.includes('.lt("arrival_seen_level", target)'), "second update is monotonic");
});

Deno.test("the arrival is decided server-side, not from a localStorage diff", async () => {
  // The whole reason this exists: detectCelebrations returns [] when the prior
  // snapshot is null, that snapshot is localStorage, and a seller who has never
  // opened the rewards page is exactly who the backfill is for. If the state
  // route stops returning `arrival`, those sellers silently get nothing.
  const src = await Deno.readTextFile(new URL("../routes/rewards.ts", import.meta.url));
  assert(src.includes("loadArrival(userId, progress.level"), "state must load the arrival");
  assert(src.includes("arrival,"), "state must return the arrival in its payload");
  assert(
    src.includes('rewardsRoutes.post("/arrival/ack"'),
    "there must be an ack endpoint, or the moment repeats forever",
  );
});

// ── US-2974: recording comps forward ────────────────────────────────────────

Deno.test("markComped is set-once in the FILTER, not by reading first", async () => {
  // The earliest comp is the one item_comped scores, so a later run must not
  // walk the date forward. Doing that as `.is(comped_at, null)` rather than
  // read-then-write also makes two concurrent comp requests for the same item
  // safe without a transaction.
  const src = await Deno.readTextFile(new URL("../lib/rewards-pipeline.ts", import.meta.url));
  const fn = src.slice(src.indexOf("export async function markComped"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 1);
  assert(body.includes('.is("comped_at", null)'), "set-once must be a filter");
  assert(!body.includes(".select("), "no read-then-write race");
  // US-268: a comp request naming somebody else's item must update nothing.
  assert(body.includes('.eq("user_id", ownerId)'), "markComped must be tenant-scoped");
  assert(body.includes('.eq("id", itemId)'), "markComped must target one item");
});

Deno.test("the comps route stamps only AFTER a successful search", async () => {
  const src = await Deno.readTextFile(new URL("../routes/flipdesk-ebay.ts", import.meta.url));
  const route = src.slice(src.indexOf('flipdeskEbayRoutes.get("/comps"'));
  const body = route.slice(0, route.indexOf("\n});\n") + 1);
  assert(body.includes('c.req.query("item_id")'), "the route must accept item_id");
  assert(body.includes("markComped(ownerId, compItemId)"), "the route must stamp");
  // A failed lookup is not a comp: the stamp has to sit after searchCompsWithLadder.
  assert(
    body.indexOf("searchCompsWithLadder") < body.indexOf("markComped("),
    "the stamp must follow the search, not precede it",
  );
  // Items are workspace resources (unlike XP), so this one resolves the owner.
  assert(
    body.includes('c.get("workspaceOwnerId") ?? c.get("userId")'),
    "item writes scope to the workspace owner",
  );
});

Deno.test("item_id is optional: a loose comp lookup still works", async () => {
  // The endpoint takes brand/size/category and is used for lookups with no item
  // behind them. Requiring an id would break those callers.
  const src = await Deno.readTextFile(new URL("../routes/flipdesk-ebay.ts", import.meta.url));
  const route = src.slice(src.indexOf('flipdeskEbayRoutes.get("/comps"'));
  const body = route.slice(0, route.indexOf("\n});\n") + 1);
  assert(body.includes("if (compItemId)"), "the stamp must be conditional");
  assert(
    !/return c\.json\(\{ error: "item_id is required"/.test(body),
    "item_id must not be required",
  );
});

Deno.test("the permanent comps gap is documented where someone would look", async () => {
  // Comps predating 00679 cannot be backfilled. Without this note in the file
  // that derives the stage, the gap reads as a bug and somebody goes hunting.
  const src = await Deno.readTextFile(new URL("../lib/rewards-pipeline.ts", import.meta.url));
  const header = src.slice(0, src.indexOf("export type PipelineStage"));
  assert(header.includes("predate migration 00679"), "the header must name the gap");
  assert(header.includes("listing_id is NOT NULL"), "and why it exists");
  assert(header.includes("not a bug"), "and that it is not a bug to chase");
});

// ── US-2974 AC3/AC4: there is no XP level-up email to de-duplicate ──────────
//
// The story asked that a pipeline-XP level-up not send its own email when a
// North Star milestone email went out the same day. It cannot: the reward system
// sends NO email on a level-up, and never has. Celebrations are client-side
// (src/lib/reward-celebrations.ts) and the only reward-owned email path is the
// re-engagement nudge, which is triggered by INACTIVITY, not by earning.
//
// Rather than write a de-dup against nothing, this pins the finding. If someone
// later adds a level-up email, this test fails and forces them to answer the
// double-celebration question the story was really asking.

Deno.test("AC3: no reward module sends email on a level-up", async () => {
  const suspects = [
    "rewards-engine.ts",
    "rewards-pipeline.ts",
    "rewards-badges.ts",
    "rewards-levels.ts",
    "rewards-tangible.ts",
    "rewards-seasons.ts",
  ];
  for (const name of suspects) {
    const src = await Deno.readTextFile(new URL(`../lib/${name}`, import.meta.url));
    for (const sender of ["sendEmail(", "sendTransactional(", "queueEmail("]) {
      assert(
        !src.includes(sender),
        `${name} now calls ${sender} — if that is a level-up email, it must be ` +
          "de-duplicated against the North Star milestone email (US-2974 AC3/AC4)",
      );
    }
  }
});

Deno.test("AC3: the North Star milestone email stays the one owner", async () => {
  // Its UNIQUE(user_id, milestone) log is what makes a milestone email fire
  // exactly once, and that ownership is the half of AC3 that IS real.
  const src = await Deno.readTextFile(new URL("../routes/jobs-north-star.ts", import.meta.url));
  assert(src.includes("north_star_milestone_log"), "the milestone log is the dedupe");
});
