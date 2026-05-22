import type { ItemComp } from "@/types/database";

export interface CompStats {
  count: number;
  avg: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
}

export function computeStats(comps: ItemComp[]): CompStats {
  const prices = comps
    .map((c) => Number(c.price))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (prices.length === 0) {
    return { count: 0, avg: null, median: null, min: null, max: null };
  }
  const sum = prices.reduce((a, b) => a + b, 0);
  const avg = sum / prices.length;
  const mid = Math.floor(prices.length / 2);
  const median =
    prices.length % 2 === 0
      ? (prices[mid - 1]! + prices[mid]!) / 2
      : prices[mid]!;
  return {
    count: prices.length,
    avg,
    median,
    min: prices[0]!,
    max: prices[prices.length - 1]!,
  };
}

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
