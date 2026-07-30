// US-2258 / US-2260: two ways the composer let a seller write something the rest
// of the system would then disagree with.
//
//   US-2258 — on an eBay-ORIGINATED mirror, eBay owns some listing columns and an
//     inbound pull overwrites them. The composer disabled the title, price and
//     description inputs, but left "AI rewrite", "Suggest title", "Apply
//     template" and the keyword chips live on those same fields — so a seller
//     could run a rewrite, review it, accept it, and watch the save refuse it.
//     Quantity was fully editable and silently reverted by the next sync.
//
//   US-2260 — the status dropdown offered "Sold". resolveStatus lets a deliberate
//     non-prep pick win outright, so choosing it wrote status='sold' with no
//     sales row behind it, and Sold totals / P&L / reconciliation drifted from
//     inventory with nothing to surface the gap.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
// US-2263: the composer is a directory now — these assertions are about what the
// composer DOES, not which of its files does it.
import { composerAll as composer } from "./helpers/composer-source";

/** Every .ts/.tsx file under a directory, recursively. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

const syncPrecedence = readFileSync(
  join(process.cwd(), "services/edge-functions/src/lib/sync-precedence.ts"),
  "utf8",
);
// US-2263: the terminal-status set moved to the shared payload module, so the
// page and the extracted card cannot disagree about which statuses a sale owns.
const composerSave = readFileSync(
  join(process.cwd(), "src/lib/composer-save.ts"),
  "utf8",
);

describe("eBay-origin field locks (US-2258)", () => {
  // The composer's lock has to track the edge's list, not a guess. If a field is
  // added to EBAY_OWNED_LISTING_FIELDS, the composer needs to lock it too.
  const owned = (() => {
    const block = syncPrecedence.slice(
      syncPrecedence.indexOf("export const EBAY_OWNED_LISTING_FIELDS = ["),
    );
    const list = block.slice(0, block.indexOf("] as const"));
    return [...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  })();

  it("reads a real field list off the edge's single source of truth", () => {
    expect(owned).toContain("listing_title");
    expect(owned).toContain("quantity");
    expect(owned.length).toBeGreaterThan(5);
  });

  it("names every eBay-owned field this form edits in the audit comment", () => {
    // The audit comment is the record of which locks are deliberate. A field
    // added to the edge list and not mentioned here means nobody decided.
    const audit = composer.slice(
      composer.indexOf("// US-2258: WHICH fields eBay owns on a mirror"),
      composer.indexOf("const ebayOwnedHint"),
    );
    expect(audit.length).toBeGreaterThan(200);
    for (const field of owned) {
      expect(audit, `${field} not addressed in the US-2258 audit`).toContain(
        field,
      );
    }
  });

  it("disables the title write-actions, not just the title input", () => {
    // "Suggest title", the AI-rewrite dropdown, and the keyword chips all write
    // to a field eBay owns.
    expect(composer).toContain(
      "disabled={!title.trim() || aiRewrite.isPending || isEbayOrigin}",
    );
    expect(composer).toMatch(/const fits = chipFits\(kw\) && !isEbayOrigin;/);
    // Suggest title
    expect(composer).toMatch(
      /disabled=\{isEbayOrigin\}[\s\S]{0,120}setTitle\(suggestTitle\(item\)\)/,
    );
  });

  it("disables the description write-actions too", () => {
    expect(composer).toContain(
      "disabled={aiRewrite.isPending || isEbayOrigin}",
    );
    expect(composer).toMatch(
      /disabled=\{isEbayOrigin\}[\s\S]{0,120}onClick=\{applyTemplate\}/,
    );
  });

  it("locks quantity, which eBay owns and the next sync would revert", () => {
    const qtyInput = composer.slice(
      composer.indexOf('id="listing-quantity"'),
      composer.indexOf('id="listing-quantity"') + 700,
    );
    expect(qtyInput).toContain("disabled={isEbayOrigin}");
  });

  it("warns on the category rather than locking the specifics editor with it", () => {
    // platform_category_id is eBay-owned, but the item specifics in the same
    // editor are not — locking the picker would take the specifics with it.
    expect(composer).toContain(
      "eBay owns this listing&apos;s category, so a change here is",
    );
  });

  it("gives every lock the same explanation instead of ad-hoc strings", () => {
    expect(composer).toContain("const ebayOwnedHint = isEbayOrigin");
    expect(composer.split("title={ebayOwnedHint}").length - 1).toBeGreaterThanOrEqual(5);
  });
});

describe("sale-owned statuses (US-2260)", () => {
  it("defines the terminal set the status dropdown must not offer", () => {
    const block = composerSave.slice(
      composerSave.indexOf("export const SALE_OWNED_STATUSES"),
      composerSave.indexOf("]", composerSave.indexOf("export const SALE_OWNED_STATUSES")),
    );
    for (const s of ["sold", "shipped", "completed", "returned"]) {
      expect(block).toContain(`"${s}"`);
    }
  });

  it("filters them out of the status select", () => {
    expect(composer).toContain("!SALE_OWNED_STATUSES.has(s)");
  });

  it("still shows the current status when the item is already terminal", () => {
    // Filtering unconditionally would leave a sold item's dropdown displaying
    // some other status — a lie about the row it is editing.
    expect(composer).toContain(
      "s === currentStatus || !SALE_OWNED_STATUSES.has(s)",
    );
  });

  it("offers the real sold path instead", () => {
    expect(composer).toContain("<RecordSaleDialog");
    expect(composer).toContain("Record the sale");
    // …and only while the item hasn't already been sold.
    expect(composer).toContain("!SALE_OWNED_STATUSES.has(currentStatus) && (");
  });
});

describe("stranded cards are mounted again (US-2259)", () => {
  it("renders the catalog match and category check in the composer", () => {
    // Their only mount was ItemCanvas, which no route renders.
    expect(composer).toContain("<EbayCatalogMatchCard itemId={item.id} />");
    expect(composer).toContain("<CategoryCheckCard listingId={item.listing_id} />");
  });

  it("mounts the category check only when a listing row exists", () => {
    // It takes a listings.id; rendering it on a never-listed item would 404.
    expect(composer).toContain(
      "{item.listing_id && <CategoryCheckCard listingId={item.listing_id} />}",
    );
  });

  // US-2264: ItemCanvas is deleted. It was kept one story longer only because
  // iOS and Android cited it as their web-parity spec; those comments now point
  // at the composer, so the 2200-line component has no reason to exist. This
  // asserts it cannot come back as dead code — which is exactly how
  // EbayCatalogMatchCard and CategoryCheckCard became unreachable.
  it("has no ItemCanvas left to strand features on", () => {
    expect(existsSync(join(process.cwd(), "src/components/flipdesk/item-canvas.tsx")))
      .toBe(false);
  });

  it("has no importer of ItemCanvas anywhere under src/", () => {
    const IMPORTS_CANVAS =
      /(?:^|\n)\s*import[\s\S]{0,200}?from\s+["'][^"']*item-canvas["']/;
    const offenders = walk(join(process.cwd(), "src"))
      .filter((f) => !f.endsWith("composer-locks.test.ts"))
      .filter((f) => IMPORTS_CANVAS.test(readFileSync(f, "utf8")))
      .map((f) => f.replace(process.cwd() + "/", ""));
    expect(offenders).toEqual([]);
  });
});
