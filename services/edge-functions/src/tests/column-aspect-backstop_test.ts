import { assertEquals } from "@std/assert";
import { ASPECT_REGISTRY } from "../lib/aspect-registry.ts";

// US-2274 AC7: the publish-time backstop, and why it is worth a test of its own.
//
// US-2274 is about iOS not projecting an item's own columns onto its eBay
// specifics. Its own notes conclude the residual risk is small, and give exactly
// one reason: `forceColumnAspects` re-asserts Brand / Size / Color / Material /
// Style from the item's columns on the way OUT, "so a stale store cannot produce
// a wrong LISTING; it can only produce a stale-looking specifics EDITOR".
//
// That sentence is load-bearing for a story that is otherwise being left open,
// and the function it rests on had NO test. `applyColumnAspects` underneath it
// is covered in aspect-registry_test.ts; the wrapper, its fallback table and the
// three paths that must call it were not.
//
// Two properties, both derived rather than listed:
//
//   1. COLUMN_ASPECT_FALLBACK is used when no category spec is loaded, and its
//      comment claims it "mirrors the registry's first candidate for each column
//      entry". That is checkable against the registry itself, so it is checked.
//      A reordered `aspects` array — "Colour" moved ahead of "Color", say —
//      would leave the fallback sending a name the registry would no longer
//      choose, on exactly the path where no category spec is available to
//      correct it.
//
//   2. All THREE aspect-writing paths call it. One losing the call publishes
//      whatever the stale store holds, which is the failure AC7 exists to
//      prevent, on one path only — the hardest kind to notice.

const ROUTE = "src/routes/flipdesk-ebay.ts";
const source = Deno.readTextFileSync(ROUTE).replace(/\r\n?/g, "\n");

/** The body of a top-level function, bounded by the next top-level declaration. */
function functionBody(name: string): string {
  const re = new RegExp(`^(?:export )?(?:async )?function ${name}\\s*[(<]`, "m");
  const m = re.exec(source);
  if (!m) return "";
  const start = m.index;
  const after = source.slice(start + m[0].length);
  const next = /^(?:export )?(?:async )?(?:function|const|class) /m.exec(after);
  return after.slice(0, next ? next.index : after.length);
}

Deno.test("US-2274 AC7: the fallback mirrors the registry's first column aspects", () => {
  // Parsed from source because the constant is module-private, and exporting it
  // purely to be testable would widen the route's surface for a check's benefit.
  const block = /const COLUMN_ASPECT_FALLBACK: RegistryAspect\[\] = \[([\s\S]*?)\n\];/.exec(
    source,
  );
  assertEquals(block !== null, true, "COLUMN_ASPECT_FALLBACK no longer parses");
  const fallback = [...block![1].matchAll(/name: "([^"]+)"/g)].map((x) => x[1]);
  assertEquals(fallback.length > 3, true, `only ${fallback.length} fallback names parsed`);

  const expected = ASPECT_REGISTRY.entries
    .filter((e) => e.source === "column" && e.column !== undefined)
    .filter((e) => ["brand", "size", "color", "material", "style"].includes(e.key))
    .map((e) => e.aspects[0]);
  assertEquals(expected.length, 5, "the five column-backed registry entries changed");

  assertEquals(
    fallback.slice().sort(),
    expected.slice().sort(),
    "COLUMN_ASPECT_FALLBACK no longer matches the registry's first candidate per " +
      "column. This table is what gets used when NO category spec is loaded, so " +
      "there is nothing downstream to correct a wrong name — it is sent verbatim.",
  );
});

Deno.test("US-2274 AC7: the fallback treats every name as free text", () => {
  // A SELECTION_ONLY entry here would be validated against an allowed-value list
  // that does not exist on this path, and the column value would be dropped
  // rather than sent — silently reintroducing the stale-aspect problem.
  const block = /const COLUMN_ASPECT_FALLBACK: RegistryAspect\[\] = \[([\s\S]*?)\n\];/.exec(
    source,
  );
  const modes = [...block![1].matchAll(/mode: "([^"]+)"/g)].map((x) => x[1]);
  assertEquals(modes.length, 5, `parsed ${modes.length} modes, expected 5`);
  assertEquals(
    [...new Set(modes)],
    ["FREE_TEXT"],
    "a fallback aspect is no longer FREE_TEXT; the raw column value would be " +
      "matched against an allowed-value list this path never loads",
  );
});

Deno.test("US-2274 AC7: every aspect-writing path re-asserts the columns", () => {
  // Scoped to each function's BODY, not to the file. A file-wide search is
  // satisfied by the declaration itself plus any one caller, which is how a
  // guard ends up proving that the function exists rather than that it is used
  // (vault/70-agent/guards-that-cannot-fail.md shape 8).
  const paths = [
    ["reviseOneListing", "the revise path"],
    ["resyncGradeToLiveListing", "the grade-resync path"],
    ["assemblePublishContext", "the publish path"],
  ] as const;

  for (const [fn, what] of paths) {
    const body = functionBody(fn);
    // Guards the guard: an empty or tiny slice would pass the negative check
    // below for the wrong reason.
    assertEquals(body.length > 400, true, `${fn} did not parse (${body.length} chars)`);
    assertEquals(
      /forceColumnAspects\s*\(/.test(body),
      true,
      `${what} (${fn}) no longer calls forceColumnAspects. It would publish ` +
        `whatever the aspect store holds, and US-2274's whole argument that a ` +
        `stale store cannot produce a wrong listing rests on this call.`,
    );
  }
});

Deno.test("US-2274 AC7: forceColumnAspects still chooses the spec over the fallback", () => {
  // The wrapper's one decision. Inverting it would send the fallback names even
  // when the real category spec is loaded, which publishes "Color" to a category
  // that calls it "Colour" and drops the value.
  const body = functionBody("forceColumnAspects");
  assertEquals(body.length > 100, true, "forceColumnAspects did not parse");
  assertEquals(
    /aspectList && aspectList\.length > 0/.test(body),
    true,
    "forceColumnAspects no longer prefers a loaded category spec over the fallback",
  );
  assertEquals(
    /toRegistryAspects\(aspectList\)/.test(body),
    true,
    "the loaded spec is no longer converted for use",
  );
  assertEquals(
    /COLUMN_ASPECT_FALLBACK/.test(body),
    true,
    "the no-spec branch no longer falls back to the column defaults",
  );
});
