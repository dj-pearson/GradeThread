// US-9124: the sandbox, and the guarantee that it touches nothing.
//
// A sandbox that could write a row or call a marketplace would be worse than no
// sandbox, because it is the surface we hand to people who have not paid and
// therefore have the least reason to trust us with anything.
//
// The guarantee is STRUCTURAL: lib/mcp-sandbox.ts imports no database client and
// no marketplace client, so its handlers have no way to reach either. The first
// test asserts that import list, because the property survives only as long as
// nobody adds a convenient import.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  SANDBOX_NOTICE,
  sandboxCatalog,
  sandboxEntry,
  sandboxGrade,
  sandboxPublish,
} = await import("../lib/mcp-sandbox.ts");
const { findTool, TOOLS } = await import("../lib/mcp-tools.ts");

const SOURCE = await Deno.readTextFile(new URL("../lib/mcp-sandbox.ts", import.meta.url));

// ---------------------------------------------------------------------------
// The structural guarantee
// ---------------------------------------------------------------------------

Deno.test("the sandbox module cannot reach a database or a marketplace", () => {
  const imports = [...SOURCE.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
  assert(imports.length > 0, "no imports parsed; the pattern has drifted");

  const forbidden = [
    "./supabase.ts",
    "./ebay-client.ts",
    "./stripe.ts",
    "./ai-grading.ts",
    "./grading-pipeline.ts",
  ];
  for (const path of forbidden) {
    assert(
      !imports.includes(path),
      `mcp-sandbox.ts imports ${path}. A sandbox handler must have no way to reach it.`,
    );
  }

  // Whitelist rather than blacklist: a new import is a decision, not a default.
  assertEquals(
    imports,
    ["./price-guide.ts"],
    "the sandbox module gained an import. Only pure fixture helpers belong here.",
  );
});

Deno.test("the sandbox module declares no async handler, because nothing it does can block", () => {
  // An await in here would mean something is being fetched, and nothing should
  // be. Cheap, and it catches the shape before it catches the bug.
  assert(!/\bawait\b/.test(SOURCE), "mcp-sandbox.ts contains an await; nothing here should wait");
});

// ---------------------------------------------------------------------------
// Every result says it is a sandbox result
// ---------------------------------------------------------------------------

Deno.test("every sandbox tool labels itself in the TEXT, not only the payload", async () => {
  const sandboxTools = TOOLS.filter((t) => t.sandbox === true);
  assert(sandboxTools.length >= 3, "expected the sandbox tool set");

  for (const tool of sandboxTools) {
    const result = await tool.handler(
      { title: "Carhartt Detroit jacket", slug: "sample-item" },
      { tenantId: "t", userId: "u", apiKeyId: "k", scopes: ["read"] },
    );
    const text = result.content.map((c) => c.text).join("\n");
    assertStringIncludes(
      text,
      "SANDBOX",
      `${tool.name} did not say it was sandbox data in the text the model reads`,
    );
  }
});

Deno.test("the sandbox notice says what was NOT done, not just that it is a sample", () => {
  assertStringIncludes(SANDBOX_NOTICE, "Nothing was read");
  assertStringIncludes(SANDBOX_NOTICE, "nothing was changed");
});

Deno.test("a sandbox publish returns no URL and a status that cannot read as live", () => {
  // A plausible listing URL is a result a model hands to a seller as a live
  // listing, and they go looking for it.
  const listing = sandboxPublish("Levis 501", "ebay", 4999);
  assertEquals(listing.url, null);
  assertEquals(listing.status, "would_publish");
  assertEquals(listing.sandbox, true);
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

Deno.test("the same input gives the same grade, so a partner can assert on it", () => {
  const a = sandboxGrade("Carhartt Detroit jacket");
  const b = sandboxGrade("Carhartt Detroit jacket");
  assertEquals(a, b);

  const different = sandboxGrade("Levis 501");
  assert(different.overall_score !== a.overall_score || different.id !== a.id);
});

Deno.test("sandbox grades stay on the real scale and the half-point steps", () => {
  for (const title of ["a", "jacket", "Levis 501", "tee", "boots", "scarf"]) {
    const g = sandboxGrade(title);
    for (
      const score of [
        g.overall_score,
        g.fabric_condition_score,
        g.structural_integrity_score,
        g.cosmetic_appearance_score,
        g.functional_elements_score,
        g.odor_cleanliness_score,
      ]
    ) {
      assert(score >= 1 && score <= 10, `${title}: ${score} is off the 1-10 scale`);
      assertEquals(score * 2, Math.round(score * 2), `${title}: ${score} is not a half-point step`);
    }
  }
});

Deno.test("the sample catalog and entries are non-empty", () => {
  const catalog = sandboxCatalog();
  assert(catalog.length > 0);
  const entry = sandboxEntry(catalog[0].slug);
  assertEquals(typeof entry, "object");
});

// ---------------------------------------------------------------------------
// The plan exemption
// ---------------------------------------------------------------------------

Deno.test("only sandbox tools carry the plan-gate exemption", () => {
  // sandbox: true is the ONLY thing that skips the plan gate, so a tool that
  // sets it by accident is a paid capability given away.
  const exempt = TOOLS.filter((t) => t.sandbox === true).map((t) => t.name).sort();
  assertEquals(exempt, [
    "gradethread_sandbox_grade",
    "gradethread_sandbox_price_guide",
    "gradethread_sandbox_publish",
  ]);
});

Deno.test("no sandbox tool is annotated destructive, and none is budgeted", async () => {
  const { budgetKindForTool } = await import("../lib/mcp-budget.ts");
  for (const tool of TOOLS.filter((t) => t.sandbox === true)) {
    assertEquals(tool.annotations.readOnlyHint, true, `${tool.name} should be read-only`);
    assertEquals(
      budgetKindForTool(tool.name),
      null,
      `${tool.name} spends from a budget, but it costs nothing`,
    );
  }
});

Deno.test("the sandbox tools are named so a model cannot confuse them with the real ones", () => {
  for (const tool of TOOLS.filter((t) => t.sandbox === true)) {
    assertStringIncludes(tool.name, "sandbox");
    assertStringIncludes(tool.description.toLowerCase(), "sample");
  }
  // And the real grading tool is not accidentally flagged.
  assertEquals(findTool("gradethread_grading_readiness")?.sandbox, undefined);
});
