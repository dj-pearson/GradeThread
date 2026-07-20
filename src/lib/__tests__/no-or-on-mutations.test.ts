// `.or(...)` must never be applied to a supabase-js UPDATE / DELETE / UPSERT.
//
// US-1552. The self-hosted production PostgREST rejects logical operators on
// mutations with 42703 ("column <table>.x does not exist" — it is complaining
// about the update-CTE alias, which is why the error looks unrelated). The
// NEWER PostgREST in the local Supabase stack accepts them happily.
//
// That version split is the whole problem: this is a defect CI cannot catch by
// RUNNING anything. `verify:db` boots the local stack, the query succeeds, the
// suite goes green, and the failure appears only against prod. A source guard
// is the only mechanism available, which is presumably why the rule has lived
// as prose in CLAUDE.md, in the durable-jobs skill, and as inline warnings in
// seven source files — none of which can fail.
//
// The codebase is currently clean (verified across 2,137 files). This exists so
// it stays that way.
//
// The sanctioned rewrite is sequential conditional updates:
//     await sb.from("jobs").update(p).eq("id", id).eq("status", "pending");
//     await sb.from("jobs").update(p).eq("id", id)
//       .eq("status", "running").lt("updated_at", stale);
// `.or()` on a SELECT is fine and is not flagged.
import { describe, expect, it } from "vitest";
import { relative, sep } from "node:path";
import { sourceTexts, SCAN_TIMEOUT_MS } from "./_source-scan";

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "functions", "services/edge-functions/src"];
const MUTATIONS = ["update", "delete", "upsert"];

// US-2129: the walk + read now live in _source-scan.ts and are memoized, so the
// two heavy tests below share ONE pass over the tree. Previously each re-read
// all 2,235 files independently (21.6 MB twice), which is what pushed this file
// past vitest's default 5000ms timeout under parallel load and made it fail at
// random.
function sourceEntries(): Array<{ file: string; text: string }> {
  return sourceTexts(SCAN_DIRS, ROOT).filter((e) => /\.(ts|tsx)$/.test(e.file));
}


/**
 * The full method chain starting at a `.update(` / `.delete(` / `.upsert(`.
 *
 * Tracks parenthesis depth and string/template state, so a `;`, `)` or quote
 * inside an argument cannot end the walk early. Returns the chain text.
 */
export function chainFrom(src: string, mutationIdx: number): string {
  const open = src.indexOf("(", mutationIdx);
  if (open === -1) return "";
  let i = open;
  let depth = 0;
  let quote: string | null = null;

  for (; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === quote && src[i - 1] !== "\\") quote = null;
      continue;
    }
    // COMMENTS MUST BE SKIPPED BEFORE STRING HANDLING. An apostrophe in prose —
    // `// the caller didn't send one` — otherwise opens a single-quote "string"
    // that never closes, so the walk swallows the rest of the file and reports
    // the next unrelated `.or()` as a hit. That is exactly what happened on
    // flipdesk-ebay.ts:6058, a correct `.update().eq()`, when this walker was
    // first dropped in. A false POSITIVE is how a guard gets disabled.
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf(String.fromCharCode(10), i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(") { depth++; continue; }
    if (c === ")") {
      depth--;
      if (depth === 0) {
        // Closed this call's args. Continue only if a `.name(` follows.
        let j = i + 1;
        while (j < src.length && /\s/.test(src[j]!)) j++;
        const next = /^\.([A-Za-z_$][\w$]*)\s*\(/.exec(src.slice(j, j + 60));
        if (!next) break;
        i = j + next[0].length - 1;
        depth = 1;
      }
    }
  }
  return src.slice(mutationIdx, Math.min(i + 1, src.length));
}

interface Hit {
  file: string;
  line: number;
  snippet: string;
}

function findHits(entries: Array<{ file: string; text: string }>): Hit[] {
  const hits: Hit[] = [];
  for (const { file, text } of entries) {
    const rel = relative(ROOT, file).split(sep).join("/");
    if (rel === "src/lib/__tests__/no-or-on-mutations.test.ts") continue;

    for (const m of text.matchAll(
      new RegExp(`\\.(${MUTATIONS.join("|")})\\s*\\(`, "g"),
    )) {
      // A supabase chain is one statement, so the chain has to END somewhere —
      // but "slice to the first semicolon" ends it in the WRONG place when an
      // earlier argument contains one inside a string literal
      // (`.update({ note: "a; b" }).or(...)`). That truncates before the `.or()`
      // and the guard passes on the exact bug it exists to catch: a false
      // NEGATIVE, which is the failure mode that matters for a guard.
      //
      // So walk the chain properly, tracking paren depth and string state, and
      // stop when the method chain genuinely ends.
      const chain = chainFrom(text, m.index!);
      if (!/\.or\s*\(/.test(chain)) continue;

      hits.push({
        file: rel,
        line: text.slice(0, m.index!).split("\n").length,
        snippet: chain.replace(/\s+/g, " ").slice(0, 130),
      });
    }
  }
  return hits;
}

describe("US-1552: no .or() on a supabase mutation", () => {
  // Read ONCE for all three tests (US-2129).
  const entries = sourceEntries();

  it("scans a plausible number of files", () => {
    // If the walk breaks, the guard below passes while checking nothing.
    expect(entries.length, "source scan found almost nothing — the walk broke").toBeGreaterThan(500);
  });

  it("finds mutation chains at all", () => {
    // And if the mutation regex stops matching, likewise. Proves the detector
    // is still looking at real code rather than silently matching zero things.
    let mutations = 0;
    for (const { text } of entries) {
      mutations += [...text.matchAll(new RegExp(`\\.(${MUTATIONS.join("|")})\\s*\\(`, "g"))].length;
    }
    expect(mutations, "no .update()/.delete()/.upsert() calls found — detector broke").toBeGreaterThan(
      100,
    );
  }, SCAN_TIMEOUT_MS);

  it("no mutation chain uses .or()", () => {
    const hits = findHits(entries);
    expect(
      hits,
      "These apply .or() to a mutation. Prod PostgREST rejects this with a 42703 " +
        "that names a column nobody wrote, and the local stack ACCEPTS it — so no " +
        "test run can catch it. Rewrite as sequential conditional updates " +
        "(US-1552, CLAUDE.md):\n  " +
        hits.map((h) => `${h.file}:${h.line}  ${h.snippet}`).join("\n  "),
    ).toEqual([]);
  }, SCAN_TIMEOUT_MS);
});
