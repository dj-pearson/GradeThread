// This file no longer computes comp statistics in the browser. It used to export
// computeStats(ItemComp[]) -> {count, avg, median, min, max} for comp-editor.tsx,
// a dialog that no longer exists; US-2436 removed both it and the CompStats type.
// Comp maths is the server's now — sold-comps.ts, grade-band-pricing.ts and
// condition-value-math.ts — and ebay-comps-panel.tsx renders what they return.
// Do not reintroduce a client copy: the native apps carry a RICHER CompStats with
// p25/p75, so a browser-only rewrite would be a third answer, not a shared one.

// Build a public eBay sold-listings search URL from item attributes.
// Anyone can use this URL — no eBay account required.
export function ebaySoldSearchUrl(parts: {
  brand?: string | null;
  style?: string | null;
  size?: string | null;
  title?: string | null;
}): string {
  const terms = [parts.brand, parts.style, parts.size]
    .filter((s): s is string => !!s && s.trim() !== "");
  const query = terms.length > 0 ? terms.join(" ") : parts.title ?? "";
  const url = new URL("https://www.ebay.com/sch/i.html");
  url.searchParams.set("_nkw", query);
  url.searchParams.set("LH_Sold", "1");
  url.searchParams.set("LH_Complete", "1");
  url.searchParams.set("_sop", "13"); // sort: ended recently
  return url.toString();
}
