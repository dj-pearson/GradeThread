// A `limit` on a MUTATION needs an explicit `order`, or PostgREST refuses it.
//
// PROVEN AGAINST POSTGREST 12 on the real schema, not read off the docs. The
// exact PATCH supabase-js builds for `.update(...).limit(n)` answers:
//
//   {"code":"PGRST109","message":"A 'limit' was applied without an explicit
//    'order'","hint":"Apply an 'order' using unique column(s)"}   HTTP 400
//
// with two controls beside it: the same PATCH WITHOUT `limit` returns 200, and
// the same PATCH with `limit` plus `order=id` returns 200. So the qualifier is
// the whole cause.
//
// WHAT IT COST. jobs-trial-expiry.ts shipped `.update(...).select("id")
// .limit(BATCH_LIMIT)` with no order. Every run returned 400, the handler
// answered 500, and it did that on every single daily run for as long as the
// cron ledger goes back — 7 of 7 in the last week. No expired trial has ever
// been downgraded to Free by it.
//
// WHY NOTHING CAUGHT IT. It type-checks, it lints, and supabase-js is happy to
// build the request. Only the server objects, and only at runtime. That is the
// same shape as the `.or()`-on-mutation gotcha CLAUDE.md already documents:
// "the self-hosted prod PostgREST rejects logical operators on mutations while
// the newer local-stack PostgREST accepts them, so CI can't catch it." This
// guard is the source-level check that class needs, because the failure is
// silent everywhere except production.
//
//   deno test --allow-read src/tests/mutation-qualifier-guard_test.ts
import { assertEquals } from "@std/assert";

const SRC = new URL("../", import.meta.url);

function tsFiles(dir: URL): URL[] {
  const out: URL[] = [];
  for (const e of Deno.readDirSync(dir)) {
    const child = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
    if (e.isDirectory) {
      if (e.name === "tests") continue;
      out.push(...tsFiles(child));
    } else if (e.name.endsWith(".ts")) {
      out.push(child);
    }
  }
  return out;
}

/**
 * Comments are stripped BEFORE scanning, and that is not a nicety: the first
 * version of this guard flagged jobs-trial-expiry.ts for a `.or()` that existed
 * only inside the comment explaining why `.or()` is forbidden. A guard that
 * reads its own documentation is a guard that fires on it.
 *
 * The `[^:]` before `//` keeps `https://` in a URL from starting a comment.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Every `.update(` / `.delete(` chain, sliced to the end of its statement.
 *
 * Crude on purpose: a real parse would be better, and this guards one specific
 * string pattern rather than standing in for a type system. Slicing at the
 * first `;` is what keeps a later, unrelated `.limit()` in the same function
 * from reading as part of this chain.
 */
function mutationChains(raw: string): string[] {
  const src = stripComments(raw);
  const chains: string[] = [];
  for (const m of src.matchAll(/\.(update|delete)\(/g)) {
    const rest = src.slice(m.index!);
    const end = rest.indexOf(";");
    chains.push(rest.slice(0, end === -1 ? 900 : end));
  }
  return chains;
}

// CALL ORDER DOES NOT MATTER, and the check is deliberately written that way.
// `.limit(50).order("id")` and `.order("id").limit(50)` build the SAME request:
// both methods are `this.url.searchParams.set(...)` followed by `return this`
// (@supabase/postgrest-js PostgrestTransformBuilder), so the JS call sequence
// never reaches the wire. PostgREST only asks whether `order` is present.
//
// Checked against the installed source, not assumed — a sabotage probe of
// `.limit().order()` passed this guard and the first reading was that the guard
// was blind. It is not; that shape is legal and reporting it would have been a
// false alarm. Recorded here so the next person does not "tighten" this into
// requiring a call order and break working code.
Deno.test("no mutation carries a limit without an explicit order", () => {
  const offenders: string[] = [];
  for (const file of tsFiles(SRC)) {
    const src = Deno.readTextFileSync(file);
    for (const chain of mutationChains(src)) {
      if (chain.includes(".limit(") && !chain.includes(".order(")) {
        offenders.push(file.pathname.split("/src/")[1] ?? file.pathname);
      }
    }
  }
  assertEquals(
    offenders,
    [],
    "PostgREST answers PGRST109 / HTTP 400 to a limit on a mutation with no " +
      "order, so these return an error on EVERY run and their handler reports " +
      "a 500 that no test can see: " + offenders.join(", ") +
      ". Add .order(\"<unique column>\") to the chain.",
  );
});

Deno.test("the sibling gotcha stays fixed: no .or() on a mutation", () => {
  // CLAUDE.md's US-1552 rule, in the same guard because it is the same class
  // and the same blind spot — accepted by the local stack, refused by prod, so
  // only a source check can hold it.
  const offenders: string[] = [];
  for (const file of tsFiles(SRC)) {
    const src = Deno.readTextFileSync(file);
    for (const chain of mutationChains(src)) {
      if (/\.or\(/.test(chain)) {
        offenders.push(file.pathname.split("/src/")[1] ?? file.pathname);
      }
    }
  }
  assertEquals(
    offenders,
    [],
    "the self-hosted prod PostgREST rejects logical operators on mutations " +
      "(42703, the update-CTE alias) while the local stack accepts them: " +
      offenders.join(", ") + ". Use sequential conditional updates.",
  );
});
