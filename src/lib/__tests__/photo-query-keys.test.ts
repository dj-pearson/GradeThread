import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { itemPhotoQueryKeys } from "@/lib/photo-query-keys";

/**
 * US-2888. The bug was an omission, so the test is about completeness.
 *
 * PhotoManager invalidated `item_photos` and `items_full` and stopped there.
 * The MeasureCard panel mounts beside it and reads two OTHER keys, so a rotate
 * refreshed the gallery and left the measurements panel rendering the old
 * image. Nothing failed; the seller learned to reload the page.
 */
describe("itemPhotoQueryKeys", () => {
  const keys = itemPhotoQueryKeys("item-1");
  const flat = keys.map((k) => JSON.stringify(k));

  it("reaches the gallery and the Listings cover", () => {
    expect(flat).toContain(JSON.stringify(["item_photos", "item-1"]));
    // Un-scoped on purpose: the Listings table's cover query keys under the
    // prefix, not under the item id.
    expect(flat).toContain(JSON.stringify(["items_full"]));
  });

  it("reaches the MeasureCard panel and its generated render", () => {
    expect(flat).toContain(JSON.stringify(["measure_photo", "item-1"]));
    expect(flat).toContain(JSON.stringify(["measure_overlay", "item-1"]));
  });

  it("scopes everything it can to the item", () => {
    for (const key of keys) {
      if (key[0] === "items_full") continue;
      expect(key[1]).toBe("item-1");
    }
  });

  it("has no duplicates", () => {
    expect(new Set(flat).size).toBe(flat.length);
  });

  /**
   * The list only helps if PhotoManager actually reads it. Asserted against the
   * source with comments stripped first: a comment mentioning the helper would
   * otherwise satisfy a plain substring check, which is how a guard ends up
   * passing against the code it was written to catch.
   */
  it("is what PhotoManager invalidates", () => {
    const src = readFileSync("src/components/flipdesk/photo-manager.tsx", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).toContain("itemPhotoQueryKeys(itemId)");
    // The hand-written sequence this replaced must not creep back in beside it.
    // (`["item_photos", itemId]` on its own is the useQuery declaration, which
    // is where the key is DEFINED and has to stay.)
    expect(src).not.toMatch(
      /invalidateQueries\(\{\s*queryKey:\s*\["(item_photos|measure_photo|measure_overlay)"/,
    );
  });
});
