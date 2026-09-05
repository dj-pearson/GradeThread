import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { widgetsForSurface } from "@/lib/dashboard-widgets";

// US-3079 AC3: the rail's Refresh control invalidates the queryKey prefixes the
// REGISTRY declares, so a widget added later is refreshed on the commit that
// registers it, with no edit to attention-rail.tsx.
//
// That only works while the registry is honest. A widget that reads data and
// declares no queryKeys is silently exempt from Refresh: the seller presses it,
// every other number updates, and that one keeps showing yesterday's. Nothing
// errors, which is the whole problem — it is the same shape as US-2167's cache
// peek at a key nobody writes.
//
// So this pairs the declaration against the component: if the file calls
// useQuery, the registry entry must name at least one key. The exemptions below
// are the widgets that genuinely fetch nothing, each checked rather than
// asserted, and the second case fails if one of them starts fetching.

const EXEMPT = new Map<string, string>([
  [
    "grading.plan",
    "renders the plan already in the auth store; no fetch of its own",
  ],
  ["grading.quick-actions", "static links"],
  ["grading.get-apps", "static store URLs from src/lib/app-links.ts"],
  [
    "flipdesk.forecast",
    "the forecast is a MUTATION the seller fires by pressing Forecast, not a " +
    "query a board refresh could re-run",
  ],
]);

function sourceOf(load: string): string | null {
  const m = /@\/([^"']+)/.exec(load);
  if (!m?.[1]) return null;
  for (const ext of [".tsx", ".ts"]) {
    try {
      return readFileSync(resolve(process.cwd(), "src", m[1] + ext), "utf8");
    } catch {
      // try the next extension
    }
  }
  return null;
}

const ALL = [...widgetsForSurface("grading"), ...widgetsForSurface("flipdesk")];

describe("US-3079 AC3: every data widget declares its queryKeys", () => {
  it("the registry is non-empty", () => {
    // Without this the whole file passes vacuously if widgetsForSurface ever
    // returns nothing.
    expect(ALL.length).toBeGreaterThan(20);
  });

  it("declares queryKeys wherever the component fetches", () => {
    const offenders: string[] = [];
    for (const w of ALL) {
      if (w.queryKeys.length > 0) continue;
      if (EXEMPT.has(w.id)) continue;
      const src = sourceOf(String(w.load));
      if (src == null) {
        offenders.push(`${w.id} (source not resolvable — check this by hand)`);
        continue;
      }
      if (/\buseQuery\b|\buseSuspenseQuery\b|\buseInfiniteQuery\b/.test(src)) {
        offenders.push(w.id);
      }
    }
    expect(
      offenders,
      "these widgets fetch data but declare no queryKeys, so the attention " +
        "rail's Refresh cannot reach them. Add the key(s) to the registry " +
        "entry, or add the widget to EXEMPT with the reason it fetches nothing.",
    ).toEqual([]);
  });

  it("every exemption still fetches nothing", () => {
    // An exemption is a claim about the component, and components change. This
    // is the direction that rots: a widget listed here quietly gains a
    // useQuery, and the list keeps vouching for it.
    const nowFetching: string[] = [];
    for (const id of EXEMPT.keys()) {
      const w = ALL.find((x) => x.id === id);
      expect(w, `EXEMPT names ${id}, which is not in the registry`).toBeTruthy();
      const src = sourceOf(String(w!.load));
      if (src == null) continue;
      if (/\buseQuery\b|\buseSuspenseQuery\b|\buseInfiniteQuery\b/.test(src)) {
        nowFetching.push(id);
      }
    }
    expect(
      nowFetching,
      "these are exempt from the queryKeys rule but now fetch data. Give them " +
        "queryKeys and remove the exemption.",
    ).toEqual([]);
  });

  it("no exemption names a widget that already declares keys", () => {
    // The list may only shrink. An entry that stopped being needed is dead
    // weight that makes the next reader trust it less.
    const pointless = [...EXEMPT.keys()].filter((id) => {
      const w = ALL.find((x) => x.id === id);
      return w != null && w.queryKeys.length > 0;
    });
    expect(pointless).toEqual([]);
  });
});
