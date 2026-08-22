# Shipping Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Predict a garment's shipped parcel from the measurements we already
took, and feed that number to the three places that need it and currently do
without.

**Architecture:** One pure, dependency-free module (`parcel-estimate.ts`) that
turns an inventory item into a predicted parcel. It is mirrored byte-for-byte
into the Deno edge tree because the edge cannot import from `src/`, and a guard
test fails the build if the copies drift. Three consumers are then edited to
read it: the profit estimator, the eBay publish path, and the logistics rates
route. A jsonb column on `sales` records what we predicted so it can be
compared against what eBay actually charged.

**Tech Stack:** TypeScript (strict), React 19, Vitest for web, Deno for edge,
Supabase Postgres migration.

**Spec:** `docs/superpowers/specs/2026-08-21-shipping-truth-design.md`

## Global Constraints

- **The edge cannot import from `src/`.** Any module both runtimes need is
  duplicated VERBATIM at `services/edge-functions/src/lib/<name>.ts` and held
  byte-identical by a guard test. Pattern to copy exactly:
  `src/lib/ebay-fees.ts` and `src/lib/__tests__/ebay-fees.test.ts:35-39`.
- **Mirrored modules stay dependency-free.** Pure constants and pure functions
  only, so the file type-checks under both `tsconfig` and Deno.
- **ASCII only in code.** Straight quotes, hyphen-minus, no en/em dashes, no
  curly quotes, no non-breaking spaces. A look-alike character in a literal is
  a runtime failure.
- **`noUncheckedIndexedAccess` is on** in the frontend tsconfig. Indexing a
  `Record<string, T>` or an array yields `T | undefined`. Guard it or use `!`
  at a known-safe site.
- **Typecheck with `npx tsc -b`, never `--noEmit`.** `-b` is what CI runs and
  it is stricter.
- **No carrier numbers from memory.** Every rate, band and dimensional-weight
  rule is read off the carrier's own published page and the working is recorded
  in a CSV beside it. This rule is inherited from `src/lib/ebay-fee-schedule.ts`,
  where a confidently wrong number shipped once already.
- **Naming:** files `kebab-case.ts`; named exports (`export function x()`);
  tests `src/lib/__tests__/<name>.test.ts`.
- **Migration commits are never pushed** until the owner applies them to prod
  and says go. Package them in `PENDING_MIGRATIONS.md`.

---

### Task 1: Weight model

**Files:**
- Create: `src/lib/parcel-estimate.ts`
- Test: `src/lib/__tests__/parcel-estimate.test.ts`

**Interfaces:**
- Consumes: `GarmentCategory` from `@/types/database` (type-only import, so the
  module stays dependency-free at runtime).
- Produces:
  - `export interface ParcelInput { garmentCategory, material, measurements, size }`
  - `export interface ParcelEstimate { weightOz, billableWeightOz, pack, confidence, basis }`
    (only `weightOz`, `confidence` and `basis` are populated in this task)
  - `export function estimateParcel(input: ParcelInput): ParcelEstimate`
  - `export const PARCEL_TABLE_VERSION: string`
  - `export const BASE_WEIGHT_OZ: Record<GarmentCategory, number>`
  - `export const MATERIAL_MULTIPLIERS: ReadonlyArray<[string, number]>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/parcel-estimate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { estimateParcel } from "../parcel-estimate";

describe("estimateParcel weight", () => {
  it("returns the category base weight plus packaging when nothing else is known", () => {
    const r = estimateParcel({
      garmentCategory: "t-shirt",
      material: null,
      measurements: null,
      size: null,
    });
    // 5.5 oz base + 0.5 oz small poly mailer.
    expect(r.weightOz).toBeCloseTo(6.0, 2);
    expect(r.confidence).toBe("rough");
    expect(r.basis).toEqual(["category"]);
  });

  it("scales up for a large chest measurement", () => {
    const small = estimateParcel({
      garmentCategory: "t-shirt",
      material: "cotton",
      measurements: { chest: 19 },
      size: null,
    });
    const large = estimateParcel({
      garmentCategory: "t-shirt",
      material: "cotton",
      measurements: { chest: 26 },
      size: null,
    });
    expect(large.weightOz).toBeGreaterThan(small.weightOz);
    expect(large.confidence).toBe("good");
    expect(large.basis).toEqual(["category", "measurements", "material"]);
  });

  it("makes denim heavier than the same garment in poly", () => {
    const denim = estimateParcel({
      garmentCategory: "jeans",
      material: "denim",
      measurements: null,
      size: null,
    });
    const poly = estimateParcel({
      garmentCategory: "jeans",
      material: "polyester",
      measurements: null,
      size: null,
    });
    expect(denim.weightOz).toBeGreaterThan(poly.weightOz);
  });

  it("clamps an absurd measurement instead of returning a fantasy weight", () => {
    const r = estimateParcel({
      garmentCategory: "t-shirt",
      material: null,
      measurements: { chest: 400 },
      size: null,
    });
    // Clamped at 1.45x base, plus packaging. Never unbounded.
    expect(r.weightOz).toBeLessThan(10);
  });

  it("ignores an unrecognized material rather than guessing", () => {
    const known = estimateParcel({
      garmentCategory: "shirt",
      material: null,
      measurements: null,
      size: null,
    });
    const weird = estimateParcel({
      garmentCategory: "shirt",
      material: "moon fibre",
      measurements: null,
      size: null,
    });
    expect(weird.weightOz).toBeCloseTo(known.weightOz, 2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/parcel-estimate.test.ts`
Expected: FAIL, cannot resolve `../parcel-estimate`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/parcel-estimate.ts`:

```ts
// Predicts the parcel a garment ships in, from the measurements grading
// already took (US-2788).
//
// WHY IT EXISTS. listing-profit.ts takes a shippingCost "if known", and it is
// almost never known: autolister-bulk-edit.tsx passes none at all, so the bulk
// "floor at X% margin" button prices every draft as if postage were free. On a
// wool coat that floor is a loss, applied in bulk, silently.
//
// DETERMINISTIC ON PURPOSE. This runs on every keystroke in the composer, so
// it must be free, and it must return the same number twice so the predicted
// figure can be regression-tested against real shipments later. An AI call is
// neither.
//
// MIRROR: once Task 4 lands, this file is duplicated VERBATIM at
//   services/edge-functions/src/lib/parcel-estimate.ts
// because the Deno edge runtime cannot import from the Vite `src/` tree, and
// src/lib/__tests__/parcel-estimate.test.ts fails the build if the copies
// drift. Keep this module dependency-free (pure constants + pure functions)
// so it type-checks under BOTH tsconfig and Deno. The GarmentCategory import
// is `import type`, which erases at runtime.
//
// THE NUMBERS BELOW ARE SEEDED ESTIMATES, not measurements. They are roughly
// right and individually unproven. The predicted-vs-actual feedback loop
// (Task 8) is the plan for making them real. Do not present them as sourced.

