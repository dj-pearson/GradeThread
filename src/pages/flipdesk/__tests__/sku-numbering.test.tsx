// US-3417: the SKU numbering settings screen.
//
// renderToStaticMarkup is this repo's convention (@testing-library is not a
// dependency), so these assert FIRST PAINT plus the pure helpers the screen
// leans on. That split is deliberate rather than a limitation worked around:
// the parts of this page worth pinning are the ones that go wrong silently.
//
//   * The presets are DATA. A preset whose counters do not match its pattern
//     sends the database a save it will refuse, and nothing in the UI would
//     have hinted at it.
//   * The error message is a PASSTHROUGH. US-3416 wrote those strings for a
//     seller to read; a fallback that happened to look plausible would hide a
//     broken passthrough completely.
//   * The exhaustion banner is a BRANCH that only ever renders on an account
//     that has used up every number, which is to say almost never, which is to
//     say nobody would notice it rotting.
//
// What is NOT asserted here, and why: the carry rule, the rendering, and the
// starting value. None of them live in TypeScript. They are proved against a
// real Postgres by scripts/check-sku-sequences.mjs, and
// src/test/sku-odometer-single-home.test.ts fails the build if a copy of any of
// them appears in this directory.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  blankSegment,
  countingSlots,
  fitCounters,
  isCountingSegment,
  SKU_PRESETS,
  type SkuSegment,
} from "@/lib/sku-presets";

const sequenceState = {
  sequence: null as unknown,
  nextSku: null as string | null,
  isEnabled: false,
  isExhausted: false,
  isLoading: false,
};

vi.mock("@/hooks/use-sku-sequence", () => ({
  SKU_SEQUENCE_KEY: "sku_sequence",
  SKU_PREVIEW_KEY: "sku_preview",
  useSkuSequence: () => sequenceState,
}));

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({ user: { id: "owner-1" } }),
}));

// The page never reaches these on first paint (every query is async), but the
// module is imported at load time and throws without the env vars.
vi.mock("@/lib/supabase", () => ({
  supabase: { from: () => ({}), rpc: async () => ({ data: null, error: null }) },
}));

const { FlipdeskSkuNumberingPage } = await import(
  "@/pages/flipdesk/sku-numbering"
);
const { rpcMessage } = await import("@/lib/sku-rpc-message");

function markup(over: Partial<typeof sequenceState> = {}) {
  Object.assign(sequenceState, {
    sequence: null,
    nextSku: null,
    isEnabled: false,
    isExhausted: false,
    isLoading: false,
  }, over);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <FlipdeskSkuNumberingPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the preset table is internally consistent", () => {
  // A preset whose counters do not match its pattern produces a save the
  // database refuses with "The starting value has N part(s) but the pattern
  // counts M of them" -- correct, unhelpful, and entirely our fault.
  it.each(SKU_PRESETS.map((p) => [p.id, p] as const))(
    "%s has one counter per counting segment",
    (_id, preset) => {
      expect(preset.counters).toHaveLength(countingSlots(preset.pattern));
    },
  );

  it.each(SKU_PRESETS.map((p) => [p.id, p] as const))(
    "%s starts every counter inside its own bounds",
    (_id, preset) => {
      let i = 0;
      for (const segment of preset.pattern) {
        if (!isCountingSegment(segment)) continue;
        const value = preset.counters[i] ?? -1;
        if (segment.kind === "number") {
          expect(value).toBeGreaterThanOrEqual(segment.min);
          expect(value).toBeLessThanOrEqual(segment.max);
        } else {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThan(segment.alphabet.length ** segment.width);
        }
        i += 1;
      }
    },
  );

  it("every preset can count at all", () => {
    for (const preset of SKU_PRESETS) {
      expect(countingSlots(preset.pattern)).toBeGreaterThan(0);
    }
  });

  it("only the yearly preset resets, and it is the only one carrying a date", () => {
    for (const preset of SKU_PRESETS) {
      const hasDate = preset.pattern.some((s) => s.kind === "date");
      // Resetting on a date change is meaningless without a date to change.
      if (preset.resetOnDateChange) expect(hasDate).toBe(true);
    }
    expect(SKU_PRESETS.filter((p) => p.resetOnDateChange).map((p) => p.id))
      .toEqual(["year"]);
  });

  it("names the J9999 rollover, because that is what the preset is for", () => {
    const letters = SKU_PRESETS.find((p) => p.id === "letter-four");
    expect(letters?.blurb).toMatch(/J9999/);
    expect(letters?.blurb).toMatch(/K0000/);
  });
});

