// US-1828: closet CSV export + inventory promotion mapping (pure). No DB.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { csvCell, buildClosetCsv, inventoryFromCloset } = await import("../lib/closet-export.ts");

// ── csvCell ─────────────────────────────────────────────────────────────────

Deno.test("csvCell: quotes only when needed; escapes quotes", () => {
  assertEquals(csvCell("plain"), "plain");
  assertEquals(csvCell("has,comma"), '"has,comma"');
  assertEquals(csvCell('quote"d'), '"quote""d"');
  assertEquals(csvCell(null), "");
  assertEquals(csvCell("line\nbreak"), '"line\nbreak"');
});

// ── buildClosetCsv ──────────────────────────────────────────────────────────

Deno.test("csv: header + a row with dollarized values", () => {
  const csv = buildClosetCsv([
    {
      brand: "Patagonia",
      garment_type: "jacket",
      size: "M",
      condition_grade: 8.5,
      certificate_id: "GT-ABC123",
      estimateCents: 6000,
      costBasisCents: 4500,
    },
  ]);
  const lines = csv.trimEnd().split("\r\n");
  assertEquals(lines[0], "Brand,Item,Size,Certified Grade,Certificate,Estimated Value (USD),Cost Basis (USD)");
  assertEquals(
    lines[1],
    "Patagonia,jacket,M,8.5,https://gradethread.com/cert/GT-ABC123,60.00,45.00",
  );
});

Deno.test("csv: nulls render empty; a comma-brand is quoted", () => {
  const csv = buildClosetCsv([
    { brand: "A, B Co", garment_type: null, size: null, condition_grade: null, certificate_id: null, estimateCents: null, costBasisCents: null },
  ]);
  const line = csv.trimEnd().split("\r\n")[1];
  assertEquals(line, '"A, B Co",,,,,,');
});

// ── inventoryFromCloset ─────────────────────────────────────────────────────

const closet = {
  brand: "Nike",
  garment_type: "hoodie",
  size: "L",
  condition_grade: 7.0,
  certificate_id: "GT-XYZ",
  title: null,
  notes: "minor pilling",
};

Deno.test("promotion: title falls back to brand + type; cert URL + suggested price", () => {
  const d = inventoryFromCloset(closet, 5500);
  assertEquals(d.title, "Nike hoodie");
  assertEquals(d.grade_value, 7.0);
  assertEquals(d.certificate_url, "https://gradethread.com/cert/GT-XYZ");
  assertEquals(d.listing_price, 55); // 5500c → $55
  assertEquals(d.item_category, "clothing");
  assertEquals(d.status, "cataloged");
  assertEquals(d.condition_notes, "minor pilling");
});

Deno.test("promotion: explicit title wins; no estimate → price 0", () => {
  const d = inventoryFromCloset({ ...closet, title: "My favorite hoodie" }, null);
  assertEquals(d.title, "My favorite hoodie");
  assertEquals(d.listing_price, 0);
});

Deno.test("promotion: no brand/type/title → generic title; manual item has no cert URL", () => {
  const d = inventoryFromCloset(
    { brand: null, garment_type: null, size: null, condition_grade: null, certificate_id: null, title: null, notes: null },
    null,
  );
  assertEquals(d.title, "Wardrobe item");
  assertEquals(d.certificate_url, null);
});
