// US-2767: the assembled prompt, where the two outside-information blocks sit
// side by side and say opposite things.
//
// This is the join the unit tests cannot see. visual-candidates_test.ts proves
// the block is worded correctly in isolation; these prove it actually reaches
// the prompt, and that nothing merged it into the neighbouring block that says
// "ground truth - do not contradict". Those two instructions in one prompt is
// the failure this whole story exists to prevent, and it would look completely
// normal in a diff.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  buildUserPrompt,
  resolveVisualCandidates,
} from "../lib/ai-extract.ts";

Deno.test("with no candidates the prompt is unchanged from today", () => {
  const before = buildUserPrompt({ text: "gray half zip" });
  const after = buildUserPrompt({ text: "gray half zip", visualCandidates: [] });
  assertEquals(before, after);
  assert(!before.includes("UNVERIFIED EXTERNAL GUESS"));
});

Deno.test("candidates reach the prompt", () => {
  const prompt = buildUserPrompt({
    text: "gray half zip",
    visualCandidates: [
      { field: "brand", value: "Lululemon", support: 4, outOf: 5 },
    ],
  });
  assert(prompt.includes("UNVERIFIED EXTERNAL GUESS"));
  assert(prompt.includes("Lululemon"));
  assert(prompt.includes("4 of 5"));
});

Deno.test("a candidate is NEVER rendered inside the ground-truth block", () => {
  // The known-fields block is introduced as ground truth the model must not
  // contradict. If a visual guess ends up in there, the adjudication is over
  // before it starts and every test in visual-candidates_test.ts still passes.
  const prompt = buildUserPrompt({
    knownFields: { size: "M" },
    visualCandidates: [
      { field: "brand", value: "Lululemon", support: 4, outOf: 5 },
    ],
  });

  const knownStart = prompt.indexOf("ALREADY KNOWN");
  const candidateStart = prompt.indexOf("UNVERIFIED EXTERNAL GUESS");
  assert(knownStart > -1, "known block missing");
  assert(candidateStart > -1, "candidate block missing");

  // The ground-truth block ends where the candidate block begins; the brand
  // must not appear before that boundary.
  const groundTruthSection = prompt.slice(knownStart, candidateStart);
  assert(
    !groundTruthSection.includes("Lululemon"),
    "a visual guess was rendered as ground truth",
  );
  assert(groundTruthSection.includes("size"));
});

Deno.test("both blocks are present and keep their opposite framing", () => {
  const prompt = buildUserPrompt({
    knownFields: { size: "M" },
    visualCandidates: [
      { field: "brand", value: "Lululemon", support: 4, outOf: 5 },
    ],
  });
  assert(prompt.includes("do not contradict")); // the known block, unchanged
  assert(prompt.includes("NOT ground truth")); // the candidate block
  assert(prompt.includes("The tag wins"));
});

Deno.test("the candidate block precedes the call-the-tool instruction", () => {
  // Instructions after the final "call the tool" line are routinely ignored.
  const prompt = buildUserPrompt({
    visualCandidates: [
      { field: "type", value: "Leggings", support: 3, outOf: 3 },
    ],
  });
  const block = prompt.indexOf("UNVERIFIED EXTERNAL GUESS");
  const call = prompt.indexOf("Call extract_item_fields");
  assert(block > -1 && call > -1);
  assert(block < call, "the candidate block landed after the tool call line");
});

// ── The deadline (US-2768) ──────────────────────────────────────────────────
//
// The visual pass is started by the caller and awaited here, after the photos
// are inlined. By this point the model call is the only thing left, so every
// millisecond spent waiting is a millisecond the seller waits for nothing.

Deno.test("an already-resolved array passes straight through", async () => {
  const given = [{ field: "brand", value: "Nike", support: 3, outOf: 4 }];
  assertEquals(await resolveVisualCandidates(given), given);
});

Deno.test("nothing supplied is no candidates, not a wait", async () => {
  assertEquals(await resolveVisualCandidates(undefined), []);
});

Deno.test("a promise that resolves in time is used", async () => {
  const out = await resolveVisualCandidates(
    Promise.resolve([{ field: "type", value: "Hoodie", support: 2, outOf: 2 }]),
    50,
  );
  assertEquals(out[0]?.value, "Hoodie");
});

Deno.test("a SLOW pass is abandoned rather than waited on", async () => {
  const slow = new Promise<never[]>((resolve) =>
    setTimeout(() => resolve([]), 5_000)
  );
  const started = Date.now();
  const out = await resolveVisualCandidates(slow, 30);
  assert(Date.now() - started < 1_000, "waited for the slow pass");
  assertEquals(out, []);
});

Deno.test("a REJECTED pass yields no candidates and does not throw", async () => {
  const out = await resolveVisualCandidates(
    Promise.reject(new Error("eBay 503")),
    50,
  );
  assertEquals(out, []);
});

Deno.test("a pass that rejects AFTER the deadline cannot crash the container", async () => {
  // An abandoned promise that later rejects with nobody attached surfaces as an
  // unhandled rejection, and an unhandled rejection in this service is a
  // crash-loop (vault/10-ops/edge-hang-vs-crash-loop.md). It must be caught
  // even though its value is no longer wanted.
  let reject: (e: Error) => void = () => {};
  const late = new Promise<never>((_, r) => {
    reject = r;
  });
  const out = await resolveVisualCandidates(late, 20);
  assertEquals(out, []);
  reject(new Error("late failure"));
  // Give the rejection a turn to surface. The test sanitizer fails the run if
  // it went unhandled.
  await new Promise((r) => setTimeout(r, 30));
});

Deno.test("a timed-out pass leaves the prompt identical to having none", async () => {
  const slow = new Promise<never[]>((resolve) =>
    setTimeout(() => resolve([]), 5_000)
  );
  const candidates = await resolveVisualCandidates(slow, 20);
  assertEquals(
    buildUserPrompt({ text: "gray half zip", visualCandidates: candidates }),
    buildUserPrompt({ text: "gray half zip" }),
  );
});
