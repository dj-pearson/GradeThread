// US-2674 AC2, the half listing-gen-prompt-v2_test.ts does not reach.
//
// That file pins the code DEFAULT: LISTING_GEN_PROMPT_VERSION is still v1, so
// editing the default to hot-swap the champion past the eval gate reddens the
// suite. That closes one door. AC2 says activation goes through
// activatePromptVersion, which is a claim about EVERY door, and the remaining
// ones are absences — code that could exist and must not.
//
// Two guards, both about turning a prompt ON:
//   1. Nothing outside grading-eval.ts writes is_active TRUE on
//      ai_prompt_versions. That is what would bypass the eval gate and the
//      US-2307 model stamp.
//   2. The admin PATCH cannot smuggle is_active into its payload. It is the one
//      writer whose payload is a variable, so guard 1 cannot read it.
//
// ⚠ THE FIRST VERSION OF GUARD 1 WAS WRONG, and it failing is the only reason
// this file is right. It flagged any .update() on ai_prompt_versions and named
// four files. All four are legitimate and none of them promotes:
//   accuracy-tracking.ts   writes accuracy_score
//   listing-eval.ts        writes eval_passed + qualified_model — its own verdict
//   listing-acceptance.ts  reads the columns, promotes via activatePromptVersion
//   admin-grading.ts       creates drafts with is_active FALSE, patches text
// A guard that forbids every write forbids the eval recording its own result.
// What AC2 forbids is a SECOND WAY TO TURN A PROMPT ON.

import { assert, assertEquals } from "@std/assert";

const read = (p: string) => Deno.readTextFileSync(new URL(p, import.meta.url));

Deno.test("US-2674 AC2: nothing outside activatePromptVersion sets is_active TRUE", () => {
  const libDir = new URL("../lib/", import.meta.url);
  const routeDir = new URL("../routes/", import.meta.url);
  const offenders: string[] = [];

  for (const dir of [libDir, routeDir]) {
    for (const entry of Deno.readDirSync(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
      if (entry.name === "grading-eval.ts") continue; // the one legitimate door
      const src = Deno.readTextFileSync(new URL(entry.name, dir));
      if (!src.includes("ai_prompt_versions")) continue;
      // Every window from an ai_prompt_versions builder to a write. Setting
      // is_active FALSE is fine — that is a draft being created or a version
      // being stood down. TRUE is the promotion.
      const re =
        /\.from\(\s*["']ai_prompt_versions["']\s*\)([\s\S]{0,600}?)\.(update|upsert|insert)\(([\s\S]{0,400})/g;
      for (const m of src.matchAll(re)) {
        if (/is_active:\s*true/.test(m[3])) offenders.push(entry.name);
      }
    }
  }

  assertEquals(
    [...new Set(offenders)].sort(),
    [],
    `these files activate a prompt version outside activatePromptVersion: ${
      [...new Set(offenders)].join(", ")
    }. Promotion must go through it so the eval gate and the US-2307 model stamp ` +
      `cannot be bypassed (US-2674 AC2).`,
  );
});

Deno.test("US-2674 AC2: the admin prompt PATCH cannot smuggle is_active", () => {
  // routes/admin-grading.ts builds `patch` field by field and hands it to
  // .update(patch), so the guard above cannot read what is in it. Stating that
  // limit and then closing it, rather than leaving a hole under a green tick.
  const src = read("../routes/admin-grading.ts");
  const start = src.indexOf("const patch: Record<string, unknown> = {}");
  assert(
    start > 0,
    "the prompt PATCH no longer builds a `patch` object — re-read this guard before trusting it",
  );
  const block = src.slice(start, src.indexOf(".update(patch)", start));
  const assigned = [...block.matchAll(/patch\.([a-zA-Z_]+)\s*=/g)].map((m) => m[1]);

  assertEquals(
    [...new Set(assigned)].sort(),
    ["garment_scope", "notes", "prompt_text", "version_name"],
    "the admin prompt PATCH assigns a field it did not before. If that field is " +
      "is_active, the admin console can activate a prompt without the eval gate " +
      "(US-2674 AC2).",
  );
});
