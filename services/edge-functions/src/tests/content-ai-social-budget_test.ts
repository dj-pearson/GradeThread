// The social generator's output budget must leave room for adaptive thinking.
//
// b605211fb raised max_tokens from 3072 to 8192 after five runs died to
// truncation. It was not enough. content_scheduler_runs on 2026-09-02 shows
// the SAME failure at the new number: "cut off at max_tokens mid-JSON
// (output_tokens=8192, chars=4446)" three times in two days, plus one "hit
// max_tokens before emitting any text". 4,446 chars of JSON is roughly 1,300
// tokens, so the other ~6,900 went to thinking. On claude-sonnet-5 a request
// that omits `thinking` runs ADAPTIVE thinking at the default effort (high),
// and a copywriting prompt that asks for seven variants under seven character
// limits invites a lot of it - counting characters is exactly the kind of work
// the model reasons through. max_tokens caps thinking and text together, so a
// budget sized for text alone loses whenever the model decides to think.
//
// Two knobs, both required:
//   - max_tokens at the non-streaming ceiling (16384) so a thoughtful run fits;
//   - output_config.effort below the default so the model does not spend that
//     room by default. Copy for a social post is not intelligence-sensitive
//     work, and lower effort also keeps the call inside AI_TIMEOUT_MS (120s):
//     the failing runs already took 73-100s to burn 8,192 tokens.
//
// Pinned as a source scan because the budget is a literal in the create()
// call and there is no seam to mock the Messages API around it.

import { assert } from "@std/assert";

const src = Deno.readTextFileSync(
  new URL("../lib/content-ai-social.ts", import.meta.url),
);

Deno.test("social generator budget is at least 16384 tokens", () => {
  const m = src.match(/max_tokens:\s*(\d+)/);
  assert(m, "no max_tokens literal found");
  assert(
    Number(m[1]) >= 16384,
    `max_tokens is ${m[1]}; thinking + seven variants did not fit in 8192`,
  );
});

Deno.test("social generator pins effort below the default", () => {
  const m = src.match(/output_config:\s*\{\s*effort:\s*"(low|medium)"/);
  assert(
    m,
    'expected output_config: { effort: "low" | "medium" } on the social create() call',
  );
});
