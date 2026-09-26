// US-3526 AC2: runEval can measure with the live baseline and exemplars, as an
// opt-in that can never qualify a prompt. A SOURCE guard, like the other runEval
// tests: driving runEval needs the golden set and real vision calls.
import { assert } from "@std/assert";

const SRC = await Deno.readTextFile(new URL("../lib/grading-eval.ts", import.meta.url));
const RUN = SRC.slice(
  SRC.indexOf("export async function runEval("),
  SRC.indexOf("// ─── US-590"),
);

Deno.test("US-3526: live context is opt-in", () => {
  assert(/const liveContext = options\.liveContext === true;/.test(RUN));
  assert(/options: \{ liveContext\?: boolean \} = \{\}/.test(RUN));
});

Deno.test("US-3526: by default the eval still measures the prompt alone", () => {
  // Baseline empty and exemplars suppressed unless liveContext.
  assert(/const baselineBlock = liveContext\s*\?[\s\S]*?:\s*"";/.test(RUN));
  assert(/!liveContext,\s*\n\s*\);/.test(RUN), "exemplars must stay suppressed when not live");
});

Deno.test("US-3526: a live run is stored apart and never writes eval_passed", () => {
  assert(RUN.includes('prompt_version_id: blockRow || liveContext ? null : v.id'));
  assert(RUN.includes('`${v.version_name}+live`'));
  const writeBack = RUN.indexOf('.from("ai_prompt_versions")\n      .update({ eval_passed');
  const guard = RUN.indexOf("if (liveContext) {");
  assert(guard > -1 && writeBack > guard, "the eval_passed write-back must sit behind the liveContext guard");
});
