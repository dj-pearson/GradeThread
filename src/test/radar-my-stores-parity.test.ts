import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PersonalStoreSort } from "@/hooks/use-radar-stores";

// The full-surface review's ONE unfinished check, now done.
//
// Its cross-platform gap table listed:
//
//   | 6 | "My stores" (Radar store linking) | web `sourcing.tsx` tab; needs a
//     final targeted check | P3 |
//
// and no story was ever filed against it, because the check was never made. It
// resolves as NOT A GAP. iOS calls the same `/api/flipdesk/radar/my-stores`
// endpoint the web hook does, and renders the result — it just does not have a
// tab called "My stores", which is what the grep behind the finding was looking
// for. The finding was a search for a NAME rather than for the CAPABILITY, the
// same mistake recorded twice already this loop (US-2510, US-2556).
//
// The one honest asymmetry is the sort, and it is pinned below rather than
// waved past.

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

const WEB_HOOK = "src/hooks/use-radar-stores.ts";
const IOS_SERVICE = "ios/GradeThread/Prospect/RadarService.swift";
const IOS_STORE = "ios/GradeThread/Prospect/RadarStore.swift";
const IOS_VIEW = "ios/GradeThread/Prospect/RadarNearbyView.swift";
const ENDPOINT = "/api/flipdesk/radar/my-stores";

describe("My stores is at parity, in substance (review gap 6)", () => {
  it("both clients call the same endpoint", () => {
    expect(read(WEB_HOOK)).toContain(ENDPOINT);
    expect(read(IOS_SERVICE)).toContain(ENDPOINT);
  });

  it("iOS RENDERS it, rather than only fetching it", () => {
    // The distinction that makes this parity rather than a dead call. A client
    // can hold a payload and show nothing, which is indistinguishable from the
    // gap the review suspected.
    const store = read(IOS_STORE);
    expect(store).toContain("service.myStores(");
    expect(store).toContain("personal = payload.stores");

    const view = read(IOS_VIEW);
    expect(view).toContain("PersonalSummaryRow");
    expect(view).toContain("sourced here");
  });

  it("iOS handles the failure rather than showing an empty list", () => {
    // An empty list on a failed read is exactly how a working feature looks
    // broken, and it is the shape this loop has fixed on the web repeatedly.
    const store = read(IOS_STORE);
    expect(store).toContain("personalError");
    const view = read(IOS_VIEW);
    expect(view).toContain("store.personalError");
    expect(view).toContain("store.isLoadingPersonal");
  });

  it("the sort iOS asks for is one the web type allows", () => {
    // The honest asymmetry: web offers eight sorts behind a Select, iOS asks for
    // ROI and does not offer a control. That is a LESSER surface, not a
    // different one — the data and the endpoint are identical — so it is
    // recorded here rather than filed as a gap. What would be a real bug is iOS
    // sending a sort the server does not accept, since the route silently falls
    // back to its default and the screen would be sorted by something other
    // than what the client believes.
    const ios = read(IOS_SERVICE);
    const m = /myStores\(sort: "([a-z_]+)"\)/.exec(read(IOS_STORE));
    expect(m, "iOS no longer passes a literal sort — re-check this").toBeTruthy();
    const iosSort = m![1]! as PersonalStoreSort;

    const web = read(WEB_HOOK);
    const block = /export type PersonalStoreSort =([\s\S]*?);/.exec(web);
    expect(block, "PersonalStoreSort moved").toBeTruthy();
    const allowed = [...block![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
    expect(allowed.length).toBeGreaterThan(1);
    expect(allowed, `iOS asks for "${iosSort}", which the web type does not list`)
      .toContain(iosSort);

    // And the sort really is sent, not dropped.
    expect(ios).toContain('URLQueryItem(name: "sort"');
  });

  it("the server falls back rather than erroring on an unknown sort", () => {
    // Why the check above is a warning and not a crash: a bad sort is accepted
    // and quietly replaced, so nothing would report it at runtime.
    const route = read("services/edge-functions/src/routes/flipdesk-radar.ts");
    expect(route).toContain("isPersonalStoreSort(raw) ? raw : DEFAULT_PERSONAL_STORE_SORT");
  });
});

describe("the review's record of this is corrected", () => {
  it("the findings note the check was completed", () => {
    // A review that leaves an item saying "needs a final targeted check"
    // forever is a review with an open question presented as a finished
    // document. The correction lives beside the existing B06 one.
    const findings = read("docs/reviews/full-surface-2026-08/REVIEW-FINDINGS.md");
    expect(findings).toContain("Correction to the cross-platform gap table");
    expect(findings).toContain(ENDPOINT);
  });
});
