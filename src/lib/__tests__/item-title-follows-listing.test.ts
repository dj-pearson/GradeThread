// US-2593: `inventory_items.title` and `listings.listing_title` are two copies
// of the same sentence, and only the listing one ever moved. A seller renamed
// "Lululemon Men's ABC Pants Slate Blue Straight Fit Size Medium" to "… Size
// 36", saved, and pushed it to eBay — eBay showed the new title, the Inventory
// tab of their synced Google Sheet showed the old one, forever. The Inventory
// tab reads inventory_items.title, and nothing on the composer or the revise
// path had ever written that column.
//
// The rule the owner chose: the item title FOLLOWS the listing title, and for
// Google Sheets the GradeThread title is the truth. These are source assertions
// for the same reason the other composer guards are (see composer-source.ts) —
// what they protect is a write that fails silently.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composerPage } from "./helpers/composer-source";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("the composer writes the item title on every save", () => {
  it("has a patch that puts the effective title on the item row", () => {
    expect(composerPage).toMatch(/function itemTitlePatch\(titlePatch: TitleSyncPatch\)/);
    // The SUBSTITUTED title when the write-back made one, else the form's.
    expect(composerPage).toMatch(
      /typeof titlePatch\.listing_title === "string" \? titlePatch\.listing_title : title/,
    );
    // Never blank: the column is NOT NULL.
    expect(composerPage).toMatch(/return next \? \{ title: next \} : \{\};/);
  });

  it("folds it into the item patch both save paths share", () => {
    expect(composerPage).toContain("...itemTitlePatch(titlePatch),");
    const calls = composerPage.match(/(?<!function )composerItemPatch\(\s/g) ?? [];
    expect(calls.length, "saveDraft and saveLiveListing").toBe(2);
  });

  it("computes the title patch BEFORE the item write, in both paths", () => {
    // The item row is written first (the aspect-provenance contract), so the
    // substitution has to be resolved before it or the item keeps the old words.
    for (const isLive of ["false", "true"]) {
      const at = composerPage.indexOf(`titleSyncPatchFor(${isLive})`);
      expect(at, `titleSyncPatchFor(${isLive}) is gone`).toBeGreaterThan(-1);
      const after = composerPage.slice(at);
      const write = after.search(/\.from\("inventory_items"\)\s*\.update\(itemPatch/);
      expect(write, `no item write after titleSyncPatchFor(${isLive})`).toBeGreaterThan(-1);
      // And the patch is built between the two.
      const built = after.search(/composerItemPatch\(/);
      expect(built).toBeGreaterThan(-1);
      expect(built).toBeLessThan(write);
    }
  });
});

describe("the eBay revise carries the same rule server-side", () => {
  const route = read("services/edge-functions/src/routes/flipdesk-ebay.ts");

  it("updates inventory_items.title when the revise changes the title", () => {
    expect(route).toMatch(/const revisedTitle = hasTitle \? \(nextTitle as string\)\.trim\(\) : "";/);
    expect(route).toMatch(/\.update\(\{ title: revisedTitle \}\)/);
  });

  it("stays tenant-scoped (US-268 — the edge client bypasses RLS)", () => {
    const at = route.indexOf(".update({ title: revisedTitle })");
    expect(at).toBeGreaterThan(-1);
    expect(route.slice(at, at + 200)).toContain('.eq("user_id", userId)');
  });
});

describe("Google Sheets treats the GradeThread title as the truth", () => {
  const sync = read("services/edge-functions/src/lib/sheet-sync.ts");
  const map = read("services/edge-functions/src/lib/sheet-map.ts");

  it("the classic Inventory Title column is not writable", () => {
    expect(sync).toContain('{ header: "Title", field: "title", kind: "string" },');
    expect(sync).not.toContain(
      '{ header: "Title", field: "title", kind: "string", writable: true },',
    );
  });

  it("a mapped Title column is create-only, not pull-on-edit", () => {
    expect(map).toMatch(/if \(col\.field === "title" && dbValue !== ""\) \{/);
  });
});
