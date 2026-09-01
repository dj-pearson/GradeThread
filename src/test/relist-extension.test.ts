import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  chunkForBulkRelist,
  mergeBulkRelistResponses,
  type BulkRelistResponse,
} from "@/hooks/use-relist-extension";

// US-9203: relist on the extension channels, web half. The button copies
// through the extension (or the desktop queue), the bulk action chunks like
// bulk price, and nothing on this side says "relisted" before the copy is live.

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("bulk relist", () => {
  it("chunks like bulk price", () => {
    expect(chunkForBulkRelist(["a", "b", "c"], 2)).toEqual([["a", "b"], ["c"]]);
    expect(chunkForBulkRelist([], 2)).toEqual([]);
  });

  it("merges chunks and counts queued rows apart from eBay relists", () => {
    const part = (results: BulkRelistResponse["results"]): BulkRelistResponse => ({
      ok: true,
      total: results.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      queued: results.filter((r) => r.ok && r.mode === "queued").length,
      results,
    });
    const merged = mergeBulkRelistResponses([
      part([{ listing_id: "a", ok: true, mode: "ebay" }, { listing_id: "b", ok: true, mode: "queued" }]),
      part([{ listing_id: "c", ok: false, error: "not found" }]),
    ]);
    expect(merged).toMatchObject({ total: 3, succeeded: 2, failed: 1, queued: 1 });
  });

  it("is wired on the listings page and Pro-gated on the server", () => {
    expect(read("src/pages/flipdesk/listings.tsx")).toMatch(/onClick=\{bulkRelist\}/);
    expect(read("src/pages/flipdesk/listings-actions.ts")).toMatch(/async function bulkRelist\(\)/);
    expect(read("services/edge-functions/src/routes/flipdesk-listings.ts")).toMatch(
      /"\/bulk-relist"[\s\S]*?feature: "autoRelist"/,
    );
  });
});

describe("the Relist button reaches extension rows", () => {
  const src = read("src/pages/flipdesk/listings-table.tsx");
  it("offers Relist on ended and live extension-channel rows", () => {
    expect(src).toMatch(/if \(isRelist && isExtensionRow\(it\)\)/);
    expect(src).toMatch(/\{isExtensionRow\(it\) && \(/);
    expect(src).toMatch(/MARKETPLACE_MECHANISM\[row\.listing_platform\] === "extension"/);
  });
  it("never says relisted before the copy is live", () => {
    expect(src).toMatch(/old listing is ended once/);
    expect(src).not.toMatch(/toast\.success\("Relisted/);
  });
});

describe("the automation log", () => {
  it("says queued for an extension relist and applied for eBay", () => {
    const src = read("src/pages/flipdesk/automations.tsx");
    expect(src).toMatch(/a\.action_type === "relist" && a\.after_json\?\.queued === true/);
    expect(src).toMatch(/ended, back in Drafts/);
  });
});