import type { GarmentCategory } from "@/types/database";

/** Bumped whenever a weight, multiplier or pack rule changes, so a stored
 *  prediction can be attributed to the table that produced it. */
export const PARCEL_TABLE_VERSION = "parcel_v1_seeded";

/** Base garment weight in ounces at a reference size (men's M / US 8),
 *  EXCLUDING packaging. Seeded estimates, see the header. */
export const BASE_WEIGHT_OZ: Record<GarmentCategory, number> = {
  "t-shirt": 5.5,
  shirt: 8,
  blouse: 5,
  sweater: 16,
  hoodie: 22,
  jacket: 28,
  coat: 48,
  jeans: 22,
  pants: 16,
  shorts: 9,
  skirt: 8,
  dress: 12,
  sneakers: 32,
  boots: 48,
  sandals: 16,
  hat: 4,
  bag: 20,
  belt: 6,
  scarf: 4,
  neckwear: 2,
  gloves: 4,
  other: 12,
};

// Ordered longest-first so "polyester" is not matched by a shorter "poly"
// entry placed before it. Substring matching against a lowercased material
// string, because sellers write "100% cotton" and "cotton/poly blend".
export const MATERIAL_MULTIPLIERS: ReadonlyArray<[string, number]> = [
  ["leather", 1.6],
  ["corduroy", 1.2],
  ["polyester", 0.85],
  ["cashmere", 0.9],
  ["denim", 1.35],
  ["fleece", 1.1],
  ["cotton", 1.0],
  ["linen", 0.9],
  ["nylon", 0.8],
  ["rayon", 0.85],
  ["silk", 0.7],
  ["wool", 1.25],
  ["down", 0.75],
];

/** Flat reference measurement in inches at the base size, per axis. */
const REFERENCE_CHEST_IN = 21;
const REFERENCE_WAIST_IN = 17;

/** Categories measured at the waist rather than the chest. */
const WAIST_MEASURED: ReadonlySet<string> = new Set([
  "jeans",
  "pants",
  "shorts",
  "skirt",
]);

// Weight scales with fabric area, which would argue for an exponent above 1.
// It is 1.0 here because we have no data yet, and a damped guess beats a
// confident one. The feedback loop decides whether it should rise.
const SIZE_EXPONENT = 1.0;
const SIZE_FACTOR_MIN = 0.75;
const SIZE_FACTOR_MAX = 1.45;

/** Weight of the packaging itself, in ounces. */
export const PACKAGING_WEIGHT_OZ = {
  mailer_small: 0.5,
  mailer_large: 0.9,
  box_small: 5,
  box_medium: 8,
} as const;

export type PackKind = keyof typeof PACKAGING_WEIGHT_OZ;

export interface ParcelInput {
  garmentCategory: GarmentCategory | null;
  material: string | null;
  measurements: Record<string, number | string> | null;
  size: string | null;
}

