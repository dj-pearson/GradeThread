// US-1904: pure boundary → groups mapping for AI propose-groups.
//   deno test --allow-env --allow-net --allow-read src/tests/ai-group-propose_test.ts
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { boundariesToGroups } = await import("../lib/ai-group-propose.ts");

const photos = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, url: `http://x/${i + 1}.jpg` }));

Deno.test("boundariesToGroups: partitions into contiguous runs at each boundary", () => {
  const groups = boundariesToGroups(photos(7), [
    { photo: 1, confidence: 1, reason: "start" },
    { photo: 4, confidence: 0.9, reason: "new jacket" },
    { photo: 6, confidence: 0.7, reason: "new tee" },
  ]);
  assertEquals(groups.map((g) => g.photo_ids), [
    ["p1", "p2", "p3"],
    ["p4", "p5"],
    ["p6", "p7"],
  ]);
  assertEquals(groups[1]!.confidence, 0.9);
  assertEquals(groups[2]!.reason, "new tee");
});

Deno.test("boundariesToGroups: photo 1 is always a boundary even if the model omits it", () => {
  const groups = boundariesToGroups(photos(4), [{ photo: 3, confidence: 0.8, reason: "" }]);
  assertEquals(groups.map((g) => g.photo_ids), [["p1", "p2"], ["p3", "p4"]]);
  assertEquals(groups[0]!.confidence, 1); // implicit start is full confidence
});

Deno.test("boundariesToGroups: one group when there are no interior boundaries", () => {
  const groups = boundariesToGroups(photos(5), []);
  assertEquals(groups.length, 1);
  assertEquals(groups[0]!.photo_ids, ["p1", "p2", "p3", "p4", "p5"]);
});

Deno.test("boundariesToGroups: drops out-of-range / malformed / duplicate boundaries", () => {
  const groups = boundariesToGroups(photos(3), [
    { photo: 0, confidence: 1, reason: "before start" },
    { photo: 9, confidence: 1, reason: "past end" },
    { photo: "2", confidence: 0.5, reason: "not an int" },
    { photo: 2, confidence: 5, reason: "clamped" }, // valid; confidence clamps to 1
    { photo: 2, confidence: 0.6, reason: "dup wins" }, // later dup replaces
  ]);
  assertEquals(groups.map((g) => g.photo_ids), [["p1"], ["p2", "p3"]]);
  assertEquals(groups[1]!.confidence, 0.6);
});

Deno.test("boundariesToGroups: clamps confidence and defaults a non-numeric one", () => {
  const groups = boundariesToGroups(photos(3), [
    { photo: 2, confidence: -3, reason: "" }, // clamps to 0
    { photo: 3, confidence: "x", reason: "" }, // non-finite → 0.5
  ]);
  assertEquals(groups[1]!.confidence, 0);
  assertEquals(groups[2]!.confidence, 0.5);
});

Deno.test("boundariesToGroups: empty photos → empty; ignores a non-array boundary payload", () => {
  assertEquals(boundariesToGroups([], [{ photo: 1, confidence: 1, reason: "" }]), []);
  const groups = boundariesToGroups(photos(2), "not-an-array");
  assertEquals(groups.length, 1);
  assert(groups[0]!.photo_ids.length === 2);
});
