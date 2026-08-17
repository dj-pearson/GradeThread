// The failure that made five hourly runs unreadable, and the guard against it
// coming back.
//
// content_scheduler_runs recorded, over and over:
//   "social generation failed: AI response contained no text block"
//   "social generation failed: AI returned invalid JSON for social post"
//
// Both are true. Neither is the cause. The cause was max_tokens: the budget was
// sized on claude-sonnet-4-6 (where omitting `thinking` meant no thinking) and
// the default model moved to sonnet-5 in 5e034f66, where max_tokens caps
// thinking AND text together — then a seventh platform arrived in 4bc9ab30 and
// the number still did not move. `stop_reason: "max_tokens"` was on the
// response object the whole time and no call site read it.
//
//   deno test --allow-read src/tests/ai-response-text_test.ts
import { assert, assertEquals, assertThrows } from "@std/assert";
import { extractTextBlock, jsonParseError } from "../lib/ai-response-text.ts";

const msg = (over: Record<string, unknown>) => ({
  content: [],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 20 },
  ...over,
  // deno-lint-ignore no-explicit-any
}) as any;

Deno.test("a normal response still returns its text", () => {
  const r = msg({ content: [{ type: "text", text: "hello" }] });
  assertEquals(extractTextBlock(r, "surface"), "hello");
});

Deno.test("a leading thinking block does not hide the text", () => {
  // The original find() was already correct about this. Pinned so a future
  // 'simplification' to content[0] does not reintroduce a different bug while
  // fixing this one.
  const r = msg({
    content: [{ type: "thinking" }, { type: "text", text: "payload" }],
  });
  assertEquals(extractTextBlock(r, "surface"), "payload");
});

Deno.test("truncation says max_tokens, not 'no text block'", () => {
  // The exact prod shape: the budget went entirely to thinking, so the response
  // carries a thinking block and nothing else.
  const r = msg({
    content: [{ type: "thinking" }],
    stop_reason: "max_tokens",
    usage: { input_tokens: 4000, output_tokens: 3072 },
  });
  const err = assertThrows(() => extractTextBlock(r, "content-ai-social"), Error);
  assert(err.message.includes("max_tokens"), `cause not named: ${err.message}`);
  assert(err.message.includes("content-ai-social"), "surface not named");
  assert(
    err.message.includes("retrying will not help"),
    "an operator reading this must not be sent to retry a budget overrun",
  );
});

Deno.test("a refusal is not reported as a missing block", () => {
  const r = msg({ content: [], stop_reason: "refusal" });
  const err = assertThrows(() => extractTextBlock(r, "content-ai-blog"), Error);
  assert(err.message.includes("refusal"), `cause not named: ${err.message}`);
});

Deno.test("an unexplained empty response still reports stop_reason", () => {
  const r = msg({ content: [], stop_reason: "end_turn" });
  const err = assertThrows(() => extractTextBlock(r, "surface"), Error);
  assert(err.message.includes("end_turn"), `stop_reason dropped: ${err.message}`);
});

Deno.test("mid-JSON truncation reads as a budget problem, not a prompt problem", () => {
  // The other face of the same cause. Before this, it threw "AI returned
  // invalid JSON", which points at the prompt and costs an afternoon.
  const r = msg({ stop_reason: "max_tokens", usage: { output_tokens: 3072 } });
  const err = jsonParseError(r, "content-ai-social", '{"long_body":"half a po');
  assert(err.message.includes("cut off at max_tokens"), err.message);
  assert(err.message.includes("not a prompt problem"), err.message);
});

Deno.test("a genuinely malformed response is NOT blamed on the budget", () => {
  const r = msg({ stop_reason: "end_turn" });
  const err = jsonParseError(r, "content-ai-social", "sorry, here is the post:");
  assert(!err.message.includes("max_tokens"), `misattributed: ${err.message}`);
  assert(err.message.includes("unparseable JSON"), err.message);
});

// Files deliberately NOT covered by the guard below, each with the reason.
// This list can only shrink: a new file is covered by default, and an entry
// that stops matching fails the test rather than lingering.
const NOT_YET_MIGRATED: Record<string, string> = {
  // Grading pipeline. CLAUDE.md requires the grading-engine skill before any
  // edit here, and it is a different response shape: ai-grading.ts reads
  // `response.text` off a provider wrapper (US-2568), not a raw Messages
  // `content` array, so extractTextBlock does not even apply. It also runs
  // output_config.format, which guarantees schema-conformant JSON.
  "ai-grading.ts":
    "provider-wrapper response shape + structured outputs; grading-engine skill required",
  // Raw Messages shape and the SAME latent bug — max_tokens: 1024 with
  // gradingSamplingParams(), which on sonnet-5 means thinking shares that
  // budget. Left alone here only because it is grading-pipeline code; it needs
  // the grading-engine contract, not a drive-by edit.
  "ai-authenticity.ts":
    "grading pipeline; same class of bug, needs the grading-engine skill",
};

Deno.test("no content generator inlines the blind guard again", () => {
  // The pattern this replaced, in six files at once. It discards stop_reason,
  // which is the only field that names the cause.
  const dir = new URL("../lib/", import.meta.url);
  const offenders: string[] = [];
  for (const e of Deno.readDirSync(dir)) {
    if (!e.isFile || !e.name.endsWith(".ts")) continue;
    if (e.name === "ai-response-text.ts") continue; // documents the pattern
    if (e.name in NOT_YET_MIGRATED) continue;
    const src = Deno.readTextFileSync(new URL(e.name, dir));
    if (
      src.includes('throw new Error("AI response contained no text block")') ||
      src.includes('throw new Error("AI refresh response contained no text block")') ||
      src.includes('throw new Error("AI returned invalid JSON')
    ) {
      offenders.push(e.name);
    }
  }
  assertEquals(
    offenders,
    [],
    "these throw a symptom and drop stop_reason, so a truncated response is " +
      "indistinguishable from a broken prompt in the run log: " +
      offenders.join(", ") + ". Use extractTextBlock/jsonParseError.",
  );
});

Deno.test("the excluded files still exist and still have the pattern", () => {
  // An exclusion that no longer matches is a stale exemption, and a stale
  // exemption is how a guard quietly stops guarding. If one of these gets
  // fixed, this fails and the entry must be deleted.
  const dir = new URL("../lib/", import.meta.url);
  for (const [name, reason] of Object.entries(NOT_YET_MIGRATED)) {
    const src = Deno.readTextFileSync(new URL(name, dir));
    assert(
      src.includes('throw new Error("AI returned invalid JSON') ||
        src.includes("contained no text block"),
      `${name} no longer matches — delete its exemption (${reason})`,
    );
  }
});
