// US-2843: the stock-photo detector gate.
//
// A manufacturer catalog image reads as a near-perfect garment, so a curve
// fitted over catalog listings slopes toward a condition nobody is selling.
// This test is the gate on that: it holds the predicate to a labelled fixture
// and fails when recall on the stock half drops, rather than letting a quiet
// regression poison every price downstream.
import { assert, assertEquals } from "@std/assert";
import {
  CROSS_CELL_STOCK_MIN,
  isStockPhotoSet,
  SINGLE_PHOTO_CROSS_CELL_MIN,
  UNIFORM_MIN_PHOTOS,
} from "../lib/comp-stock-photo.ts";

// ── the fixture gate ───────────────────────────────────────────────────────

interface FixturePhoto {
  hash: string;
  width: number | null;
  height: number | null;
}
interface FixtureSet {
  id: string;
  cellKey: string;
  label: "stock" | "seller";
  why: string;
  photos: FixturePhoto[];
}
interface Fixture {
  hashCellCounts: Record<string, number>;
  sets: FixtureSet[];
}

const fixture: Fixture = JSON.parse(
  await Deno.readTextFile(
    new URL("./fixtures/comp-stock-photos.json", import.meta.url),
  ),
);

// The recorded baselines. These are MEASURED numbers, not aspirations: they are
// what the detector scores on this fixture today. A change that drops recall
// below the floor, or lifts false positives above the ceiling, fails here.
const RECALL_FLOOR = 0.9;
// Exactly one case: E15, the seller whose listing tool padded to square. See the
// fixture readme for why that trade is accepted rather than tuned away.
const FALSE_POSITIVE_CEILING = 0.0625;

function countCells(hash: string): number {
  return fixture.hashCellCounts[hash] ?? 1;
}

Deno.test("fixture is big enough to mean anything (AC2: at least 30 sets, both labels present)", () => {
  assert(fixture.sets.length >= 30, `only ${fixture.sets.length} sets`);
  const stock = fixture.sets.filter((s) => s.label === "stock").length;
  const seller = fixture.sets.filter((s) => s.label === "seller").length;
  assert(stock >= 12, `only ${stock} stock sets`);
  assert(seller >= 12, `only ${seller} seller sets`);
});

Deno.test("every fixture set carries a stated reason, so a reader can argue with the label", () => {
  for (const s of fixture.sets) {
    assert(s.why.trim().length > 0, `${s.id} has no 'why'`);
  }
});

Deno.test("recall on the stock half holds at or above the recorded baseline", () => {
  const stock = fixture.sets.filter((s) => s.label === "stock");
  const caught = stock.filter((s) =>
    isStockPhotoSet({ cellKey: s.cellKey, photos: s.photos }, countCells).stock
  );
  const recall = caught.length / stock.length;
  const missed = stock.filter((s) =>
    !isStockPhotoSet({ cellKey: s.cellKey, photos: s.photos }, countCells).stock
  ).map((s) => s.id);
  assert(
    recall >= RECALL_FLOOR,
    `recall ${recall.toFixed(3)} below floor ${RECALL_FLOOR}; missed ${missed.join(", ")}`,
  );
});

Deno.test("seller-shot listings are not thrown away: false positives stay at the ceiling", () => {
  const seller = fixture.sets.filter((s) => s.label === "seller");
  const flagged = seller.filter((s) =>
    isStockPhotoSet({ cellKey: s.cellKey, photos: s.photos }, countCells).stock
  );
  const rate = flagged.length / seller.length;
  assert(
    rate <= FALSE_POSITIVE_CEILING,
    `false positive rate ${rate.toFixed(3)} above ceiling ${FALSE_POSITIVE_CEILING}; flagged ${
      flagged.map((s) => s.id).join(", ")
    }`,
  );
});

// ── the tells, one at a time ───────────────────────────────────────────────

const sq = (hash: string) => ({ hash, width: 1600, height: 1600 });
const phone = (hash: string) => ({ hash, width: 3024, height: 4032 });

