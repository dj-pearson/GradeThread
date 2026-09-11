// US-3352: `ai_field_sources[field].accepted` stops being a constant.
//
// The key exists to record that a PERSON agreed with an AI-extracted value.
// Every server-side auto-apply site in routes/flipdesk-ai.ts stamped the
// literal boolean `true` on it, so it recorded an agreement nobody was ever
// asked for -- on confident fields no review surface displays at all. Nothing
// in the repo reads the key today, which is exactly what a constant earns: the
// first accuracy query that touches it would have measured 100% acceptance on
// every field of every item and been wrong about all of them.
//
// Two kinds of assertion here, deliberately, per the repo's own notes on guards
// that do not guard:
//
//   * BEHAVIOUR -- call the real exported helpers and check what they produce
//     and how they read back. A scan cannot tell an inverted rule from a
//     correct one.
//   * WIRING -- count the write sites in the route file. A behavioural test
//     cannot see a fourth site added later that stamps the constant again.
//
// The route module reaches lib/supabase.ts through its static imports, so
// _env.ts has to come first.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  AUTO_APPLIED_ACCEPTANCE,
  autoAppliedFieldSource,
  readAcceptance,
} from "../routes/flipdesk-ai.ts";

const ROUTE_FILE = new URL("../routes/flipdesk-ai.ts", import.meta.url);

/**
 * Code lines only. Block comments go first as BLOCKS -- stripping by line
 * prefix leaves the indented interior of a `/* ... *\/` run, and the comment
 * beside a write site is precisely where its tokens get quoted.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

// --- Behaviour ---

Deno.test("US-3352: a headless apply records no acceptance", () => {
  const entry = autoAppliedFieldSource("photo:tag", 0.94);
  assertEquals(entry.source, "photo:tag");
  assertEquals(entry.confidence, 0.94);
  // The point of the story: high confidence is not agreement. A 0.94 department
  // nobody was shown must not come back as something a seller signed off on.
  assertEquals(entry.accepted, null);
  assertEquals(AUTO_APPLIED_ACCEPTANCE, null);
});

Deno.test("US-3352: confidence does not change what is recorded", () => {
  for (const confidence of [0, 0.3, 0.75, 0.9, 1]) {
    assertEquals(
      autoAppliedFieldSource("ai", confidence).accepted,
      null,
      `confidence ${confidence} still recorded an acceptance`,
    );
  }
});

Deno.test("US-3352: the three states read back distinctly", () => {
  // What a review surface writes when the seller keeps the value.
  assertEquals(
    readAcceptance({ source: "photo:tag", confidence: 0.9, accepted: true }),
    "accepted",
  );
  // What a review surface writes when the seller clears or replaces it.
  assertEquals(
    readAcceptance({ source: "ai", confidence: 0.4, accepted: false }),
    "rejected",
  );
  // What the server writes now.
  assertEquals(readAcceptance(autoAppliedFieldSource("ai", 0.92)), "not_shown");
  // "not shown" is NOT a rejection, and a reader must not be able to collapse
  // the two by accident. This is the whole reason for a third state.
  assert(
    readAcceptance(autoAppliedFieldSource("ai", 0.92)) !==
      readAcceptance({ source: "ai", confidence: 0.4, accepted: false }),
  );
});

Deno.test("US-3352: an entry with no acceptance key is unknown, not rejected", () => {
  // Pre-rule rows, and the measurement entries other libs write. Folding these
  // into `rejected` would invent seller decisions out of old data -- the same
  // mistake as the constant, pointing the other way.
  assertEquals(readAcceptance({ source: "photo:tag", confidence: 0.7 }), "unknown");
  assertEquals(readAcceptance({}), "unknown");
});

Deno.test("US-3352: readAcceptance is total over junk", () => {
  for (const junk of [null, undefined, 42, "accepted", [], [true]]) {
    assertEquals(readAcceptance(junk), "unknown", `coerced ${JSON.stringify(junk)}`);
  }
  // A non-boolean under the key is not an answer either.
  assertEquals(readAcceptance({ accepted: "true" }), "unknown");
  assertEquals(readAcceptance({ accepted: 1 }), "unknown");
});

// --- Wiring ---

Deno.test("US-3352: every ai_field_sources write in the route goes through the helper", async () => {
  const code = codeOnly(await Deno.readTextFile(ROUTE_FILE));

  // Count both sides rather than asserting "at least one helper call exists".
  // A file with three assignments and one helper call passes that; deleting two
  // of the three conversions leaves it green.
  const assignments = code.match(/aiSources\[[^\]]+\]\s*=/g) ?? [];
  const viaHelper = code.match(/aiSources\[[^\]]+\]\s*=\s*autoAppliedFieldSource\(/g) ??
    [];
  assert(assignments.length >= 3, `expected the known write sites, saw ${assignments.length}`);
  assertEquals(
    viaHelper.length,
    assignments.length,
    `${assignments.length - viaHelper.length} ai_field_sources write(s) bypass autoAppliedFieldSource`,
  );

  // And the constant itself is gone from the file's code.
  const stampsTrue = code.match(/accepted\s*:\s*true/g) ?? [];
  assertEquals(
    stampsTrue.length,
    0,
    "a server-side path still claims a human accepted the value",
  );
});