export interface ParcelEstimate {
  /** Predicted actual weight in ounces, packaging included. */
  weightOz: number;
  /** max(actual, dimensional). Equal to weightOz until Task 2. */
  billableWeightOz: number;
  pack: PackKind;
  /** "good" when measurements and material both informed the number. */
  confidence: "good" | "rough";
  /** Which inputs were used, in a fixed order, for the UI and for debugging. */
  basis: string[];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Reads a numeric measurement, tolerating the string values the jsonb holds. */
function numeric(
  measurements: Record<string, number | string> | null,
  key: string,
): number | null {
  if (!measurements) return null;
  const raw = measurements[key];
  if (raw == null) return null;
  const n = typeof raw === "number" ? raw : Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function materialMultiplier(material: string | null): number | null {
  if (!material) return null;
  const hay = material.toLowerCase();
  for (const [needle, mult] of MATERIAL_MULTIPLIERS) {
    if (hay.includes(needle)) return mult;
  }
  return null;
}

export function sizeFactor(input: ParcelInput): number | null {
  const cat = input.garmentCategory;
  if (!cat) return null;
  const useWaist = WAIST_MEASURED.has(cat);
  const measured = useWaist
    ? numeric(input.measurements, "waist")
    : numeric(input.measurements, "chest");
  if (measured == null) return null;
  const reference = useWaist ? REFERENCE_WAIST_IN : REFERENCE_CHEST_IN;
  const ratio = Math.pow(measured / reference, SIZE_EXPONENT);
  return clamp(ratio, SIZE_FACTOR_MIN, SIZE_FACTOR_MAX);
}

// Task 2 replaces this with real per-category pack selection. Until then every
// parcel is a small mailer, which keeps the weight test honest without
// pretending the pack model exists.
function selectPack(_input: ParcelInput, _garmentOz: number): PackKind {
  return "mailer_small";
}

export function estimateParcel(input: ParcelInput): ParcelEstimate {
  const basis: string[] = [];
  const cat = input.garmentCategory;
  const base = cat != null ? BASE_WEIGHT_OZ[cat] : BASE_WEIGHT_OZ.other;
  if (cat != null) basis.push("category");

  const factor = sizeFactor(input);
  if (factor != null) basis.push("measurements");

  const mult = materialMultiplier(input.material);
  if (mult != null) basis.push("material");

  const garmentOz = base * (factor ?? 1) * (mult ?? 1);
  const pack = selectPack(input, garmentOz);
  const weightOz = garmentOz + PACKAGING_WEIGHT_OZ[pack];

  return {
    weightOz,
    billableWeightOz: weightOz,
    pack,
    confidence: factor != null && mult != null ? "good" : "rough",
    basis,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/parcel-estimate.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b`
Expected: exit 0. If `BASE_WEIGHT_OZ[cat]` errors under
`noUncheckedIndexedAccess`, note the `Record<GarmentCategory, number>` is total
over the union so the index is safe; keep the type annotation rather than
adding a non-null assertion.

- [ ] **Step 6: Commit**

```bash
git add src/lib/parcel-estimate.ts src/lib/__tests__/parcel-estimate.test.ts
git commit -m "feat(shipping): predict garment weight from category, size and material"
```

---

### Task 2: Pack model and dimensional weight

**Files:**
- Modify: `src/lib/parcel-estimate.ts`
- Test: `src/lib/__tests__/parcel-estimate.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produced.
- Produces:
  - `export const PACK_DIMENSIONS: Record<PackKind, { lengthIn, widthIn, heightIn }>`
  - `export const DIM_DIVISOR: number`
  - `export const DIM_THRESHOLD_CU_IN: number`
  - `export function dimensionalWeightOz(pack: PackKind): number`
  - `ParcelEstimate.billableWeightOz` now differs from `weightOz` for bulky packs
  - `ParcelEstimate.basis` may include `"dimensional"`

- [ ] **Step 1: Source the dimensional-weight rule before writing code**

Do not write this task from memory. Read the USPS published rule for when
dimensional weight applies to Ground Advantage and Priority Mail, and the
divisor it uses. Record what you read, the URL, and the date, in
`docs/shipping/usps-dim-weight-CONFIRMED.csv` with columns
`rule,value,source_url,read_on`.

The Global Constraint on carrier numbers exists because
`src/lib/ebay-fee-schedule.ts` shipped a real-but-wrong number once by taking
it from a secondary source. If the published rule contradicts the constants
below, the published rule wins and you update them.

- [ ] **Step 2: Write the failing test**

Append to `src/lib/__tests__/parcel-estimate.test.ts`:

```ts
import { dimensionalWeightOz, estimateParcel } from "../parcel-estimate";

describe("estimateParcel pack and dimensional weight", () => {
  it("puts footwear in a box, not a mailer", () => {
    const r = estimateParcel({
      garmentCategory: "boots",
      material: null,
      measurements: null,
      size: null,
    });
    expect(r.pack).toBe("box_medium");
  });

  it("puts a t-shirt in a small mailer", () => {
    const r = estimateParcel({
      garmentCategory: "t-shirt",
      material: null,
      measurements: null,
      size: null,
    });
    expect(r.pack).toBe("mailer_small");
  });

  it("upgrades to a large mailer once the garment is bulky", () => {
    const r = estimateParcel({
      garmentCategory: "coat",
      material: "wool",
      measurements: null,
      size: null,
    });
    expect(r.pack).toBe("mailer_large");
  });

  it("bills a puffer on size, not on weight", () => {
    // The case sellers lose money on and never see: light garment, big box.
    const r = estimateParcel({
      garmentCategory: "jacket",
      material: "down",
      measurements: null,
      size: null,
    });
    expect(r.billableWeightOz).toBeGreaterThan(r.weightOz);
    expect(r.basis).toContain("dimensional");
  });

  it("does not apply dimensional weight to a small mailer", () => {
    const r = estimateParcel({
      garmentCategory: "t-shirt",
      material: "cotton",
      measurements: null,
      size: null,
    });
    expect(r.billableWeightOz).toBeCloseTo(r.weightOz, 2);
    expect(r.basis).not.toContain("dimensional");
  });

  it("returns zero dimensional weight for packs under the threshold", () => {
    expect(dimensionalWeightOz("mailer_small")).toBe(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/parcel-estimate.test.ts`
Expected: FAIL. `dimensionalWeightOz` is not exported, and `pack` is
`mailer_small` for boots.

- [ ] **Step 4: Write the implementation**

In `src/lib/parcel-estimate.ts`, add after `PACKAGING_WEIGHT_OZ`:

```ts
/** Outside dimensions in inches, used for dimensional weight. */
export const PACK_DIMENSIONS: Record<
  PackKind,
  { lengthIn: number; widthIn: number; heightIn: number }
> = {
  mailer_small: { lengthIn: 10, widthIn: 13, heightIn: 1 },
  mailer_large: { lengthIn: 14, widthIn: 19, heightIn: 3 },
  box_small: { lengthIn: 12, widthIn: 9, heightIn: 4 },
  box_medium: { lengthIn: 16, widthIn: 12, heightIn: 8 },
};

// VERIFY BOTH AGAINST docs/shipping/usps-dim-weight-CONFIRMED.csv before
// trusting them. Cubic inches divided by the divisor gives billable POUNDS,
// and the rule only engages above the threshold.
export const DIM_DIVISOR = 166;
export const DIM_THRESHOLD_CU_IN = 1728;

/** Billable dimensional weight in ounces, or 0 when the rule does not apply. */
export function dimensionalWeightOz(pack: PackKind): number {
  const d = PACK_DIMENSIONS[pack];
  const cubic = d.lengthIn * d.widthIn * d.heightIn;
  if (cubic <= DIM_THRESHOLD_CU_IN) return 0;
  return (cubic / DIM_DIVISOR) * 16;
}
```

Replace the placeholder `selectPack` with:

```ts
/** Categories that ship rigid, in a box rather than a mailer. */
const BOXED: ReadonlySet<string> = new Set([
  "sneakers",
  "boots",
  "sandals",
  "bag",
]);

/** Above this many ounces of garment, a small mailer stops fitting. */
const LARGE_MAILER_OZ = 18;

function selectPack(input: ParcelInput, garmentOz: number): PackKind {
  const cat = input.garmentCategory;
  if (cat != null && BOXED.has(cat)) {
    return garmentOz > 36 ? "box_medium" : "box_small";
  }
  return garmentOz > LARGE_MAILER_OZ ? "mailer_large" : "mailer_small";
}
```

Then replace the `return` in `estimateParcel` so billable weight is the larger
of the two:

```ts
  const dimOz = dimensionalWeightOz(pack);
  const billableWeightOz = Math.max(weightOz, dimOz);
  if (dimOz > weightOz) basis.push("dimensional");

  return {
    weightOz,
    billableWeightOz,
    pack,
    confidence: factor != null && mult != null ? "good" : "rough",
    basis,
  };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/parcel-estimate.test.ts`
Expected: PASS, all tests from Tasks 1 and 2.

If "puts footwear in a box" passes but "bills a puffer on size" fails, the
`box_medium` dimensions are the suspect, not the divisor. Check the CSV.

- [ ] **Step 6: Commit**

```bash
git add src/lib/parcel-estimate.ts src/lib/__tests__/parcel-estimate.test.ts docs/shipping/usps-dim-weight-CONFIRMED.csv
git commit -m "feat(shipping): pick the pack and bill bulky-light items on size"
```

---

### Task 3: Rate table and the rate-break warning

**Files:**
- Create: `src/lib/shipping-rates.ts`
- Create: `docs/shipping/usps-rates-CONFIRMED.csv`
- Test: `src/lib/__tests__/shipping-rates.test.ts`

**Interfaces:**
- Consumes: `PackKind` and `ParcelEstimate` from `./parcel-estimate`.
- Produces:
  - `export const RATE_TABLE_VERSION: string`
  - `export const RATE_EFFECTIVE_FROM: string` (ISO date, from the carrier)
  - `export const REPRESENTATIVE_ZONE: number`
  - `export interface RateBand { maxOz: number; priceUsd: number }`
  - `export interface RateQuote { service, priceUsd, bandMaxOz, ozToNextBand, savingIfUnder }`
  - `export function estimatePostage(billableOz: number): RateQuote | null`
  - `export function rateBreakWarning(billableOz: number): string | null`

- [ ] **Step 1: Source the rates first**

Read USPS published retail prices for Ground Advantage and Priority Mail at the
representative zone. Record every band in
`docs/shipping/usps-rates-CONFIRMED.csv` with columns
`service,zone,max_oz,price_usd,source_url,read_on`.

Unlike the eBay fee schedule, USPS DOES publish an effective date, so
`RATE_EFFECTIVE_FROM` is a real date read off the page. Do not invent one; if
you cannot find it, stop and say so rather than stamping a guess.

- [ ] **Step 2: Write the failing test**

Create `src/lib/__tests__/shipping-rates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  estimatePostage,
  RATE_EFFECTIVE_FROM,
  rateBreakWarning,
} from "../shipping-rates";

describe("estimatePostage", () => {
  it("carries a real effective date, not an invented one", () => {
    expect(RATE_EFFECTIVE_FROM).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("prices a light parcel in the lowest band", () => {
    const q = estimatePostage(6);
    expect(q).not.toBeNull();
    expect(q!.priceUsd).toBeGreaterThan(0);
    expect(q!.bandMaxOz).toBeGreaterThanOrEqual(6);
  });

  it("charges more for a heavier parcel", () => {
    const light = estimatePostage(6)!;
    const heavy = estimatePostage(40)!;
    expect(heavy.priceUsd).toBeGreaterThan(light.priceUsd);
  });

  it("reports how many ounces sit between here and the next band", () => {
    const q = estimatePostage(15.5)!;
    expect(q.ozToNextBand).toBeCloseTo(q.bandMaxOz - 15.5, 3);
  });

  it("returns null above the heaviest band rather than extrapolating", () => {
    expect(estimatePostage(100000)).toBeNull();
  });
});

describe("rateBreakWarning", () => {
  it("warns when a small trim drops a band", () => {
    // Just over a band edge: the seller is paying the next band for ounces.
    const msg = rateBreakWarning(16.4);
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/save/i);
  });

  it("stays quiet in the middle of a band", () => {
    expect(rateBreakWarning(8)).toBeNull();
  });

  it("stays quiet when there is no cheaper band below", () => {
    expect(rateBreakWarning(1)).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/shipping-rates.test.ts`
Expected: FAIL, cannot resolve `../shipping-rates`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/shipping-rates.ts`. Fill `GROUND_ADVANTAGE_BANDS` from the CSV
you produced in Step 1; the two rows shown are placeholders for SHAPE only and
must be replaced with the full sourced set.

```ts
// USPS rate bands and the rate-break warning (US-2788).
//
// EVERY NUMBER HERE WAS READ OFF USPS's OWN PUBLISHED RATES and the working is
// recorded in docs/shipping/usps-rates-CONFIRMED.csv. Nothing in this file may
// be edited from memory or from a secondary source. src/lib/ebay-fee-schedule.ts
// carries the story of what happens otherwise: a real fee number, belonging to
// the wrong category, that survived review because it looked right.
//
// ZONE. A label's price depends on how far the parcel travels, and at listing
// time there is no buyer, so there is no destination and no true price. Every
// number this module returns is for a REPRESENTATIVE ZONE and is a pricing aid,
// not an accounting figure. The UI must say "est." and mean it. The real cost
// arrives later from the eBay payout sync into sales.shipping_cost.

export const RATE_TABLE_VERSION = "usps_v1";

/** Read off the USPS rate page. See the CSV. Not a guess. */
export const RATE_EFFECTIVE_FROM = "REPLACE_FROM_CSV";

/** The zone these prices are quoted at. Named so the UI can disclose it. */
export const REPRESENTATIVE_ZONE = 4;

export interface RateBand {
  /** Inclusive upper bound of the band, in ounces. */
  maxOz: number;
  priceUsd: number;
}

// SHAPE ONLY. Replace with the full sourced band list from the CSV, ascending
// by maxOz. Do not ship the placeholder values.
const GROUND_ADVANTAGE_BANDS: ReadonlyArray<RateBand> = [
  { maxOz: 4, priceUsd: 0 },
  { maxOz: 8, priceUsd: 0 },
];

export interface RateQuote {
  service: string;
  priceUsd: number;
  /** Upper bound of the band this parcel landed in. */
  bandMaxOz: number;
  /** Ounces of headroom before the next band. */
  ozToNextBand: number;
  /** What dropping into the band below would save, or 0 if there is none. */
  savingIfUnder: number;
}

export function estimatePostage(billableOz: number): RateQuote | null {
  if (!Number.isFinite(billableOz) || billableOz <= 0) return null;
  const bands = GROUND_ADVANTAGE_BANDS;
  const index = bands.findIndex((b) => billableOz <= b.maxOz);
  if (index === -1) return null;
  const band = bands[index]!;
  const below = index > 0 ? bands[index - 1]! : null;
  return {
    service: "USPS Ground Advantage",
    priceUsd: band.priceUsd,
    bandMaxOz: band.maxOz,
    ozToNextBand: band.maxOz - billableOz,
    savingIfUnder: below ? band.priceUsd - below.priceUsd : 0,
  };
}

/** How far past a band edge still counts as "a small trim away". */
const TRIM_WINDOW_OZ = 1;

export function rateBreakWarning(billableOz: number): string | null {
  const q = estimatePostage(billableOz);
  if (!q || q.savingIfUnder <= 0) return null;
  const bands = GROUND_ADVANTAGE_BANDS;
  const index = bands.findIndex((b) => billableOz <= b.maxOz);
  const below = index > 0 ? bands[index - 1]! : null;
  if (!below) return null;
  const over = billableOz - below.maxOz;
  if (over > TRIM_WINDOW_OZ) return null;
  return `At ${billableOz.toFixed(1)} oz you are ${over.toFixed(1)} oz into the ` +
    `next band. Trimming under ${below.maxOz} oz saves $${q.savingIfUnder.toFixed(2)}.`;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/shipping-rates.test.ts`
Expected: PASS, 8 tests. They will FAIL against the placeholder bands, which is
correct. The task is not done until the real bands from Step 1 are in and the
tests pass against them.

- [ ] **Step 6: Commit**

```bash
git add src/lib/shipping-rates.ts src/lib/__tests__/shipping-rates.test.ts docs/shipping/usps-rates-CONFIRMED.csv
git commit -m "feat(shipping): sourced USPS rate bands and the rate-break warning"
```

---

### Task 4: Mirror both modules to the edge

**Files:**
- Create: `services/edge-functions/src/lib/parcel-estimate.ts` (verbatim copy)
- Create: `services/edge-functions/src/lib/shipping-rates.ts` (verbatim copy)
- Modify: `src/lib/parcel-estimate.ts` (import path only, see Step 2)
- Test: `src/lib/__tests__/parcel-estimate-mirror.test.ts`

**Interfaces:**
- Consumes: the finished modules from Tasks 1 to 3.
- Produces: edge-importable copies. Tasks 6 and 7 depend on these existing.

- [ ] **Step 1: Write the failing guard test**

Create `src/lib/__tests__/parcel-estimate-mirror.test.ts`, copying the pattern
at `src/lib/__tests__/ebay-fees.test.ts:35-39`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PAIRS = [
  ["src/lib/parcel-estimate.ts", "services/edge-functions/src/lib/parcel-estimate.ts"],
  ["src/lib/shipping-rates.ts", "services/edge-functions/src/lib/shipping-rates.ts"],
] as const;

describe("edge mirror stays in sync (US-2788)", () => {
  for (const [canonical, mirror] of PAIRS) {
    it(`${mirror} is byte-identical to ${canonical}`, () => {
      expect(readFileSync(resolve(process.cwd(), mirror), "utf8")).toBe(
        readFileSync(resolve(process.cwd(), canonical), "utf8"),
      );
    });
  }

  it("the mirrored modules import no runtime dependency", () => {
    // A value import would resolve under Vite and explode under Deno. Type
    // imports erase, so they are allowed.
    for (const [canonical] of PAIRS) {
      const src = readFileSync(resolve(process.cwd(), canonical), "utf8");
      const imports = src.match(/^import .*$/gm) ?? [];
      for (const line of imports) {
        expect(line.startsWith("import type ")).toBe(true);
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/parcel-estimate-mirror.test.ts`
Expected: FAIL, ENOENT on the edge copies.

- [ ] **Step 3: Make the source Deno-safe, then copy**

`src/lib/parcel-estimate.ts` currently does `import type { GarmentCategory }
from "@/types/database"`. The `@/` alias does not exist under Deno. Because it
is the only import and it is type-only, replace it with a local declaration so
the file has no imports at all:

```ts
// Declared locally rather than imported: this file is mirrored into the Deno
// edge tree, where the "@/" alias does not resolve. Keep in sync with
// GarmentCategory in src/types/database.ts; the union is closed and changes
// there are rare and deliberate.
type GarmentCategory =
  | "t-shirt" | "shirt" | "blouse" | "sweater" | "hoodie"
  | "jacket" | "coat" | "jeans" | "pants" | "shorts"
  | "skirt" | "dress" | "sneakers" | "boots" | "sandals"
  | "hat" | "bag" | "belt" | "scarf" | "neckwear" | "gloves" | "other";
```

Then copy both files verbatim:

```bash
cp src/lib/parcel-estimate.ts services/edge-functions/src/lib/parcel-estimate.ts
cp src/lib/shipping-rates.ts services/edge-functions/src/lib/shipping-rates.ts
```

- [ ] **Step 4: Add a drift test between the local union and the real one**

Append to `src/lib/__tests__/parcel-estimate-mirror.test.ts`:

```ts
import { BASE_WEIGHT_OZ } from "../parcel-estimate";
import { GARMENT_CATEGORIES } from "@/lib/constants";

it("the local GarmentCategory union still covers every real category", () => {
  // If someone adds a category to the enum and not to the weight table, the
  // estimator silently falls back to "other" for it. Fail instead.
  for (const cat of GARMENT_CATEGORIES) {
    expect(Object.keys(BASE_WEIGHT_OZ)).toContain(cat);
  }
});
```

Confirm the exported name and shape of `GARMENT_CATEGORIES` in
`src/lib/constants.ts` before relying on it; if it is an array of objects
rather than strings, map to the value field.

- [ ] **Step 5: Run all three suites**

```bash
npx vitest run src/lib/__tests__/parcel-estimate.test.ts src/lib/__tests__/shipping-rates.test.ts src/lib/__tests__/parcel-estimate-mirror.test.ts
```
Expected: PASS.

- [ ] **Step 6: Verify the edge copies type-check under Deno**

```bash
cd services/edge-functions && deno check src/lib/parcel-estimate.ts src/lib/shipping-rates.ts
```
Expected: exit 0. A failure here means a runtime import survived; go back to
Step 3.

- [ ] **Step 7: Commit**

```bash
git add src/lib/parcel-estimate.ts src/lib/shipping-rates.ts services/edge-functions/src/lib/parcel-estimate.ts services/edge-functions/src/lib/shipping-rates.ts src/lib/__tests__/parcel-estimate-mirror.test.ts
git commit -m "feat(shipping): mirror the parcel estimator into the edge runtime"
```

---

### Task 5: Fix the margin floor (the defect)

**Files:**
- Modify: `src/pages/flipdesk/autolister-bulk-edit.tsx:216-260` (ItemAttrs and its query), `:462-483` (applyMarginFloor)
- Modify: `src/pages/flipdesk/autolister-drafts.tsx:260-264`, `:576-579`
- Modify: `src/pages/flipdesk/composer.tsx:2666-2670`
- Test: `src/lib/__tests__/margin-floor-shipping.test.ts`

**Interfaces:**
- Consumes: `estimateParcel` (Task 1), `estimatePostage` (Task 3).
- Produces: no new exports. This task changes behaviour at three call sites.

This is the task the whole plan exists for. Ship it even if later tasks slip.

**On the spec's "read-only advice first" rollout rule.** This task does use the
estimate to set prices, which looks like it contradicts that rule. It does not.
The rule exists to stop an automation silently repricing live listings off an
unproven table. The margin floor is a button the seller deliberately presses,
it only ever raises a price, and its current behaviour is not "no estimate" but
a hard-coded zero. A rough estimate beats a number that is known to be wrong.
What stays gated until the feedback loop reports is the repricing engine and
any scheduled automation: do not wire the estimate into
`src/pages/flipdesk/repricing.tsx` or `automations.tsx` in this plan.

- [ ] **Step 1: Write the failing regression test**

Create `src/lib/__tests__/margin-floor-shipping.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { priceForMargin } from "../listing-profit";
import { estimateParcel } from "../parcel-estimate";
import { estimatePostage } from "../shipping-rates";

// The live defect: autolister-bulk-edit.tsx called priceForMargin with no
// shipping, so "floor at 30% margin" priced every draft as if postage were
// free. This test encodes the arithmetic the fixed call site must satisfy.
describe("margin floor accounts for predicted shipping", () => {
  const coat = {
    garmentCategory: "coat" as const,
    material: "wool",
    measurements: { chest: 24 },
    size: null,
  };

  it("a wool coat floors higher once postage is counted", () => {
    const parcel = estimateParcel(coat);
    const postage = estimatePostage(parcel.billableWeightOz);
    expect(postage).not.toBeNull();

    const ignoringShipping = priceForMargin({
      targetMarginPct: 30,
      costBasis: 20,
    })!;
    const countingShipping = priceForMargin({
      targetMarginPct: 30,
      costBasis: 20,
      shippingCost: postage!.priceUsd,
    })!;

    expect(countingShipping).toBeGreaterThan(ignoringShipping);
  });

  it("the old floor does not actually reach the target margin", () => {
    const parcel = estimateParcel(coat);
    const postage = estimatePostage(parcel.billableWeightOz)!;
    const oldFloor = priceForMargin({ targetMarginPct: 30, costBasis: 20 })!;

    // Price at the old floor, then pay for postage you did not budget for.
    const fees = oldFloor * 0.136 + 0.4;
    const realNet = oldFloor - fees - 20 - postage.priceUsd;
    const realMargin = (realNet / oldFloor) * 100;

    expect(realMargin).toBeLessThan(30);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `npx vitest run src/lib/__tests__/margin-floor-shipping.test.ts`
Expected: PASS on both, because this tests the LIBRARY arithmetic, which is
already correct. That is the point: the library was never broken, the call
sites were. If either assertion fails, the rate table or weight table is wrong
and you must stop and fix that before touching the pages.

- [ ] **Step 3: Add the missing columns to the bulk-edit query**

In `src/pages/flipdesk/autolister-bulk-edit.tsx`, extend the `ItemAttrs` type
(around line 216) with the two fields the estimator needs:

```ts
    garmentCategory: GarmentCategory | null;
    measurements: Record<string, number | string> | null;
```

Extend the `.select(...)` string (around line 235) to include them:

```ts
          "id, title, brand, size, color, material, style, item_category, garment_category, measurements, attributes, acquired_price",
```

Extend the row type in the `for` loop and the `map[r.id] = { ... }` literal to
carry both through. Follow the existing `?? null` convention.

- [ ] **Step 4: Use the estimate in applyMarginFloor**

Replace the `priceForMargin` call at line 467:

```ts
      const attrs = itemAttrs[r.itemId];
      const parcel = estimateParcel({
        garmentCategory: attrs?.garmentCategory ?? null,
        material: attrs?.material || null,
        measurements: attrs?.measurements ?? null,
        size: attrs?.size || null,
      });
      const postage = estimatePostage(parcel.billableWeightOz);
      const floor = priceForMargin({
        targetMarginPct: pct,
        costBasis: attrs?.cost ?? null,
        // US-2788: without this the floor prices as if postage were free, which
        // on a heavy item is a loss applied in bulk.
        shippingCost: postage?.priceUsd ?? null,
      });
```

Add the imports at the top of the file:

```ts
import { estimateParcel } from "@/lib/parcel-estimate";
import { estimatePostage } from "@/lib/shipping-rates";
import type { GarmentCategory } from "@/types/database";
```

- [ ] **Step 5: Do the same at the two drafts call sites**

In `src/pages/flipdesk/autolister-drafts.tsx`, both `estimateListingProfit`
calls (lines 260 and 578) must pass `shippingCost`. Whatever row shape backs
`costFor(d)` needs the same three fields plumbed through; find the query that
loads the drafts and extend its select the same way as Step 3.

If a draft row genuinely cannot reach the garment fields without a second
query, pass `shippingCost: null` at line 578 (the aggregate total) and leave a
comment naming why, but line 260 (the per-row margin shown to the seller) must
carry the estimate.

- [ ] **Step 6: Show the estimate in the composer**

Add the imports at the top of `src/pages/flipdesk/composer.tsx`:

```ts
import { estimateParcel } from "@/lib/parcel-estimate";
import { estimatePostage, rateBreakWarning } from "@/lib/shipping-rates";
```

Then at line 2666, prefer the seller's own number and fall back to the
estimate:

```ts
  // US-2788: item.shipping_cost is hand-typed and usually null. Fall back to
  // the predicted parcel so the margin below is not computed against free
  // postage.
  const parcelEstimate = estimateParcel({
    garmentCategory: item.garment_category,
    material: item.material,
    measurements: item.measurements,
    size: item.size,
  });
  const estimatedPostage = estimatePostage(parcelEstimate.billableWeightOz);
  const profitEstimate = estimateListingProfit({
    price: Number.isFinite(parsedPreviewPrice) ? parsedPreviewPrice : 0,
    costBasis: effectiveCost,
    shippingCost: item.shipping_cost ?? estimatedPostage?.priceUsd ?? null,
  });
```

Render beneath the existing profit figure: the predicted weight, the pack, the
estimated postage labelled "est.", and `rateBreakWarning(...)` when it returns
a string. When `parcelEstimate.confidence === "rough"`, show a range or the
word "rough", never a precise-looking number. Match the surrounding card
markup; do not introduce a colored left border, a gradient, or a nested card
(`npm run ui:check` enforces this at zero).

- [ ] **Step 7: Verify**

```bash
npx vitest run src/lib/__tests__/margin-floor-shipping.test.ts
npx tsc -b
npm run ui:check
```
Expected: tests PASS, tsc exit 0, ui:check reports no new findings.

- [ ] **Step 8: Commit**

```bash
git add src/lib/__tests__/margin-floor-shipping.test.ts src/pages/flipdesk/autolister-bulk-edit.tsx src/pages/flipdesk/autolister-drafts.tsx src/pages/flipdesk/composer.tsx
git commit -m "fix(pricing): the bulk margin floor no longer prices as if shipping were free"
```

---

### Task 6: Send packageWeightAndSize to eBay

**Files:**
- Modify: `services/edge-functions/src/routes/flipdesk-ebay.ts` (the offer-create and offer-update payloads near `:8124`, `:8526` and `:11725`)
- Test: `services/edge-functions/src/tests/parcel-estimate_test.ts`

**Interfaces:**
- Consumes: `estimateParcel` from `../lib/parcel-estimate.ts` (Task 4 mirror).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Create `services/edge-functions/src/tests/parcel-estimate_test.ts`:

```ts
import { assertEquals, assert } from "https://deno.land/std/assert/mod.ts";
import { estimateParcel } from "../lib/parcel-estimate.ts";

Deno.test("estimateParcel runs under Deno and returns pounds-convertible oz", () => {
  const r = estimateParcel({
    garmentCategory: "coat",
    material: "wool",
    measurements: { chest: 24 },
    size: null,
  });
  assert(r.weightOz > 0);
  assert(r.billableWeightOz >= r.weightOz);
  assertEquals(typeof r.pack, "string");
});
```

Match the import style already used by the neighbouring files in
`services/edge-functions/src/tests/`; if they import assertions from a pinned
version in `deno.json`, use that instead of the unpinned URL above.

- [ ] **Step 2: Run it**

```bash
cd services/edge-functions && deno test --allow-read src/tests/parcel-estimate_test.ts
```
Expected: PASS. This proves the mirror is usable from the edge before you wire
it into a payload.

- [ ] **Step 3: Attach the parcel to the offer payload**

Add the import at the top of `flipdesk-ebay.ts`:

```ts
import { estimateParcel, PACK_DIMENSIONS } from "../lib/parcel-estimate.ts";
```

Note the `.ts` extension: Deno requires it, and omitting it is the most common
way this file fails `deno check` after an edit.

At each of the three offer payload sites, add the package block. eBay expects
pounds for the US marketplace, matching `ParcelSpec.weightUnit` in
`services/edge-functions/src/lib/ebay-logistics.ts:131-139`:

```ts
  const parcel = estimateParcel({
    garmentCategory: item.garment_category ?? null,
    material: item.material ?? null,
    measurements: item.measurements ?? null,
    size: item.size ?? null,
  });
  const dims = PACK_DIMENSIONS[parcel.pack];
  // US-2788: we never sent this, so calculated shipping could not work from a
  // GradeThread draft. Predicted, not measured; the seller can override in eBay.
  const packageWeightAndSize = {
    weight: { value: Number((parcel.weightOz / 16).toFixed(2)), unit: "POUND" },
    dimensions: {
      length: dims.lengthIn,
      width: dims.widthIn,
      height: dims.heightIn,
      unit: "INCH",
    },
  };
```

Confirm the exact field name and nesting against the eBay Inventory API shape
already used in this file before sending it. If the item row at a given call
site does not already select `garment_category`, `material` and `measurements`,
extend that query.

- [ ] **Step 4: Guard against sending a garbage weight**

Only attach the block when `parcel.confidence === "good"` OR the category is
known. Never send a weight derived from no inputs at all:

```ts
  const payload = {
    ...base,
    ...(parcel.basis.includes("category") ? { packageWeightAndSize } : {}),
  };
```

- [ ] **Step 5: Verify**

```bash
cd services/edge-functions && deno lint && deno check src/main.ts && deno test --allow-read src/tests/parcel-estimate_test.ts
```
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add services/edge-functions/src/routes/flipdesk-ebay.ts services/edge-functions/src/tests/parcel-estimate_test.ts
git commit -m "feat(ebay): send a predicted package weight so calculated shipping works"
```

---

### Task 7: Pre-fill the parcel in the rates route

**Files:**
- Modify: `services/edge-functions/src/routes/flipdesk-logistics.ts:352-370`
- Test: `services/edge-functions/src/tests/tenant-isolation_test.ts` (add a case)

**Interfaces:**
- Consumes: `estimateParcel` from `../lib/parcel-estimate.ts`.
- Produces: `GET /api/flipdesk/logistics/sales/:saleId/parcel-suggestion`
  returning `{ weight_oz, pack, length_in, width_in, height_in, confidence, basis }`.

Today the seller types a weight into `parseParcel(body)` on every single sale.
This suggests one instead. The POST keeps accepting a client parcel unchanged,
because the seller correcting us is the point and is the fastest feedback
signal we get.

- [ ] **Step 1: Write the failing tenant-isolation case**

Every new edge route needs a `tenant-isolation_test.ts` case (US-268). Add one
asserting that user B cannot read a parcel suggestion for user A's sale:

```ts
Deno.test("parcel-suggestion refuses a sale the caller does not own", async () => {
  const res = await fetch(
    `${BASE}/api/flipdesk/logistics/sales/${OTHER_USERS_SALE_ID}/parcel-suggestion`,
    { headers: authHeaders(USER_B_TOKEN) },
  );
  assert(res.status === 403 || res.status === 404);
});
```

Match the helper names (`BASE`, `authHeaders`, the fixture ids) used by the
existing cases in that file rather than the placeholders above.

- [ ] **Step 2: Run it**

Follow the recipe in `CLAUDE.md` for the tenant-isolation lane: start the
stopped containers, apply the GRANT block, seed the fixture, capture stdout
only, set `TEST_EDGE_BASE_URL=http://127.0.0.1:8787`, and run that file alone.
Expected: FAIL with 404 on an unregistered route.

- [ ] **Step 3: Implement the route**

Add the imports at the top of `flipdesk-logistics.ts`:

```ts
import { estimateParcel, PACK_DIMENSIONS } from "../lib/parcel-estimate.ts";
import { estimatePostage } from "../lib/shipping-rates.ts";
```

Then add the route, resolving the sale through `inventory_items.user_id`
exactly as the existing `preflight(ownerId, saleId)` helper does. Do not trust
the sale id from the path without that check.

```ts
flipdeskLogisticsRoutes.get("/sales/:saleId/parcel-suggestion", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const saleId = c.req.param("saleId");
  const pre = await preflight(ownerId, saleId);
  if (!pre.ok) return c.json(pre.body, pre.status);

  const { data } = await supabaseAdmin
    .from("sales")
    .select("inventory_items!inner(user_id, garment_category, material, measurements, size)")
    .eq("id", saleId)
    .maybeSingle();
  const item = (data as { inventory_items?: {
    user_id: string;
    garment_category: string | null;
    material: string | null;
    measurements: Record<string, number | string> | null;
    size: string | null;
  } } | null)?.inventory_items;
  if (!item || item.user_id !== ownerId) {
    return jsonError(c, 404, "Sale not found");
  }

  const parcel = estimateParcel({
    garmentCategory: item.garment_category as never,
    material: item.material,
    measurements: item.measurements,
    size: item.size,
  });
  const dims = PACK_DIMENSIONS[parcel.pack];
  return c.json({
    weight_oz: parcel.weightOz,
    pack: parcel.pack,
    length_in: dims.lengthIn,
    width_in: dims.widthIn,
    height_in: dims.heightIn,
    confidence: parcel.confidence,
    basis: parcel.basis,
  });
});
```

The `!inner` join plus the explicit `user_id` comparison is belt and braces on
purpose: the edge uses the service-role client, which bypasses RLS.

- [ ] **Step 4: Run the tenant-isolation case again**

Expected: PASS, and the rest of the file still 183 passed / 0 failed.

- [ ] **Step 5: Wire the suggestion into the ship UI**

Find the page that calls the rates route (search for `sales/` and `rates` under
`src/pages/flipdesk/`). Fetch the suggestion when the ship dialog opens and
pre-fill the weight and dimension inputs with it, leaving them editable and
labelled as an estimate. Do not auto-submit.

- [ ] **Step 6: Verify**

```bash
cd services/edge-functions && deno lint && deno check src/main.ts
cd ../.. && npx tsc -b && npm run ui:check
```

- [ ] **Step 7: Commit**

```bash
git add services/edge-functions/src/routes/flipdesk-logistics.ts services/edge-functions/src/tests/tenant-isolation_test.ts src/pages/flipdesk
git commit -m "feat(logistics): suggest the parcel instead of making the seller type it"
```

---

### Task 8: Record the prediction so it can be graded

**Files:**
- Create: `supabase/migrations/00648_sales_parcel_prediction.sql` (RE-CHECK the
  number first, see Step 1)
- Modify: `services/edge-functions/src/lib/schema-version.ts`
- Modify: `services/edge-functions/src/routes/flipdesk-logistics.ts` (label purchase)
- Modify: `PENDING_MIGRATIONS.md`
- Test: `services/edge-functions/src/tests/rls-guard_test.ts` if the guard needs it

**Interfaces:**
- Consumes: `estimateParcel`, `PARCEL_TABLE_VERSION`, `RATE_TABLE_VERSION`.
- Produces: `sales.parcel_prediction` jsonb.

- [ ] **Step 1: Load the migrations skill and re-check the number**

Run the `migrations` skill before writing any SQL. It owns the US-1108 triple.
Then confirm the next free migration number: a concurrent agent may have taken
00648 since this plan was written.

```bash
ls supabase/migrations | tail -5
```

- [ ] **Step 2: Write the migration**

Idempotent, with the self-record footer the skill specifies:

```sql
-- 00648: record what the parcel estimator predicted, so it can be compared
-- against what the carrier actually charged (US-2788).
--
-- One nullable jsonb on the row that already exists, not a new table: the
-- comparison is always per sale, and sales.shipping_cost already carries the
-- actual cost from the eBay payout sync. The estimator and rate-table versions
-- travel INSIDE the json so a correction can be attributed to the table that
-- produced it.

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS parcel_prediction jsonb;

COMMENT ON COLUMN public.sales.parcel_prediction IS
  'Estimator output at label-buy time: weight_oz, billable_weight_oz, pack, confidence, basis, parcel_table_version, rate_table_version, estimated_postage_usd. Compared against sales.shipping_cost to correct the weight table.';
```

Add the self-record footer per the skill. Do NOT add a REVOKE: see
`vault/20-domain/postgres-revoke-from-anon-is-a-noop.md` and the standing rule
that a denied anon call segfaults the database. Copy the no-revoke block from
migration `00609`.

- [ ] **Step 3: Bump EXPECTED_SCHEMA_VERSION in the same commit**

Edit `services/edge-functions/src/lib/schema-version.ts` to the new migration
number. Same commit as the SQL, no exceptions; this is the US-1108 triple.

- [ ] **Step 4: Write the prediction when a label is bought**

Task 7 already imported `estimateParcel` and `estimatePostage` into this file.
Extend those imports with the two version constants:

```ts
import { estimateParcel, PACK_DIMENSIONS, PARCEL_TABLE_VERSION } from "../lib/parcel-estimate.ts";
import { estimatePostage, RATE_TABLE_VERSION } from "../lib/shipping-rates.ts";
```

In the `POST /sales/:saleId/label` handler, before or alongside the existing
cost write, store what was predicted:

```ts
  const parcel = estimateParcel({ /* same item fields as Task 7 */ });
  const postage = estimatePostage(parcel.billableWeightOz);
  await supabaseAdmin
    .from("sales")
    .update({
      parcel_prediction: {
        weight_oz: parcel.weightOz,
        billable_weight_oz: parcel.billableWeightOz,
        pack: parcel.pack,
        confidence: parcel.confidence,
        basis: parcel.basis,
        parcel_table_version: PARCEL_TABLE_VERSION,
        rate_table_version: RATE_TABLE_VERSION,
        estimated_postage_usd: postage?.priceUsd ?? null,
      },
    })
    .eq("id", saleId);
```

Scope the update by the owner as well if the surrounding code does; never write
to a sale id from the path without the ownership check already performed by
`preflight`.

- [ ] **Step 5: Verify the migration applies to a fresh schema**

```bash
node scripts/verify.mjs --db
```
Needs Docker running. Expected: the throwaway stack resets and all migrations
apply. This never touches prod.

- [ ] **Step 6: Package it, do not push**

Add an entry to `PENDING_MIGRATIONS.md` describing 00648 and what it does.

**Commit locally and stop.** A commit containing a migration is never pushed
until the owner has applied it to prod and said go. That is a standing rule.

```bash
git add supabase/migrations/00648_sales_parcel_prediction.sql services/edge-functions/src/lib/schema-version.ts services/edge-functions/src/routes/flipdesk-logistics.ts PENDING_MIGRATIONS.md
git commit -m "feat(shipping): record the parcel prediction against the real label cost"
```

- [ ] **Step 7: Tell the owner**

Report that 00648 is committed locally and held, name what it adds, and ask
them to apply it to prod when ready.

---

### Task 9: Full verification

- [ ] **Step 1: Run the whole gate**

```bash
npm run verify
```

Expected: every lane green. Notes from prior sessions that save time here:

- If the build and vitest fail together while tsc and eslint pass, the Vite
  cache is poisoned: `rm -rf node_modules/.vite` and rerun. A poisoned cache
  names the SAME module every run.
- If the run is killed partway, check `\Memory\Available MBytes`. A kill prints
  every remaining lane as failed, which is not a wall of regressions.
- Do not `git stash` while the suite runs. Several guard tests grep the working
  tree and a mid-run stash voids the result rather than failing it.

- [ ] **Step 2: Do not push the migration commit**

Everything through Task 7 is pushable. Task 8 is held. If the branch has both,
push only up to the pre-migration commit, or wait for the owner.
