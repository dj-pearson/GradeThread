import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SWITCH_FROM_PAGES, switchFromPath, switchFromRoutes } from "@/lib/seo/switch-from";
import { SWITCH_FROM_SLUGS } from "@/lib/seo/switch-from-slugs";
import { PUBLIC_ROUTES } from "@/lib/seo/public-routes";
import { KEYWORD_TARGETS } from "@/lib/seo/keyword-targets";

// US-9209: the two switch-from pages are registered everywhere a public page
// must be, keep the honesty doctrine, and say what does NOT transfer.

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("switch-from pages (US-9209)", () => {
  it("slugs, data and routes agree", () => {
    expect(SWITCH_FROM_PAGES.map((p) => p.slug).sort()).toEqual([...SWITCH_FROM_SLUGS].sort());
    for (const r of switchFromRoutes()) {
      expect(PUBLIC_ROUTES.some((p) => p.path === r.path), r.path).toBe(true);
    }
    expect(switchFromPath("vendoo")).toBe("/reselling/switch-from-vendoo");
  });
  it("is prerendered and routed", () => {
    const entry = read("src/prerender/entry-server.tsx");
    expect(entry).toMatch(/SWITCH_FROM_PAGES\.map/);
    expect(entry).toMatch(/marketing\/switch-from`/);
    expect(read("src/routes/index.tsx")).toMatch(/SWITCH_FROM_SLUGS\.map/);
    expect(read("src/prerender/head-builder.ts")).toMatch(/getSwitchFromByPath/);
  });
  it("keeps the honesty doctrine: no prices, no version numbers, no 'broken'", () => {
    for (const p of SWITCH_FROM_PAGES) {
      const text = [p.title, p.h1, p.description, p.definition, ...p.transfers, ...p.doesNotTransfer, ...p.steps, ...p.faqs.flatMap((f) => [f.q, f.a])].join("\n");
      expect(text).not.toMatch(/\$\d/);
      expect(text).not.toMatch(/\bv?\d+\.\d+(\.\d+)?\b/);
      expect(text).not.toMatch(/broken/i);
    }
  });
  it("says what does not transfer next to what does, and names the live-listing gap", () => {
    for (const p of SWITCH_FROM_PAGES) {
      expect(p.transfers.length).toBeGreaterThanOrEqual(4);
      expect(p.doesNotTransfer.length).toBeGreaterThanOrEqual(3);
      expect(p.doesNotTransfer.join(" ")).toMatch(/Live listings/);
      expect(p.doesNotTransfer.join(" ")).toMatch(/Photos/);
    }
  });
  it("has a keyword target row each", () => {
    for (const p of SWITCH_FROM_PAGES) {
      expect(KEYWORD_TARGETS.some((k) => k.path === switchFromPath(p.slug)), p.slug).toBe(true);
    }
  });
  it("the alternative pages link to them", () => {
    expect(read("src/pages/marketing/competitor-alternative.tsx")).toMatch(/switchFromPath\(/);
  });
});
