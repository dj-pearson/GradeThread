// US-2135 AC2 — high-res re-read selection for authenticity macro slots.
//
// ai-grading.ts transitively imports the service-role supabase client, which
// throws at module init without env — set dummy creds BEFORE the dynamic import
// (mirrors grading-shadow_test.ts).
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { selectMacrosForReread, MACRO_REREAD_MAX_QUALITY } = await import(
  "../lib/ai-grading.ts"
);

// ── US-2135 AC2: a soft authenticity macro earns a high-res re-read ──────────
//
// The AC says "generalize the Forensic defect-zoom crop pipeline". It joins the
// RE-READ family instead, and the distinction is load-bearing: the defect zoom
// crops a bbox because a tiny flaw on a whole-garment shot falls below a pixel.
// A serial or a heat stamp is already a dedicated close-up — the whole photo IS
// the region, which is what the label re-read says about itself. Same image,
// same prompt, so no prompt_version moves and there is nothing to shadow.

Deno.test("US-2135: a soft macro is selected for re-read", () => {
  const picks = selectMacrosForReread([
    { image_type: "serial", quality_score: 0.1 },
    { image_type: "front", quality_score: 0.05 },
  ]);
  assertEquals(picks.map((p) => p.image_type), ["serial"]);
});

Deno.test("US-2135: a SHARP macro is not re-read — the pass is for evidence, not for every macro", () => {
  assertEquals(
    selectMacrosForReread([{ image_type: "serial", quality_score: 0.9 }]).length,
    0,
  );
  // Exactly at the bar does not select: the threshold is "no better than this".
  assertEquals(
    selectMacrosForReread([
      { image_type: "serial", quality_score: MACRO_REREAD_MAX_QUALITY },
    ]).length,
    1,
  );
  assertEquals(
    selectMacrosForReread([
      { image_type: "serial", quality_score: MACRO_REREAD_MAX_QUALITY + 0.01 },
    ]).length,
    0,
  );
});

Deno.test("US-2135: an UNMEASURED macro is not re-read", () => {
  // The one that costs money if it is wrong. Absent means "not measured" — an
  // older client, a canvas that could not decode — and Number(null) is 0, which
  // is finite, so a naive check would make every legacy submission look
  // maximally soft and buy a vision call per macro on all of them.
  for (const q of [null, undefined, Number.NaN]) {
    assertEquals(
      selectMacrosForReread([
        { image_type: "serial", quality_score: q as number | null },
      ]).length,
      0,
      String(q),
    );
  }
});

Deno.test("US-2135: only whole-frame authenticity slots qualify", () => {
  // front/back/label are not authenticity macros. label has its OWN re-read
  // selector keyed on legibility, and adding it here would double-select it.
  const picks = selectMacrosForReread([
    { image_type: "front", quality_score: 0.01 },
    { image_type: "back", quality_score: 0.01 },
    { image_type: "label", quality_score: 0.01 },
    { image_type: "marking", quality_score: 0.01 },
  ]);
  assertEquals(picks.map((p) => p.image_type), ["marking"]);
});

Deno.test("US-2135: bounded, and never the same slot twice", () => {
  const many = [
    { image_type: "serial", quality_score: 0.1 },
    { image_type: "serial", quality_score: 0.1 },
    { image_type: "marking", quality_score: 0.1 },
    { image_type: "corner", quality_score: 0.1 },
    { image_type: "sole", quality_score: 0.1 },
  ];
  const picks = selectMacrosForReread(many);
  // Default cap of 2 — every pick is a paid vision call on a paid grade.
  assertEquals(picks.length, 2);
  assertEquals(new Set(picks.map((p) => p.image_type)).size, picks.length);
});