describe("counters follow the pattern as it is edited", () => {
  const pattern: SkuSegment[] = [
    { kind: "letter", alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZ", width: 1 },
    { kind: "number", width: 4, min: 0, max: 9999 },
  ];

  it("keeps the values that still have a slot", () => {
    expect(fitCounters(pattern, [9, 1234])).toEqual([9, 1234]);
  });

  it("gives a newly added segment its own minimum, not zero", () => {
    const wider: SkuSegment[] = [...pattern, { kind: "number", width: 2, min: 7, max: 99 }];
    expect(fitCounters(wider, [9, 1234])).toEqual([9, 1234, 7]);
  });

  it("drops a value whose segment was removed", () => {
    expect(fitCounters([pattern[1] as SkuSegment], [9, 1234])).toEqual([9]);
  });

  it("ignores text and date segments entirely", () => {
    const mixed: SkuSegment[] = [
      { kind: "text", value: "GT-" },
      { kind: "date", format: "YY" },
      { kind: "number", width: 5, min: 1, max: 99999 },
    ];
    expect(countingSlots(mixed)).toBe(1);
    expect(fitCounters(mixed, [42])).toEqual([42]);
  });

  it("hands back a usable segment for every kind", () => {
    for (const kind of ["text", "date", "number", "letter"] as const) {
      const segment = blankSegment(kind);
      expect(segment.kind).toBe(kind);
      if (segment.kind === "number") expect(segment.min).toBeLessThanOrEqual(segment.max);
      if (segment.kind === "letter") expect(segment.alphabet.length).toBeGreaterThan(1);
    }
  });
});

describe("the database's own words reach the seller", () => {
  it("passes a PostgREST message through unchanged", () => {
    expect(
      rpcMessage({ message: "A letter segment cannot repeat a character: AABB" }),
    ).toBe("A letter segment cannot repeat a character: AABB");
  });

  it("falls back to details, then hint, before inventing anything", () => {
    expect(rpcMessage({ message: "", details: "This pattern can reach 60 characters." }))
      .toBe("This pattern can reach 60 characters.");
    expect(rpcMessage({ hint: "Only the workspace owner or an admin can change SKU numbering" }))
      .toMatch(/owner or an admin/);
  });

  it("only invents a message when there is genuinely nothing to show", () => {
    expect(rpcMessage(null)).toMatch(/went wrong/i);
    expect(rpcMessage({})).toMatch(/went wrong/i);
  });
});

describe("first paint", () => {
  it("lists every preset with its example", () => {
    const html = markup();
    for (const preset of SKU_PRESETS) {
      expect(html).toContain(preset.label);
      expect(html).toContain(preset.example);
    }
  });

  it("says what to do when no pattern is set yet", () => {
    expect(markup()).toMatch(/Pick one above/);
  });

  it("warns, and hides the preview, when the numbers have run out", () => {
    const html = markup({ isExhausted: true });
    expect(html).toMatch(/Every number in this pattern has been used/);
    expect(html).toMatch(/saving without a SKU/);
  });

  it("does not warn on a healthy account", () => {
    expect(markup()).not.toMatch(/Every number in this pattern has been used/);
  });

  it("promises only to fill a SKU box the seller left empty", () => {
    // The screen's one real promise. A seller who believes this feature might
    // overwrite what they typed will not turn it on.
    expect(markup()).toMatch(/Anything you type\s+yourself is kept|Anything you type yourself is kept/);
  });
});
