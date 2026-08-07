// US-1862: Thrift Radar venue resolution.
//
// `radar-venues.ts` imports nothing that touches Supabase or the environment,
// so — like the US-1861 privacy primitives — every threshold, every tie-break
// and every merge decision is exercised here directly rather than through a
// route and a live Postgres.

import { assert, assertEquals } from "@std/assert";
import {
  candidateVenueDraft,
  cellCentre,
  cellNeighbors,
  DEFAULT_MERGE_RADIUS_METERS,
  haversineMeters,
  isPlaceholderVenueName,
  isRadarVenueChain,
  mergedCentroid,
  mergeSurvivor,
  normalizeChain,
  planVenueMerges,
  type RadarVenue,
  resolveNearestVenue,
} from "../lib/radar-venues.ts";
import { coarseCell } from "../lib/radar-privacy.ts";

function venue(over: Partial<RadarVenue> & { id: string }): RadarVenue {
  return {
    display_name: `Unnamed venue ${over.geohash ?? "dr5reg"}`,
    chain: "other",
    lat: 40.7128,
    lng: -74.006,
    geohash: "dr5reg",
    status: "candidate",
    merged_into_id: null,
    observation_count: 0,
    created_at: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

// ── Chain normalization ─────────────────────────────────────────────────────

Deno.test("normalizeChain: store-number and legal-entity variants fold together", () => {
  // The acceptance criterion, stated literally.
  assertEquals(normalizeChain("Goodwill Store #123"), "goodwill");
  assertEquals(normalizeChain("Goodwill Industries"), "goodwill");
  assertEquals(normalizeChain("GOODWILL of Central Michigan"), "goodwill");
  assertEquals(normalizeChain("good will store"), "goodwill");

  assertEquals(normalizeChain("Savers #7"), "savers");
  assertEquals(normalizeChain("Value Village"), "value_village");
  assertEquals(normalizeChain("The Salvation Army Family Store"), "salvation_army");
});

Deno.test("normalizeChain: Value Village is not folded into Savers", () => {
  // Same company, but a shopper reads them as two different stores, so the tags
  // stay distinct. A regression here would silently merge two chains' stats.
  assert(normalizeChain("Value Village") !== normalizeChain("Savers"));
});

Deno.test("normalizeChain: an unrecognised name is 'other', not a guess", () => {
  assertEquals(normalizeChain("Second Hand Rose"), "other");
  assertEquals(normalizeChain(""), "other");
  assertEquals(normalizeChain(null), "other");
  assertEquals(normalizeChain(undefined), "other");
  assertEquals(normalizeChain(12 as unknown as string), "other");
  assert(isRadarVenueChain("goodwill"));
  assert(!isRadarVenueChain("goodwill_industries"));
});

Deno.test("chain is shared; venue identity is not", () => {
  // Two Goodwills a mile apart share a chain tag and must NOT merge.
  const a = venue({ id: "a", chain: "goodwill", lat: 40.7128, lng: -74.006 });
  const b = venue({
    id: "b",
    chain: "goodwill",
    lat: 40.7128,
    lng: -74.026, // ~1.7 km east
  });
  assertEquals(a.chain, b.chain);
  assertEquals(planVenueMerges([a, b], DEFAULT_MERGE_RADIUS_METERS).length, 0);
});

// ── Cell geometry ───────────────────────────────────────────────────────────

Deno.test("cellCentre: decodes back inside the cell it came from", () => {
  const cell = coarseCell(40.712776, -74.005974, 6)!;
  const centre = cellCentre(cell)!;
  assert(centre);
  // Re-encoding the centre lands in the same cell — that is what makes the
  // centroid a property OF THE CELL rather than of the scan that produced it.
  assertEquals(coarseCell(centre.lat, centre.lng, 6), cell);
  // And it is genuinely coarse: within about a kilometre of the true fix.
  assert(haversineMeters(centre, { lat: 40.712776, lng: -74.005974 }) < 1000);
});

Deno.test("cellCentre: two different fixes in one cell give the IDENTICAL centroid", () => {
  // The privacy argument for storing a centroid at all: it cannot be read back
  // as "somebody stood here", because everyone in the cell produces this pair.
  const a = coarseCell(40.712776, -74.005974, 6)!;
  const b = coarseCell(40.712900, -74.006100, 6)!;
  assertEquals(a, b);
  assertEquals(cellCentre(a), cellCentre(b));
});

Deno.test("cellCentre: refuses a malformed cell", () => {
  assertEquals(cellCentre("a!b"), null);
  assertEquals(cellCentre(""), null);
});

Deno.test("cellNeighbors: the cell itself plus its eight neighbours", () => {
  const cell = coarseCell(40.712776, -74.005974, 6)!;
  const cells = cellNeighbors(cell);
  assertEquals(cells[0], cell);
  assertEquals(cells.length, 9);
  assertEquals(new Set(cells).size, 9);
  for (const c of cells) assertEquals(c.length, 6);

  // A fix just the other side of a boundary is reachable from the original
  // cell's neighbourhood — the whole reason the neighbourhood exists.
  const bounds = cellCentre(cell)!;
  const justOver = coarseCell(bounds.lat + 0.006, bounds.lng, 6)!;
  assert(cells.includes(justOver));
});

// ── Threshold resolution ────────────────────────────────────────────────────

Deno.test("resolveNearestVenue: inside the radius resolves, outside does not", () => {
  const store = venue({ id: "store", lat: 40.7128, lng: -74.006 });
  // ~110 m north.
  const near = { lat: 40.7138, lng: -74.006 };
  // ~1.1 km north.
  const far = { lat: 40.7228, lng: -74.006 };

  const hit = resolveNearestVenue(near, [store], 750);
  assert(hit);
  assertEquals(hit!.venue.id, "store");
  assert(hit!.distanceMeters < 750);

  assertEquals(resolveNearestVenue(far, [store], 750), null);
  // …and the threshold is genuinely the thing deciding it.
  assert(resolveNearestVenue(far, [store], 2000) !== null);
});

Deno.test("resolveNearestVenue: picks the NEAREST when several are in range", () => {
  const fix = { lat: 40.7128, lng: -74.006 };
  const closer = venue({ id: "closer", lat: 40.7130, lng: -74.006 });
  const further = venue({ id: "further", lat: 40.7160, lng: -74.006 });
  const hit = resolveNearestVenue(fix, [further, closer], 750);
  assertEquals(hit!.venue.id, "closer");
});

Deno.test("resolveNearestVenue: skips merged rows and survives an empty registry", () => {
  const fix = { lat: 40.7128, lng: -74.006 };
  const dead = venue({
    id: "dead",
    lat: 40.7128,
    lng: -74.006,
    status: "merged",
    merged_into_id: "alive",
  });
  assertEquals(resolveNearestVenue(fix, [dead], 750), null);
  // Cold start: nothing anywhere near, which is the case that must create a
  // candidate rather than throw.
  assertEquals(resolveNearestVenue(fix, [], 750), null);
});

Deno.test("resolveNearestVenue: an equidistant tie breaks deterministically", () => {
  // Cell-centre centroids make exact ties genuinely reachable, so the tie-break
  // is load-bearing rather than theoretical.
  // Identical centroids, which is precisely what two candidates born from the
  // same geohash cell would have.
  const fix = { lat: 40.7128, lng: -74.006 };
  const a = venue({ id: "aaa", lat: 40.7138, lng: -74.0061, observation_count: 2 });
  const b = venue({ id: "bbb", lat: 40.7138, lng: -74.0061, observation_count: 9 });
  const forward = resolveNearestVenue(fix, [a, b], 750)!;
  const reverse = resolveNearestVenue(fix, [b, a], 750)!;
  assertEquals(forward.venue.id, reverse.venue.id);
  assertEquals(forward.venue.id, "bbb", "more observations should win a tie");
});

// ── Candidate creation ──────────────────────────────────────────────────────

Deno.test("candidateVenueDraft: is built from a CELL and carries no fix", () => {
  const cell = coarseCell(40.712776, -74.005974, 6)!;
  const draft = candidateVenueDraft(cell)!;
  assert(draft);

  // The row's key set, asserted rather than spot-checked, so a coordinate
  // column added later has to be added here too (the US-1861 discipline).
  assertEquals(Object.keys(draft).sort(), [
    "centroid_source",
    "chain",
    "display_name",
    "geohash",
    "lat",
    "lng",
    "status",
  ]);
  assertEquals(draft.centroid_source, "cell");
  assertEquals(draft.status, "candidate");
  assertEquals(draft.chain, "other");
  assertEquals(draft.geohash, cell);
  assertEquals({ lat: draft.lat, lng: draft.lng }, cellCentre(cell));

  // The scan's own coordinate is nowhere in it.
  const serialized = JSON.stringify(draft);
  assert(!serialized.includes("40.712776"));
  assert(!serialized.includes("-74.005974"));
});

Deno.test("candidateVenueDraft: later scans in the cell converge on one draft", () => {
  // Two contributors, metres apart, same cell → byte-identical drafts, so the
  // partial unique index on (geohash, chain) folds them into one row.
  const a = candidateVenueDraft(coarseCell(40.712776, -74.005974, 6)!);
  const b = candidateVenueDraft(coarseCell(40.712900, -74.006100, 6)!);
  assertEquals(a, b);
});

Deno.test("candidateVenueDraft: refuses a cell the schema would reject", () => {
  // Three characters is below the CHECK's floor, nine is above its cap — either
  // would 23514 at insert time, and a finer cell would also break rule 4.
  assertEquals(candidateVenueDraft("dr5"), null);
  assertEquals(candidateVenueDraft("dr5reg123"), null);
  assertEquals(candidateVenueDraft("dr5ra!"), null);
});

Deno.test("isPlaceholderVenueName: only auto-derived names count", () => {
  const draft = candidateVenueDraft("dr5reg")!;
  assert(isPlaceholderVenueName(draft.display_name));
  assert(!isPlaceholderVenueName("Goodwill Store #123"));
  assert(!isPlaceholderVenueName(null));
});

// ── Merge ───────────────────────────────────────────────────────────────────

Deno.test("planVenueMerges: near-duplicate candidates merge, distant ones do not", () => {
  const a = venue({ id: "a", lat: 40.7128, lng: -74.006, observation_count: 3 });
  // ~110 m away — well inside the 250 m merge radius.
  const b = venue({ id: "b", lat: 40.7138, lng: -74.006, observation_count: 1 });
  // ~1.1 km away — outside it.
  const c = venue({ id: "c", lat: 40.7228, lng: -74.006 });

  const plans = planVenueMerges([a, b, c], 250);
  assertEquals(plans.length, 1);
  assertEquals(plans[0].keepId, "a");
  assertEquals(plans[0].mergeId, "b");
  assertEquals(plans[0].observationCount, 4);
  assert(plans[0].distanceMeters < 250);
});

Deno.test("planVenueMerges: confirmed beats candidate, then named, then busiest", () => {
  const near = { lat: 40.7132, lng: -74.006 };
  const candidate = venue({ id: "aaa", observation_count: 50, lat: 40.7128, lng: -74.006 });
  const confirmed = venue({
    id: "zzz",
    status: "confirmed",
    display_name: "Goodwill Store #123",
    chain: "goodwill",
    observation_count: 1,
    ...near,
  });
  // Different chains must not merge, so give the candidate the same chain to
  // isolate the survivor rule.
  const sameChain = { ...candidate, chain: "goodwill" as const };
  const plans = planVenueMerges([sameChain, confirmed], 250);
  assertEquals(plans.length, 1);
  assertEquals(plans[0].keepId, "zzz");

  // Named beats placeholder when both are candidates.
  const named = venue({ id: "zz2", display_name: "Ellen's Thrift", ...near });
  assertEquals(mergeSurvivor(candidate, named).id, "zz2");
  // And observations decide when neither of the above does.
  const busy = venue({ id: "zz3", observation_count: 99, ...near });
  assertEquals(mergeSurvivor(candidate, busy).id, "zz3");
});

Deno.test("planVenueMerges: is order-independent and never chains a merged row", () => {
  const a = venue({ id: "a", lat: 40.7128, lng: -74.006, observation_count: 5 });
  const b = venue({ id: "b", lat: 40.71295, lng: -74.006, observation_count: 2 });
  const c = venue({ id: "c", lat: 40.7131, lng: -74.006, observation_count: 1 });

  const forward = planVenueMerges([a, b, c], 250);
  const reverse = planVenueMerges([c, b, a], 250);
  assertEquals(forward, reverse);

  // All three collapse into one survivor, and no plan ever names a row that an
  // earlier plan already absorbed as its keeper.
  const absorbed = new Set(forward.map((p) => p.mergeId));
  assertEquals(absorbed.size, 2);
  for (const plan of forward) assert(!absorbed.has(plan.keepId) || plan.keepId === "a");
  assertEquals(new Set(forward.map((p) => p.keepId)).size, 1);
  assertEquals(forward.at(-1)!.observationCount, 8);
});

Deno.test("planVenueMerges: an already-merged row is not re-merged", () => {
  const a = venue({ id: "a", lat: 40.7128, lng: -74.006 });
  const dead = venue({
    id: "d",
    lat: 40.7128,
    lng: -74.006,
    status: "merged",
    merged_into_id: "a",
  });
  assertEquals(planVenueMerges([a, dead], 250), []);
});

Deno.test("mergedCentroid: weighted by observations, and safe at zero", () => {
  const heavy = venue({ id: "h", lat: 40.0, lng: -74.0, observation_count: 9 });
  const light = venue({ id: "l", lat: 41.0, lng: -74.0, observation_count: 1 });
  const c = mergedCentroid(heavy, light);
  assert(c.lat < 40.5, "the busier venue should pull the centroid");
  assertEquals(c.lng, -74);

  // Two brand-new candidates land halfway rather than dividing by zero.
  const a = venue({ id: "a", lat: 40.0, lng: -74.0 });
  const b = venue({ id: "b", lat: 41.0, lng: -74.0 });
  assertEquals(mergedCentroid(a, b).lat, 40.5);
});
