// US-1544: pure pieces of the group-boundary verification — the sampling
// budget and the suggestion normalization (model output → caller ids).
//   deno test --allow-env --allow-net --allow-read src/tests/ai-group-verify_test.ts
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { normalizeGroupSuggestions, sampleGroupsForVerify } = await import(
  "../lib/ai-group-verify.ts"
);

function group(id: string, count: number) {
  return {
    id,
    photos: Array.from({ length: count }, (_, i) => ({
      id: `${id}-p${i + 1}`,
      url: `http://x/${id}/${i + 1}.jpg`,
    })),
  };
}

Deno.test("sampleGroupsForVerify: ≤3 photos pass through; big groups sample first/middle/last", () => {
  const { sampled, groupsCovered, truncated } = sampleGroupsForVerify(
    [group("a", 2), group("b", 7)],
    40,
  );
  assertEquals(groupsCovered, 2);
  assertEquals(truncated, false);
  assertEquals(
    sampled.filter((p) => p.groupId === "a").map((p) => p.photoId),
    ["a-p1", "a-p2"],
  );
  assertEquals(
    sampled.filter((p) => p.groupId === "b").map((p) => p.photoId),
    ["b-p1", "b-p4", "b-p7"], // first / middle / last
  );
  // Labels are G<group>-P<photo>, 1-based, in presentation order.
  assertEquals(sampled[0]!.label, "G1-P1");
  assertEquals(sampled[2]!.label, "G2-P1");
});

Deno.test("sampleGroupsForVerify: stops at the photo budget and reports truncation", () => {
  const groups = Array.from({ length: 30 }, (_, i) => group(`g${i}`, 4)); // 3 sampled each
  const { sampled, groupsCovered, truncated } = sampleGroupsForVerify(groups, 40);
  assertEquals(groupsCovered, 13); // 13 × 3 = 39 ≤ 40; the 14th would overflow
  assertEquals(sampled.length, 39);
  assertEquals(truncated, true);
});

Deno.test("sampleGroupsForVerify: skips empty groups without consuming a number", () => {
  const { sampled, groupsCovered } = sampleGroupsForVerify(
    [group("a", 1), { id: "empty", photos: [] }, group("b", 1)],
    40,
  );
  assertEquals(groupsCovered, 2);
  assertEquals(sampled.map((p) => p.label), ["G1-P1", "G2-P1"]);
});

Deno.test("normalizeGroupSuggestions: maps numbers/labels to ids and clamps confidence", () => {
  const { sampled } = sampleGroupsForVerify([group("a", 2), group("b", 2)], 40);
  const suggestions = normalizeGroupSuggestions(
    [
      { type: "merge", group_a: 1, group_b: 2, confidence: 0.9, reason: "same jacket" },
      { type: "move", group_a: 2, group_b: 1, photo_labels: ["G2-P2"], confidence: 7, reason: "different tee" },
      { type: "split", group_a: 1, photo_labels: ["G1-P2"], confidence: -1, reason: "two items" },
    ],
    sampled,
    ["a", "b"],
  );
  assertEquals(suggestions.length, 3);
  assertEquals(suggestions[0], {
    type: "merge",
    group_ids: ["a", "b"],
    photo_ids: [],
    confidence: 0.9,
    reason: "same jacket",
  });
  assertEquals(suggestions[1]!.group_ids, ["b", "a"]);
  assertEquals(suggestions[1]!.photo_ids, ["b-p2"]);
  assertEquals(suggestions[1]!.confidence, 1); // clamped
  assertEquals(suggestions[2]!.photo_ids, ["a-p2"]);
  assertEquals(suggestions[2]!.confidence, 0); // clamped
});

Deno.test("normalizeGroupSuggestions: drops malformed / out-of-range / self-referential entries", () => {
  const { sampled } = sampleGroupsForVerify([group("a", 1), group("b", 1)], 40);
  const suggestions = normalizeGroupSuggestions(
    [
      { type: "merge", group_a: 1, group_b: 1, confidence: 0.9, reason: "self" },
      { type: "merge", group_a: 1, group_b: 99, confidence: 0.9, reason: "oob" },
      { type: "move", group_a: 1, group_b: 2, photo_labels: ["G9-P9"], confidence: 0.9, reason: "bad label" },
      { type: "split", group_a: 1, photo_labels: [], confidence: 0.9, reason: "no photos" },
      { type: "explode", group_a: 1, confidence: 0.9, reason: "bad type" },
      "garbage",
    ],
    sampled,
    ["a", "b"],
  );
  assertEquals(suggestions, []);
  // Non-array input is tolerated too.
  assertEquals(normalizeGroupSuggestions(null, sampled, ["a", "b"]), []);
  assert(Array.isArray(normalizeGroupSuggestions(undefined, sampled, ["a", "b"])));
});
