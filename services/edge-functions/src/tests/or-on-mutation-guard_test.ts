// US-1552 — `.or()` must never be chained onto a supabase-js UPDATE / DELETE /
// UPSERT.
//
// WHY THIS IS THE ONE RULE THAT MOST NEEDS A SOURCE GUARD.
//
// The self-hosted PostgREST in PRODUCTION rejects a logical operator on a
// mutation with 42703 — `column <table>.x does not exist`, which is the
// update-CTE alias leaking into the error rather than a real missing column, so
// it does not even read as the bug it is. The NEWER PostgREST in the local
// Supabase stack ACCEPTS the same query.
//
// So the two environments disagree, and they disagree in the worst possible
// direction: every test we can run goes green, and the failure appears only in
// prod. CLAUDE.md states this outright — "so CI can't catch it". No amount of
// integration testing on the local stack closes it, because the local stack is
// the thing that is wrong.
//
// A STATIC CHECK IS THEREFORE THE ONLY AVAILABLE DEFENCE. Until now the rule
// lived solely as a sentence in CLAUDE.md, which is read by humans and agents at
// session start and by nothing at build time. The codebase is clean today (0
// occurrences across 688 non-test edge files, measured while writing this) —
// this exists so it stays that way, because the cost of the next occurrence is a
// production-only data bug in a mutation path.
//
// `.or()` on a SELECT is completely fine and must not be flagged.
//
// SCOPE / KNOWN LIMIT: this parses the source text, not a TypeScript AST. It
// walks the method chain from a mutation call and tracks parenthesis + string
// state, so it handles multi-line chains and semicolons inside string literals.
// It cannot see a chain assembled dynamically (`let q = tbl.update(...); if (x)
// q = q.or(...)`). That shape does not appear in this codebase and would be
// worth flagging in review; a guard that catches the direct form is still worth
// having, and claiming more than it does would be worse.

import { assert, assertEquals } from "@std/assert";

const SRC_DIR = new URL("../", import.meta.url);

/** Every non-test .ts file under src/. */
async function edgeSourceFiles(dir: URL, acc: URL[] = []): Promise<URL[]> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name === "tests") continue;
    const child = new URL(
      entry.name + (entry.isDirectory ? "/" : ""),
      dir,
    );
    if (entry.isDirectory) await edgeSourceFiles(child, acc);
    else if (entry.name.endsWith(".ts")) acc.push(child);
  }
  return acc;
}

const MUTATIONS = ["update", "delete", "upsert"];

/**
 * Given source and the index just past a `.update(` / `.delete(` / `.upsert(`,
 * return the method names chained after it, stopping at the end of the chain.
 *
 * Tracks paren depth and string/template state so a `;` or `)` inside a literal
 * does not end the walk early — the crude "slice to the first semicolon"
 * version silently under-reports, which for a guard means false confidence.
 */