Deno.test("cross-cell hash repetition is a STRONG tell: one shared photo condemns the set", () => {
  const seen = (h: string) => (h === "shared" ? CROSS_CELL_STOCK_MIN : 1);
  const r = isStockPhotoSet(
    { cellKey: "a", photos: [phone("own1"), phone("own2"), { ...phone("shared"), hash: "shared" }] },
    seen,
  );
  assertEquals(r.stock, true);
  assertEquals(r.strength, "strong");
  assert(r.reasons.includes("cross_cell_hash"));
});

Deno.test("a hash under one cell only is not a tell", () => {
  const r = isStockPhotoSet({ cellKey: "a", photos: [phone("x"), phone("y")] }, () => 1);
  assertEquals(r.stock, false);
  assertEquals(r.strength, "none");
  assertEquals(r.reasons, []);
});

Deno.test("uniform dimensions ALONE is weak and does not reject: phones shoot uniform too", () => {
  const photos = Array.from({ length: UNIFORM_MIN_PHOTOS }, (_, i) => phone(`p${i}`));
  const r = isStockPhotoSet({ cellKey: "a", photos }, () => 1);
  assertEquals(r.stock, false);
  assertEquals(r.strength, "weak");
  assert(r.reasons.includes("uniform_dimensions"));
});

Deno.test("uniform AND square rejects: a phone does not shoot exactly square", () => {
  const photos = Array.from({ length: UNIFORM_MIN_PHOTOS }, (_, i) => sq(`p${i}`));
  const r = isStockPhotoSet({ cellKey: "a", photos }, () => 1);
  assertEquals(r.stock, true);
  assertEquals(r.strength, "weak");
  assert(r.reasons.includes("uniform_dimensions"));
  assert(r.reasons.includes("square_aspect"));
});

Deno.test("a single-photo listing needs a lower bar, because there is nothing else to go on", () => {
  const seenTwice = () => SINGLE_PHOTO_CROSS_CELL_MIN;
  const r = isStockPhotoSet({ cellKey: "a", photos: [phone("only")] }, seenTwice);
  assertEquals(r.stock, true);
  assert(r.reasons.includes("single_photo_cross_cell"));

  const unique = isStockPhotoSet({ cellKey: "a", photos: [phone("only")] }, () => 1);
  assertEquals(unique.stock, false);
});

Deno.test("an empty photo set is not stock, it is unusable, and says so", () => {
  const r = isStockPhotoSet({ cellKey: "a", photos: [] }, () => 1);
  assertEquals(r.stock, false);
  assert(r.reasons.includes("no_photos"));
});

Deno.test("missing dimensions never fire the dimension tells", () => {
  const photos = Array.from({ length: UNIFORM_MIN_PHOTOS }, (_, i) => ({
    hash: `p${i}`,
    width: null,
    height: null,
  }));
  const r = isStockPhotoSet({ cellKey: "a", photos }, () => 1);
  assertEquals(r.stock, false);
  assertEquals(r.reasons, []);
});

Deno.test("a rejection always states why (AC4: the reason is recorded, never a bare boolean)", () => {
  const seen = (h: string) => (h === "shared" ? CROSS_CELL_STOCK_MIN : 1);
  const r = isStockPhotoSet({ cellKey: "a", photos: [{ hash: "shared", width: 1600, height: 1600 }] }, seen);
  assertEquals(r.stock, true);
  assert(r.reasons.length > 0);
});

// ── AC1: pure, no network ──────────────────────────────────────────────────

Deno.test("AC1: the module makes no network call and pulls in no I/O client", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/comp-stock-photo.ts", import.meta.url),
  );
  assert(!/\bfetch\s*\(/.test(src), "comp-stock-photo.ts calls fetch");
  assert(!/from\s+"\.\/(ebay-client|supabase)\.ts"/.test(src), "comp-stock-photo.ts imports an I/O client");
  assert(!/\bDeno\.env\b/.test(src), "comp-stock-photo.ts reads env");
});
