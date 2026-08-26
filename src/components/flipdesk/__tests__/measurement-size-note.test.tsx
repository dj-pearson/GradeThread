// US-2918: the size-versus-measurements note in MeasurementForm.
//
// Rendered with renderToStaticMarkup (this repo's convention — no
// @testing-library), which is enough for every claim that matters here: exactly
// one note, both numbers named, the tier stated, the fix button present only
// when the caller can write a size, and an accessible name that says which
// field and which value.
//
// The band table is stubbed at the fetch layer rather than mocked deeper, so
// the component's own query wiring is what is under test.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SizeBandsResponse } from "@/lib/size-check";

const LULULEMON_MENS_TOPS: SizeBandsResponse = {
  tier: "brand",
  brandLabel: "Lululemon",
  department: "Men",
  garment: "Tops",
  sourceUrl: "https://shop.lululemon.com/help/size-guide",
  sizeSystem: "alpha",
  sizeClass: "standard",
  measurementBasis: "body",
  rows: [
    { size: "XS", index: 0, bands: { chest: [18, 22.5] } },
    { size: "S", index: 1, bands: { chest: [19, 23.5] } },
    { size: "M", index: 2, bands: { chest: [20.5, 25] } },
    { size: "L", index: 3, bands: { chest: [22, 26.5] } },
    { size: "XL", index: 4, bands: { chest: [23.5, 28] } },
    { size: "XXL", index: 5, bands: { chest: [25, 29.5] } },
  ],
};

const bands = vi.hoisted(() => ({ current: null as SizeBandsResponse | null }));

vi.mock("@/lib/size-bands", async () => {
  const actual = await vi.importActual<typeof import("@/lib/size-bands")>(
    "@/lib/size-bands",
  );
  return {
    ...actual,
    fetchSizeBands: vi.fn(async () => bands.current ?? actual.NO_SIZE_BANDS),
  };
});

// The cohort note (US-2827) shares this form. Silence it so these assertions
// are about the size note; the "both can be visible" case turns it back on.
const drift = vi.hoisted(() => ({ p25: null as number | null, p75: null as number | null }));
vi.mock("@/lib/measurement-drift", async () => {
  const actual = await vi.importActual<typeof import("@/lib/measurement-drift")>(
    "@/lib/measurement-drift",
  );
  return {
    ...actual,
    fetchMeasurementDrift: vi.fn(async () => actual.EMPTY_DRIFT),
    bandFor: vi.fn(() =>
      drift.p25 === null
        ? null
        : { key: "chest", cohortP25: drift.p25, cohortP75: drift.p75 },
    ),
  };
});

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({ user: { id: "u1" } }),
}));

const { MeasurementForm } = await import("@/components/flipdesk/measurement-form");

async function render(props: Record<string, unknown>): Promise<string> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Prime the cache so the static render sees resolved data — renderToStaticMarkup
  // has no second pass to wait for a suspended query.
  const { fetchSizeBands, sizeBandsQueryKey } = await import("@/lib/size-bands");
  const brand = (props.brand as string | null) ?? null;
  const garment = (props.garmentCategory as string | null) ??
    (props.category as string | null) ?? null;
  const gender = (props.gender as string | null) ?? null;
  qc.setQueryData(
    sizeBandsQueryKey(brand, garment, gender),
    await fetchSizeBands(brand, garment, gender),
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <MeasurementForm {...(props as any)} />
    </QueryClientProvider>,
  );
}

const BASE = {
  category: "tee",
  garmentCategory: "tee",
  brand: "Lululemon",
  gender: "Men",
  values: { chest: 17.5 },
  onChange: () => {},
  size: "Large",
};

beforeEach(() => {
  bands.current = LULULEMON_MENS_TOPS;
  drift.p25 = null;
  drift.p75 = null;
});

describe("the discrepancy note", () => {
  it("names both numbers in plain words", async () => {
    const html = await render({ ...BASE, onSizeChange: () => {} });
    expect(html).toContain("Measurements point to smaller than XS, not Large.");
    expect(html).toContain("A Large usually measures 22 to 26.5 in here.");
  });

  it("renders at most ONE note per form", async () => {
    const html = await render({ ...BASE, onSizeChange: () => {} });
    const hits = html.split("Measurements point to").length - 1;
    expect(hits).toBe(1);
  });

  it("stays quiet on a correctly sized item", async () => {
    const html = await render({
      ...BASE,
      values: { chest: 23 },
      onSizeChange: () => {},
    });
    expect(html).not.toContain("Measurements point to");
  });

  it("says nothing at all when there is no chart", async () => {
    const { NO_SIZE_BANDS } = await import("@/lib/size-bands");
    bands.current = NO_SIZE_BANDS;
    const html = await render({ ...BASE, onSizeChange: () => {} });
    expect(html).not.toContain("Measurements point to");
  });
});

describe("the chart tier", () => {
  it("a generic chart says out loud that it is an estimate", async () => {
    bands.current = { ...LULULEMON_MENS_TOPS, tier: "generic", brandLabel: null };
    const html = await render({ ...BASE, onSizeChange: () => {} });
    expect(html).toContain("Estimate only — no brand chart on file.");
  });

  it("a brand chart does not", async () => {
    const html = await render({ ...BASE, onSizeChange: () => {} });
    expect(html).not.toContain("Estimate only");
  });
});

describe("the one-click fix", () => {
  it("is absent when the implied size is off the end of the chart", async () => {
    // "smaller than XS" is not a size Lululemon makes, so there is nothing to
    // change TO — the seller has to decide. A button here would write a
    // meaningless string into the size column.
    const html = await render({ ...BASE, onSizeChange: () => {} });
    expect(html).not.toContain("Change to");
  });

  it("offers the implied size when the brand makes it, with an accessible name", async () => {
    const html = await render({
      ...BASE,
      size: "XXL",
      values: { chest: 22.5 },
      onSizeChange: () => {},
    });
    expect(html).toContain("Change to");
    // US-2450: the visible word alone is ambiguous on a form of five buttons.
    expect(html).toContain('aria-label="Change the size from XXL to');
  });

  it("renders the note with no button when the caller cannot write a size", async () => {
    const html = await render({ ...BASE, size: "XXL", values: { chest: 22.5 } });
    expect(html).toContain("Measurements point to");
    expect(html).not.toContain("Change to");
  });
});

describe("living beside the US-2827 cohort note", () => {
  it("both can show without repeating the same point", async () => {
    drift.p25 = 21;
    drift.p75 = 24;
    const html = await render({ ...BASE, onSizeChange: () => {} });
    expect(html).toContain("Measurements point to smaller than XS");
    expect(html).toContain("Most size LARGE measure 21");
    // Each has its own dismiss control, named for what it silences.
    expect(html).toContain("Dismiss the size-versus-measurements check");
    expect(html).toContain("Dismiss the size check on Chest (pit to pit)");
  });
});

describe("the size guide link", () => {
  it("points at the brand's own guide when the chart carries one", async () => {
    const html = await render({ ...BASE, onSizeChange: () => {} });
    expect(html).toContain("https://shop.lululemon.com/help/size-guide");
    expect(html).not.toContain("google.com/search");
  });

  it("falls back to the search when the chart has no source URL", async () => {
    bands.current = { ...LULULEMON_MENS_TOPS, sourceUrl: null };
    const html = await render({ ...BASE, onSizeChange: () => {} });
    expect(html).toContain("google.com/search");
  });
});
