import { describe, expect, it } from "vitest";
import { gradeRoiEstimate, MIN_BUCKET_SIZE } from "../flipdesk-analytics";
import type { ItemFullRow } from "@/types/database";

// Minimal sold-item builder — only the fields gradeRoiEstimate reads matter;
// the rest are filled with inert defaults and cast to ItemFullRow.
function soldItem(opts: {
  category: string | null;
  sale_price: number;
  grade_value: number | null;
  days_to_sell?: number | null;
}): ItemFullRow {
  return {
    category: opts.category,
    sale_price: opts.sale_price,
    grade_value: opts.grade_value,
    days_to_sell: opts.days_to_sell ?? null,
    net_profit: null,
  } as unknown as ItemFullRow;
}

// Build n items on one side (graded or ungraded) with a fixed price/days.
function side(
  n: number,
  category: string,
  grade_value: number | null,
  price: number,
  days: number,
): ItemFullRow[] {
  return Array.from({ length: n }, () =>
    soldItem({ category, sale_price: price, grade_value, days_to_sell: days }),
  );
}

describe("gradeRoiEstimate", () => {
  it("returns null when the category has no sold history", () => {
    const items = side(10, "Shoes", 9, 120, 10);
    expect(gradeRoiEstimate(items, { category: "Jackets" })).toBeNull();
  });

  it("computes price and days lift and flags meaningful for n >= MIN_BUCKET_SIZE both sides", () => {
    const items = [
      ...side(MIN_BUCKET_SIZE, "Jackets", 9, 150, 7), // graded: higher, faster
      ...side(MIN_BUCKET_SIZE, "Jackets", null, 100, 21), // ungraded
    ];
    const est = gradeRoiEstimate(items, { category: "Jackets" });
    expect(est).not.toBeNull();
    expect(est?.meaningful).toBe(true);
    expect(est?.priceLift).toBe(50); // 150 - 100
    expect(est?.daysFaster).toBe(14); // 21 - 7
    expect(est?.graded.count).toBe(MIN_BUCKET_SIZE);
    expect(est?.ungraded.count).toBe(MIN_BUCKET_SIZE);
  });

  it("flags low-n buckets as not meaningful", () => {
    const items = [
      ...side(MIN_BUCKET_SIZE - 1, "Jeans", 8, 80, 12),
      ...side(MIN_BUCKET_SIZE, "Jeans", null, 60, 20),
    ];
    const est = gradeRoiEstimate(items, { category: "Jeans" });
    expect(est?.meaningful).toBe(false);
  });

  it("pins to a price band when a priceHint is given", () => {
    const items = [
      // $150+ band
      ...side(MIN_BUCKET_SIZE, "Bags", 9, 200, 5),
      ...side(MIN_BUCKET_SIZE, "Bags", null, 180, 15),
      // Under $50 band — should be excluded by the hint
      ...side(MIN_BUCKET_SIZE, "Bags", 9, 30, 3),
      ...side(MIN_BUCKET_SIZE, "Bags", null, 20, 9),
    ];
    const est = gradeRoiEstimate(items, { category: "Bags", priceHint: 199 });
    expect(est?.band).toBe("$150+");
    expect(est?.graded.count).toBe(MIN_BUCKET_SIZE);
    expect(est?.priceLift).toBe(20); // 200 - 180 within the $150+ band only
  });

  it("matches category case-insensitively and trims whitespace", () => {
    const items = [
      ...side(MIN_BUCKET_SIZE, "  Jackets ", 9, 150, 7),
      ...side(MIN_BUCKET_SIZE, "jackets", null, 100, 21),
    ];
    const est = gradeRoiEstimate(items, { category: "JACKETS" });
    expect(est?.meaningful).toBe(true);
    expect(est?.priceLift).toBe(50);
  });
});
