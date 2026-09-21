// US-3444: what the AI badge on a measurement field actually says.
//
// The form used to redeclare the ai_field_sources entry shape locally as
// `{ source, confidence, accepted: boolean }` and read `ai.confidence` straight
// off it. Two shapes in production break that:
//
//   "photo:tag"                          Android writes the source alone
//   { source: "manual", measuredAt }     the seller measured it off a photo
//
// The first rendered `NaN% confident, undefined`; the second rendered an AI
// badge over a hand measurement, with `NaN% confident, manual`. Asserting what
// is RENDERED rather than that a narrowing function exists is the point:
// US-3352's AC5 says this class of bug hid precisely by existing and not being
// presented.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/size-bands", async () => {
  const actual = await vi.importActual<typeof import("@/lib/size-bands")>(
    "@/lib/size-bands",
  );
  return { ...actual, fetchSizeBands: vi.fn(async () => actual.NO_SIZE_BANDS) };
});

vi.mock("@/lib/measurement-drift", async () => {
  const actual = await vi.importActual<typeof import("@/lib/measurement-drift")>(
    "@/lib/measurement-drift",
  );
  return {
    ...actual,
    fetchMeasurementDrift: vi.fn(async () => actual.EMPTY_DRIFT),
    bandFor: vi.fn(() => null),
  };
});

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({ user: { id: "u1" } }),
}));

const { MeasurementForm } = await import("@/components/flipdesk/measurement-form");
type AiFieldSourceEntry = import("@/types/database").AiFieldSourceEntry;

function render(aiSources: Record<string, unknown> | null): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MeasurementForm
        category="tee"
        garmentCategory="tee"
        brand="Lululemon"
        gender="Men"
        values={{ chest: 17.5 }}
        onChange={() => {}}
        aiSources={aiSources as Record<string, AiFieldSourceEntry> | null}
      />
    </QueryClientProvider>,
  );
}

const badges = (html: string) =>
  [...html.matchAll(/title="([^"]*?)"[^>]*>AI</g)].map((m) => m[1]);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the AI badge on a measurement field (US-3444)", () => {
  it("names the confidence and the source when the entry carries them", () => {
    const html = render({
      "measurements.chest": { source: "photo:front", confidence: 0.82 },
    });
    expect(badges(html)).toHaveLength(1);
    expect(badges(html)[0]).toContain("82% confident");
    expect(badges(html)[0]).toContain("photo:front");
    expect(html).not.toContain("NaN");
  });

  it("still badges Android's bare string, and says no confidence was recorded", () => {
    // The string says an AI pass wrote it, which is worth showing. What it
    // must not do is invent a number.
    const html = render({ "measurements.chest": "photo:tag" });
    expect(badges(html)).toHaveLength(1);
    expect(badges(html)[0]).toContain("No confidence was recorded");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
  });

  it("does NOT badge a measurement the seller took off a photo", () => {
    // measurement-photo-editor.tsx writes this for every field the seller
    // measured. Calling it AI is a false claim about who put the number there.
    const html = render({
      "measurements.chest": { source: "manual", measuredAt: "2026-09-20" },
    });
    expect(badges(html)).toEqual([]);
    expect(html).not.toContain("NaN");
  });

  it("renders no badge when there is no entry at all", () => {
    expect(badges(render(null))).toEqual([]);
    expect(badges(render({}))).toEqual([]);
  });

  it("looks the entry up per field, not per form", () => {
    // One entry badges exactly one field. `sleeve` IS in the tee template, so
    // this asserts the lookup rather than an absence -- the first draft used
    // sleeve expecting nothing and was wrong about the template.
    const html = render({ "measurements.sleeve": "photo:tag" });
    expect(badges(html)).toHaveLength(1);
    const chestLabel = html.slice(html.indexOf("Chest"), html.indexOf("Chest") + 400);
    expect(chestLabel).not.toContain(">AI<");
  });

  it("ignores an entry for a field this template does not render", () => {
    expect(badges(render({ "measurements.inseam": "photo:tag" }))).toEqual([]);
  });
});
