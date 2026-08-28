// US-2970: pipeline stage derivation. Pure — no DB, no env, no fixtures.
//
// The whole point of deriving marks from durable state instead of hooking the
// 252 lines that write inventory_items.status is that the derivation can be
// pinned down exactly. These tests are that pin.
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
