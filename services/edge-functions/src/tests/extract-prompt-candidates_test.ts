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
import { buildUserPrompt } from "../lib/ai-extract.ts";

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
