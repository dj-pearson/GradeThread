// SNAP-02: a snap's vision spend lands in the grading budget that gates /snap.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { fileSnapUsage } = await import("../lib/ai-usage.ts");
type RecordAiUsageInput = import("../lib/ai-usage.ts").RecordAiUsageInput;
type AiTokenUsage = import("../lib/ai-usage.ts").AiTokenUsage;

function usage(model: string): AiTokenUsage {
  return {
    model,
    inputTokens: 1200,
    outputTokens: 300,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  } as AiTokenUsage;
}

Deno.test("fileSnapUsage files every phase under the owner and the grading feature", async () => {
  const seen: RecordAiUsageInput[] = [];
  const usages = [
    { phase: "quick_image_front", usage: usage("claude-sonnet") },
    { phase: "quick_composite", usage: usage("claude-sonnet") },
  ];
  await fileSnapUsage("owner-1", usages, (input) => {
    seen.push(input);
    return Promise.resolve();
  });
  assertEquals(seen.length, 1);
  assertEquals(seen[0].userId, "owner-1");
  assertEquals(seen[0].submissionId, null);
  // The budget /snap is gated on is "grading"; any other feature name would
  // leave that kill switch blind to snap spend again.
  assertEquals(seen[0].feature, "grading");
  assertEquals(seen[0].usages.map((u) => u.phase), ["quick_image_front", "quick_composite"]);
});

Deno.test("fileSnapUsage records nothing when the grade reported no usage", async () => {
  let calls = 0;
  await fileSnapUsage("owner-1", [], () => {
    calls++;
    return Promise.resolve();
  });
  assertEquals(calls, 0);
});

Deno.test("the /snap handler files the grade's usage after grading", async () => {
  const src = await Deno.readTextFile(new URL("../routes/grade.ts", import.meta.url));
  const at = src.indexOf('gradeRoutes.post("/snap"');
  const end = src.indexOf("gradeRoutes.", at + 10);
  const handler = src.slice(at, end);
  const graded = handler.indexOf("grade = gradeResult;");
  const filed = handler.indexOf("fileSnapUsage(ownerId, grade.usages)");
  assertEquals(graded > -1 && filed > graded, true);
});
