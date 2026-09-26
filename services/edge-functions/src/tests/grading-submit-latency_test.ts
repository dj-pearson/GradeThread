// US-3533: the submit path cleans up after a partial failure, and the pipeline
// starts its independent setup reads together.
import "./_env.ts";
import { assert } from "@std/assert";

const read = (p: string) => Deno.readTextFileSync(new URL(p, import.meta.url));

Deno.test("US-3533: every early return in the upload loop removes the photos already stored", () => {
  const grade = read("../routes/grade.ts");
  const start = grade.indexOf(
    "  for (let i = 0; i < imageFiles.length; i++) {",
  );
  const end = start + grade.slice(start).indexOf("    imageRecords.push({");
  const loop = grade.slice(start, end);
  const deletes = loop.split(
    'await supabaseAdmin.from("submissions").delete().eq("id", submissionId);',
  ).length - 1;
  const discards = loop.split("await discardUploadedPhotos();").length - 1;
  assert(deletes >= 3, "the loop has its early returns");
  assert(
    deletes === discards,
    "each submission delete is preceded by a photo cleanup",
  );
});

Deno.test("US-3533: the setup reads are started before any of them is awaited", () => {
  const pipe = read("../lib/grading-pipeline.ts");
  const starts = [
    "const cascadeP = getCascadeConfig();",
    "const baselineP = getGarmentBaseline({",
    "const visualSettingP = getSetting<",
  ]
    .map((m) => pipe.indexOf(m));
  const firstAwait = pipe.indexOf("const cascade = await cascadeP;");
  for (const i of starts) assert(i > 0 && i < firstAwait);
  assert(
    pipe.includes("p.catch(() => {});"),
    "early-started promises are marked handled",
  );
});

Deno.test("US-3533: 00843 adds submissions to the realtime publication, guarded", () => {
  const sql = read(
    "../../../../supabase/migrations/00843_realtime_submissions.sql",
  );
  assert(
    sql.includes(
      "ALTER PUBLICATION supabase_realtime ADD TABLE public.submissions;",
    ),
  );
  assert(
    sql.includes(
      "SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'",
    ),
  );
});
