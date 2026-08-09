// US-2443 AC2 as a SOURCE guard: no shadow leg is ever awaited by the pipeline.
//
// The behavioural half of AC2 lives in grading-shadow-per-image_test.ts, which
// drives every failure branch through injected deps and shows the orchestrator
// resolving instead of throwing. That is necessary and not sufficient. The
// remaining way to make a seller wait on a shadow grade is at the CALL SITE:
// change `void f(...)` to `await f(...)` and every behavioural test still
// passes, because the function still never throws — it just now costs the
// seller a vision call per photo of latency on a grade they already earned.
//
// So this file reads the pipeline source. It is a lint rule with a reason, of
// the same kind as private-bucket-access_test.ts and upload-pipeline-coverage
// _test.ts: a shape that is cheap to break, invisible when broken, and only
// checkable by looking at the text.
import { assert, assertEquals } from "@std/assert";

const PIPELINE = new URL("../lib/grading-pipeline.ts", import.meta.url);
const source = await Deno.readTextFile(PIPELINE);

/** The two fire-and-forget shadow legs the pipeline is allowed to start. */
const SHADOW_ENTRYPOINTS = ["runShadowGrades", "runPerImageShadowGrades"];

Deno.test("US-2443 AC2: the pipeline starts both shadow legs and awaits neither", () => {
  for (const fn of SHADOW_ENTRYPOINTS) {
    // Ignore the import line — it mentions the name without calling it.
    const callSites = source
      .split("\n")
      .filter((l) => l.includes(`${fn}(`) && !l.trimStart().startsWith("import"));

    assertEquals(
      callSites.length,
      1,
      `${fn} should be called exactly once in grading-pipeline.ts, found ${callSites.length}`,
    );
    const line = callSites[0];

    assert(
      line.includes(`void ${fn}(`),
      `${fn} must be started with \`void\` in grading-pipeline.ts — found: ${line.trim()}`,
    );
    assert(
      !new RegExp(`await\\s+${fn}\\(`).test(line),
      `${fn} must NEVER be awaited by the pipeline — found: ${line.trim()}`,
    );
  }
});

Deno.test("US-2443 AC2: every shadow leg has a .catch so a rejection is not unhandled", () => {
  // `void f()` alone still produces an unhandled rejection if f ever rejects,
  // and Deno treats an unhandled rejection as fatal — which would take down the
  // request that started it. The orchestrators promise not to throw; the
  // `.catch` is the belt to that suspenders, and it is one edit away from gone.
  for (const fn of SHADOW_ENTRYPOINTS) {
    const start = source.indexOf(`void ${fn}(`);
    assert(start > -1, `no \`void ${fn}(\` call site in grading-pipeline.ts`);
    // The call's argument object, then `}).catch(`. Bound the search at the next
    // shadow call site so one leg's `.catch` can never satisfy the other's.
    const others = SHADOW_ENTRYPOINTS
      .map((o) => source.indexOf(`void ${o}(`, start + 1))
      .filter((i) => i > -1);
    const end = others.length ? Math.min(...others) : source.length;
    const window = source.slice(start, end);
    assert(
      window.includes("}).catch("),
      `${fn} must chain .catch(...) at its call site — a rejection there is fatal in Deno`,
    );
  }
});

Deno.test("US-2443 AC2: the per-image shadow never reads or writes grade_reports", async () => {
  // The seller's grade is already written when this runs. The orchestrator only
  // carries the report ID as a foreign key; if it ever gained a grade_reports
  // update, a shadow candidate could rewrite a delivered grade — which is the
  // exact failure AC2 exists to make impossible.
  const shadow = await Deno.readTextFile(
    new URL("../lib/grading-shadow-per-image.ts", import.meta.url),
  );
  const tables = [...shadow.matchAll(/\.from\("([^"]+)"\)/g)].map((m) => m[1]);
  const allowed = new Set([
    "grading_shadow_results",
    "ai_prompt_versions",
    "ai_prompt_block_versions",
  ]);
  for (const t of tables) {
    assert(allowed.has(t), `per-image shadow must not touch ${t}`);
  }
  // Comments stripped first: the file's own doc block SAYS "nothing here reads
  // or writes grade_reports", and a guard that a truthful comment fails is a
  // guard that gets deleted rather than fixed.
  const code = shadow
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
  assert(!code.includes("grade_reports"), "per-image shadow must not touch grade_reports");
});