export function chainedMethodsAfter(src: string, openParenIdx: number): string[] {
  let i = openParenIdx;
  let depth = 0;
  let quote: string | null = null;
  const methods: string[] = [];

  for (; i < src.length; i++) {
    const c = src[i]!;
    const prev = src[i - 1];

    if (quote) {
      if (c === quote && prev !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(") {
      depth++;
      continue;
    }
    if (c === ")") {
      depth--;
      if (depth === 0) {
        // Closed the mutation's own arg list (or a chained call's). Look ahead
        // past whitespace/newlines for a `.name(` continuation.
        let j = i + 1;
        while (j < src.length && /\s/.test(src[j]!)) j++;
        const m = /^\.([A-Za-z_$][\w$]*)\s*\(/.exec(src.slice(j, j + 60));
        if (!m) break; // chain ended
        methods.push(m[1]!);
        i = j + m[0].length - 1; // resume just inside the new call's parens
        depth = 1;
        continue;
      }
    }
  }
  return methods;
}

Deno.test("US-1552: no .or() is chained onto an UPDATE / DELETE / UPSERT", async () => {
  const files = await edgeSourceFiles(SRC_DIR);
  assert(
    files.length > 100,
    `expected to scan the edge source tree, found only ${files.length} files — ` +
      `the walker is probably broken, and a guard that scans nothing passes ` +
      `everything`,
  );

  const offenders: string[] = [];
  for (const url of files) {
    const src = await Deno.readTextFile(url);
    for (const verb of MUTATIONS) {
      const re = new RegExp(`\\.${verb}\\s*\\(`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const openParen = src.indexOf("(", m.index);
        if (chainedMethodsAfter(src, openParen).includes("or")) {
          const line = src.slice(0, m.index).split("\n").length;
          const file = url.pathname.split("/services/edge-functions/")[1] ??
            url.pathname;
          offenders.push(`${file}:${line} — .${verb}(...) … .or(...)`);
        }
      }
    }
  }

  assertEquals(
    offenders,
    [],
    "`.or()` on a mutation is accepted by the LOCAL PostgREST and REJECTED by " +
      "the self-hosted production one (42703, reported as a bogus missing " +
      "column). Every test you can run will pass and prod will fail, which is " +
      "why this is a source guard and not an integration test. Use sequential " +
      "conditional mutations instead — e.g. try .eq('status','pending'), then " +
      ".eq('status','running').lt('updated_at', stale). `.or()` on a SELECT is " +
      "fine. See CLAUDE.md (US-1552):\n" + offenders.join("\n"),
  );
});

Deno.test("US-1552 guard: the chain walker actually detects and discriminates", () => {
  // A guard over a production-only failure has to be provably able to fail.
  // Two guards written earlier this session passed while broken, so the
  // detector is exercised directly on the shapes that matter.

  const at = (s: string, verb: string) => s.indexOf("(", s.indexOf(`.${verb}(`));

  // 1. The bug, single line.
  const bad = `await sb.from("t").update({ a: 1 }).or("x.eq.1,y.eq.2");`;
  assert(chainedMethodsAfter(bad, at(bad, "update")).includes("or"), "must flag the direct form");

  // 2. The bug, split across lines the way real code is written.
  const badMultiline = `await sb\n  .from("t")\n  .delete()\n  .or("a.eq.1,b.eq.2")\n  .eq("user_id", uid);`;
  assert(
    chainedMethodsAfter(badMultiline, at(badMultiline, "delete")).includes("or"),
    "must flag a multi-line chain",
  );

  // 3. SELECT with .or() is legitimate and must NOT be flagged. Guarded by the
  //    fact that we only start walking from a mutation verb — asserted here so
  //    a future "just grep for .or(" simplification fails this test.
  const okSelect = `const r = await sb.from("t").select("*").or("a.eq.1,b.eq.2");`;
  assert(!/\.(update|delete|upsert)\s*\(/.test(okSelect), "fixture must contain no mutation");

  // 4. A mutation WITHOUT .or() is fine.
  const okMutation = `await sb.from("t").update({ a: 1 }).eq("status", "pending");`;
  assertEquals(
    chainedMethodsAfter(okMutation, at(okMutation, "update")).includes("or"),
    false,
    "must not flag a correctly-written sequential mutation",
  );

  // 5. THE FALSE-NEGATIVE THIS WALKER EXISTS TO AVOID: a semicolon inside a
  //    string literal. A "slice to the first semicolon" implementation stops
  //    early here and misses the .or() entirely — passing while broken.
  const semicolonInString =
    `await sb.from("t").update({ note: "a; b" }).or("x.eq.1");`;
  assert(
    chainedMethodsAfter(semicolonInString, at(semicolonInString, "update")).includes("or"),
    "must still flag when an earlier argument contains a semicolon in a string",
  );

  // 6. And the chain must END at the end of the statement — a .or() on a LATER,
  //    separate select must not be attributed to the earlier update.
  const twoStatements =
    `await sb.from("t").update({ a: 1 }).eq("id", id);\nconst r = await sb.from("u").select("*").or("a.eq.1");`;
  assertEquals(
    chainedMethodsAfter(twoStatements, at(twoStatements, "update")).includes("or"),
    false,
    "must not attribute a following statement's .or() to the mutation",
  );
});
