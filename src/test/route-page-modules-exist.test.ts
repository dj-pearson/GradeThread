import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ROUTE_PAGE_MODULES } from "@/prerender/entry-server";

// US-9009. The existing lockstep guard in entry-server.tsx checks that
// ROUTE_PAGE_MODULES and PAGES have the SAME KEYS. It never checks that the
// value is a real file, and the prerender degrades a bad one to a single
// warning and no preload — which is precisely the US-1950 regression the map
// exists to prevent, arriving silently.
//
// It happened. US-9005 put four fee calculators in one parameterised component,
// and the map derived "src/pages/tools/{slug}" for all four, so four routes
// pointed at files that do not exist. The build stayed green and printed one
// warning that scrolled past in 226 lines of prerender output.
//
// A guard that only compares two lists it generated from the same source can
// only catch a typo. This one goes to disk.

const EXTENSIONS = [".tsx", ".ts"];

describe("ROUTE_PAGE_MODULES points at files that exist (US-9009)", () => {
  const entries = Object.entries(ROUTE_PAGE_MODULES);

  it("has entries to check", () => {
    expect(entries.length).toBeGreaterThan(50);
  });

  it("resolves every module id to a real source file", () => {
    const root = resolve(__dirname, "../..");
    const missing: string[] = [];
    for (const [routePath, moduleId] of entries) {
      const found = EXTENSIONS.some((ext) => existsSync(resolve(root, moduleId + ext)));
      if (!found) missing.push(`${routePath} -> ${moduleId}`);
    }
    expect(
      missing,
      "these routes preload a page module that does not exist on disk, so their " +
        "chunk is never preloaded:\n  " +
        missing.join("\n  "),
    ).toEqual([]);
  });

  it("keeps every module id under src/pages/", () => {
    for (const [routePath, moduleId] of entries) {
      expect(moduleId.startsWith("src/pages/"), `${routePath} -> ${moduleId}`).toBe(true);
    }
  });

  it("allows several routes to share one module, which is why this guard is needed", () => {
    const byModule = new Map<string, string[]>();
    for (const [routePath, moduleId] of entries) {
      byModule.set(moduleId, [...(byModule.get(moduleId) ?? []), routePath]);
    }
    const shared = [...byModule.values()].filter((paths) => paths.length > 1);
    expect(shared.length).toBeGreaterThan(0);
  });
});
