// US-2714: reconciling rows the SQL trigger filed under a non-canonical key.
//
// The trigger cannot ask the decoder, so a seller correction on a full-length
// tag code lands where no reader looks. These are the four things that can be
// true of such a row, and only one of them is "just move it".
import { assertEquals } from "@std/assert";

// style-code-rekey.ts reaches the service-role client through
// style-code-observations.ts — dummy env BEFORE the dynamic import.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { planRekey, summarizeRekey } = await import("../lib/style-code-rekey.ts");

type Row = Parameters<typeof planRekey>[0][number];

function row(over: Partial<Row> = {}): Row {
  return {
    id: "row-1",
    brand_key: "lululemon",
    // What the trigger writes: the plainly-normalized transcription.
    style_code_norm: "LW6AMYSP60417",
    style_code_raw: "LW6AMYSP60417",
    name: "Scuba Oversized Half Zip Hoodie",
    source: "seller",
    supporting: 1,
    confidence: 0.8,
    evidence_url: null,
    rejected_at: null,
    ...over,
  };
}

Deno.test("US-2714: a row already at its canonical key is left alone", () => {
  const plan = planRekey([
    row({ style_code_norm: "W6AMYS", style_code_raw: "W6AMYS" }),
    // Punctuated and prefixed spellings that canonicalize to the same key.
    row({ id: "b", style_code_norm: "W7DVCS", style_code_raw: "lw7d-vcs" }),
  ]);
  assertEquals(plan.steps, []);
  assertEquals(plan.correct, 2);
});

Deno.test("US-2714: a mis-keyed row with nothing at the target is MOVED", () => {
  const plan = planRekey([row()]);
  assertEquals(plan.steps.length, 1);
  assertEquals(plan.steps[0]!.action, "move");
  assertEquals(plan.steps[0]!.canonical, "W6AMYS");
});

Deno.test("US-2714: the same answer already at the target is a DUPLICATE", () => {
  const plan = planRekey([
    row(),
    // Same source, canonical key, same answer spelled differently.
    row({
      id: "target",
      style_code_norm: "W6AMYS",
      style_code_raw: "W6AMYS",
      name: "scuba oversized half-zip hoodie",
    }),
  ]);
  const steps = plan.steps;
  assertEquals(steps.length, 1);
  assertEquals(steps[0]!.row.id, "row-1");
  assertEquals(steps[0]!.action, "drop_duplicate");
  assertEquals(plan.correct, 1);
});

Deno.test("US-2714: a DIFFERENT answer at the target is a conflict, not a merge", () => {
  // Merging would silently pick a winner between two first-party corrections.
  // The admin queue already surfaces conflicts; this refuses to pre-empt it.
  const plan = planRekey([
    row(),
    row({
      id: "target",
      style_code_norm: "W6AMYS",
      style_code_raw: "W6AMYS",
      name: "Scuba Full Zip Hoodie",
    }),
  ]);
  assertEquals(plan.steps.length, 1);
  assertEquals(plan.steps[0]!.action, "conflict");
});

Deno.test("US-2714: a rejected row is never moved", () => {
  // Moving one would resurrect a name an admin removed, under a key where the
  // rejection is not recorded.
  const plan = planRekey([row({ rejected_at: "2026-08-20T00:00:00Z" })]);
  assertEquals(plan.steps, []);
  assertEquals(plan.correct, 0);
});

Deno.test("US-2714: rows from different SOURCES do not collide", () => {
  // The 00628 unique key is (brand, code, source), so a consensus row at the
  // canonical key says nothing about where a seller row belongs.
  const plan = planRekey([
    row(),
    row({
      id: "consensus",
      style_code_norm: "W6AMYS",
      style_code_raw: "W6AMYS",
      source: "consensus",
      name: "Something Else Entirely",
    }),
  ]);
  assertEquals(plan.steps.length, 1);
  assertEquals(plan.steps[0]!.action, "move");
});

Deno.test("US-2714: a brand with no canonical rule is never re-keyed", () => {
  // Every brand but Lululemon today. A reconcile that touched them would be
  // re-keying the corpus on a rule that does not exist for it.
  const plan = planRekey([
    row({ brand_key: "levis", style_code_norm: "5110011", style_code_raw: "511-0011" }),
    row({ id: "b", brand_key: "", style_code_norm: "GY7434", style_code_raw: "GY7434" }),
  ]);
  assertEquals(plan.steps, []);
  assertEquals(plan.correct, 2);
});

Deno.test("US-2714: the summary separates a quiet tick from an empty one", () => {
  const plan = planRekey([
    row(),
    row({ id: "ok", style_code_norm: "W6AMYS", style_code_raw: "W6AMYS" }),
  ]);
  // `correct` is what tells an operator the reconcile READ rows and found them
  // fine, rather than reading nothing at all.
  assertEquals(summarizeRekey(plan), {
    moved: 0,
    dropped: 1,
    conflicts: 0,
    correct: 1,
  });
  assertEquals(summarizeRekey({ steps: [], correct: 0 }), {
    moved: 0,
    dropped: 0,
    conflicts: 0,
    correct: 0,
  });
});
