// US-2691: which source wins when several name the same style code.
//
// The rule is "who is in a position to know", not "who is better attested",
// which is why every test here pits a well-supported weak source against a
// thin strong one.
import { assert, assertEquals } from "@std/assert";
import {
  NAME_SOURCE_ORDER,
  nameSourceRank,
  pickStyleCodeName,
  type StyleCodeNameRow,
} from "../lib/style-code-names.ts";

function row(over: Partial<StyleCodeNameRow> = {}): StyleCodeNameRow {
  return {
    name: "Commission Short Relaxed Warpstreme",
    source: "consensus",
    supporting: 4,
    confidence: 0.55,
    evidence_url: null,
    ...over,
  };
}

Deno.test("US-2691: nothing to pick from yields null", () => {
  assertEquals(pickStyleCodeName([]), null);
});

Deno.test("US-2691: the brand's own name beats every other source", () => {
  const pick = pickStyleCodeName([
    row({ source: "consensus", supporting: 40, confidence: 0.75 }),
    row({ source: "seller", name: "Commission Short", confidence: 0.8 }),
    row({ source: "admin", name: "Commission Shorts", confidence: 0.9 }),
    row({ source: "official", name: 'Commission Short Relaxed 11"', confidence: 0.6 }),
  ]);
  assertEquals(pick!.source, "official");
  assertEquals(pick!.name, 'Commission Short Relaxed 11"');
});

Deno.test("US-2691: a seller who read the tag beats forty listings that guessed", () => {
  const pick = pickStyleCodeName([
    row({ source: "consensus", supporting: 40, confidence: 0.75 }),
    row({ source: "seller", name: "Commission Short", supporting: 1, confidence: 0.5 }),
  ]);
  assertEquals(pick!.source, "seller");
  // The losing row's higher confidence is exactly what must NOT decide it.
  assertEquals(pick!.confidence, 0.5);
});

Deno.test("US-2691: an admin outranks a seller, and both outrank consensus", () => {
  assert(nameSourceRank("admin") < nameSourceRank("seller"));
  assert(nameSourceRank("seller") < nameSourceRank("consensus"));
  assert(nameSourceRank("official") < nameSourceRank("admin"));
});

Deno.test("US-2691: a rejected name is dropped, never used as a fallback", () => {
  // The whole point of recording a rejection instead of deleting the row.
  assertEquals(
    pickStyleCodeName([row({ rejected_at: "2026-08-19T00:00:00Z" })]),
    null,
  );
  const pick = pickStyleCodeName([
    row({ source: "admin", name: "Wrong Name", rejected_at: "2026-08-19T00:00:00Z" }),
    row({ source: "consensus", name: "Commission Short Relaxed Warpstreme" }),
  ]);
  assertEquals(pick!.name, "Commission Short Relaxed Warpstreme");
});

Deno.test("US-2691: an unknown source is ignored rather than trusted or thrown on", () => {
  assertEquals(pickStyleCodeName([row({ source: "scraped_from_somewhere" })]), null);
  const pick = pickStyleCodeName([
    row({ source: "scraped_from_somewhere", name: "Junk" }),
    row({ source: "consensus" }),
  ]);
  assertEquals(pick!.source, "consensus");
});

Deno.test("US-2691: within one source the better-attested row wins", () => {
  const pick = pickStyleCodeName([
    row({ source: "consensus", name: "Thin Answer", supporting: 3, confidence: 0.5 }),
    row({ source: "consensus", name: "Well Attested", supporting: 12, confidence: 0.5 }),
  ]);
  assertEquals(pick!.name, "Well Attested");
});

Deno.test("US-2691: a blank name is not an answer", () => {
  assertEquals(pickStyleCodeName([row({ name: "   " })]), null);
});

Deno.test("US-2691: the source order is the precedence, with no gaps", () => {
  // A source added to 00628's CHECK constraint but not here would sort last and
  // be silently ignored. Pin the list so that is a test failure, not a surprise.
  assertEquals([...NAME_SOURCE_ORDER], [
    "official",
    "admin",
    "seller",
    "consensus",
  ]);
});
