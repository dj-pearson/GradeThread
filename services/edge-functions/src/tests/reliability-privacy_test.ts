// US-488: reliability-study QA access must be minimized — reviewers never see
// owner identity or seller free text, only what's needed to blind-grade.
import { assertEquals } from "@std/assert";
import {
  minimizeReliabilityPhoto,
  minimizeReliabilityQueueRow,
  RELIABILITY_QUEUE_FIELDS,
  RELIABILITY_QUEUE_SELECT,
} from "../lib/reliability-privacy.ts";

Deno.test("queue allowlist contains no identity or free-text fields", () => {
  const forbidden = [
    "user_id",
    "email",
    "full_name",
    "title",
    "description",
    "storage_path",
  ];
  for (const f of forbidden) {
    assertEquals(
      (RELIABILITY_QUEUE_FIELDS as readonly string[]).includes(f),
      false,
      `${f} must not be in the reliability queue allowlist`,
    );
  }
  // The SELECT string is derived from the allowlist, so it can't drift.
  assertEquals(RELIABILITY_QUEUE_SELECT, RELIABILITY_QUEUE_FIELDS.join(", "));
});

Deno.test("minimizeReliabilityQueueRow strips PII-bearing fields", () => {
  const row = {
    id: "sub-1",
    garment_type: "jacket",
    garment_category: "outerwear",
    brand: "Patagonia",
    // PII-bearing / forbidden fields a wider SELECT could accidentally pull:
    user_id: "owner-uuid",
    title: "John's jacket — call 555-0100",
    description: "Worn twice, pickup at 12 Main St",
    email: "owner@example.com",
  };
  const out = minimizeReliabilityQueueRow(row);
  assertEquals(out, {
    id: "sub-1",
    garment_type: "jacket",
    garment_category: "outerwear",
    brand: "Patagonia",
  });
  // Field-by-field construction: nothing beyond the allowlist survives.
  assertEquals(Object.keys(out).sort(), [...RELIABILITY_QUEUE_FIELDS].sort());
});

Deno.test("minimizeReliabilityQueueRow tolerates missing optional fields", () => {
  const out = minimizeReliabilityQueueRow({ id: "sub-2" });
  assertEquals(out, {
    id: "sub-2",
    garment_type: null,
    garment_category: null,
    brand: null,
  });
});

Deno.test("minimizeReliabilityPhoto drops storage_path (embeds owner uuid)", () => {
  const out = minimizeReliabilityPhoto(
    {
      id: "img-1",
      image_type: "front",
      display_order: 0,
      // storage_path present on the source row but not in the function input
      // type — this asserts the OUTPUT shape regardless.
    },
    "https://signed.example/x",
  );
  assertEquals(out, {
    id: "img-1",
    image_type: "front",
    display_order: 0,
    signed_url: "https://signed.example/x",
  });
  assertEquals("storage_path" in out, false);
});
