// US-2759: who identifies a prospect, and what it costs.
//
// The rule follows what the SELLER DID, because that is the one signal neither
// mechanism can fake. They photographed the tag -> read the tag, text beats
// similarity. They photographed only the garment -> visual search, because
// there is no text for hints to read and this is the case US-2758 measured
// visual search best on.
//
// The AI-action count is asserted here rather than left as a claim, because
// US-2760 is about the monthly cap and "it costs one now" is the whole point.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { planProspectIdentification, pickVisualImageIndex } = await import(
  "../lib/prospect-identify.ts"
);

const plan = (visualEnabled: boolean, ...imageRoles: (string | null | undefined)[]) =>
  planProspectIdentification({ visualEnabled, imageRoles });

// ── 1. The flag still governs everything ─────────────────────────────────────

Deno.test("with the flag off, nothing changes for anyone", () => {
  for (const roles of [["front"], ["front", "tag"], [], ["detail"]]) {
    const p = plan(false, ...roles);
    assertEquals(p.useVisual, false);
    assertEquals(p.runHints, true, "the flag being off must leave today's path exactly as it is");
    assertEquals(p.reason, "flag-off");
  }
});

// ── 2. The seller photographed the tag: read it ──────────────────────────────

Deno.test("a tag photo means the tag is read, not guessed at", () => {
  for (const roles of [["tag"], ["front", "tag"], ["label"], ["front", "label"]]) {
    const p = plan(true, ...roles);
    assertEquals(
      p.useVisual,
      false,
      `${roles.join("+")}: text on the garment beats a similarity match`,
    );
    assertEquals(p.runHints, true);
    assertEquals(p.reason, "tag-photographed");
  }
});

// ── 3. Garment only: visual search, and hints does not run ───────────────────

Deno.test("a garment shot with no tag goes to visual search", () => {
  for (const roles of [["front"], ["back"], ["flatlay"], ["front", "back"]]) {
    const p = plan(true, ...roles);
    assertEquals(p.useVisual, true, `${roles.join("+")} should reach visual search`);
    assertEquals(p.reason, "garment-only");
  }
});

Deno.test("AC3: the second AI action is not spent when visual search carries it", () => {
  const p = plan(true, "front");
  assertEquals(
    p.runHints,
    false,
    "extractMatchHints still runs speculatively, so a prospect still costs two " +
      "AI actions and US-2760's cart of twenty still costs forty",
  );
});

// ── 4. Unlabelled or unusable: today's path ──────────────────────────────────

Deno.test("no usable role keeps today's behaviour rather than guessing", () => {
  for (const roles of [[], [undefined], [null], ["detail"], ["measurement"], ["defect"], ["???"]]) {
    const p = plan(true, ...(roles as (string | null | undefined)[]));
    assertEquals(p.useVisual, false, `${JSON.stringify(roles)} must not reach visual search`);
    assertEquals(p.runHints, true);
    assertEquals(p.reason, "no-usable-role");
  }
});

Deno.test("a detail shot alongside a front shot does not disable visual search", () => {
  // The seller took a close-up of a flaw AND a front shot. The front is still
  // usable, and refusing on the presence of a detail shot would make the feature
  // unreachable for anyone thorough.
  const p = plan(true, "detail", "front");
  assertEquals(p.useVisual, true);
  assertEquals(p.reason, "garment-only");
});

Deno.test("roles are read case- and whitespace-insensitively", () => {
  assertEquals(plan(true, "  Front ").reason, "garment-only");
  assertEquals(plan(true, "TAG").reason, "tag-photographed");
});

// ── 5. Which photo visual search is shown ────────────────────────────────────

Deno.test("visual search is shown the first identifying photo", () => {
  assertEquals(pickVisualImageIndex(["front", "detail"]), 0);
  assertEquals(pickVisualImageIndex(["detail", "front"]), 1);
  assertEquals(pickVisualImageIndex(["detail", "measurement", "flatlay"]), 2);
});

Deno.test("no identifying photo returns -1, never a default of 0", () => {
  // The failure this prevents: treating "none qualify" as "use the first one",
  // which would hand visual search the ruler shot US-2762 exists to keep away
  // from it.
  assertEquals(pickVisualImageIndex([]), -1);
  assertEquals(pickVisualImageIndex(["detail"]), -1);
  assertEquals(pickVisualImageIndex([undefined, null]), -1);
  assertEquals(pickVisualImageIndex(["measurement", "defect"]), -1);
});

// ── 6. The plan and the picker cannot disagree ───────────────────────────────

Deno.test("useVisual is true only when there is a photo to show", () => {
  // Two independent functions the route calls in sequence. If a plan ever says
  // useVisual with nothing to send, the route reaches visual search with no
  // image and the whole decision is void.
  const cases: (string | null | undefined)[][] = [
    ["front"], ["back"], ["flatlay"], ["front", "tag"], ["detail"], [],
    ["detail", "front"], ["tag"], [undefined], ["label", "front"],
  ];
  for (const roles of cases) {
    const p = planProspectIdentification({ visualEnabled: true, imageRoles: roles });
    const idx = pickVisualImageIndex(roles);
    if (p.useVisual) {
      assert(
        idx >= 0,
        `plan says useVisual for ${JSON.stringify(roles)} but no photo qualifies`,
      );
    }
  }
});
