// US-3184: an operator script that can spend AI against prod must announce its
// model and refuse a drifted one.
//
// Today exactly two scripts can: backfill-tag-reads.ts and measure-eval.ts.
// Pinning those two files would pass forever while a third is written, and the
// third is the one that hurts - because by then the 2026-09-02 incident is a
// note somebody read once. So this scans scripts/ and requires the guard on
// anything that can reach the Anthropic client, transitively.
//
// ⚠ WHAT VERSION ONE OF THIS TEST DID NOT CHECK, and why each gap mattered:
//
//   1. It followed imports ONE hop. scripts/x.ts -> lib/a.ts -> lib/b.ts, with
//      the messages.create in b, read as a script that cannot spend.
//   2. It matched the bare string "checkModelDrift(". A script that called the
//      guard and then ignored verdict.ok passed, which is the whole of
//      "guards that do not guard".
//   3. It did not look at WHICH tier the script spends on. backfill-tag-reads
//      already imports ai-listing.ts (getPlatformVariantModel) and ai-extract.ts
//      (getLightweightModel); the day one of those gets called, the banner keeps
//      printing the default tier and the stale LIGHTWEIGHT_AI_MODEL sitting in
//      the same .env goes unmentioned. That is 2026-09-02, one tier over.
//
// So: transitive closure, verdict-is-acted-on, and tier coverage.

// US-2379: first, before anything that reaches lib/supabase.ts at import time.
// This file gained that reach when it started importing MODEL_TIER_RESOLVERS
// rather than keeping its own copy of the resolver names - which is the trade
// worth making: a private copy is what lets the table and the scan drift apart.
import "./_env.ts";

import { assert, assertEquals } from "@std/assert";
import { MODEL_TIER_RESOLVERS, type ModelTier } from "../lib/ai-config.ts";

const SCRIPTS = "scripts";

/** Modules that construct or use the Anthropic client. */
const AI_MARKERS = [
  "getAnthropicClient",
  "messages.create",
  "messages.stream",
];

const cache = new Map<string, string | null>();

async function read(path: string): Promise<string | null> {
  if (cache.has(path)) return cache.get(path)!;
  let src: string | null;
  try {
    src = await Deno.readTextFile(path);
  } catch {
    src = null;
  }
  cache.set(path, src);
  return src;
}

/** Resolve a relative TS import against the importing file's directory. */
function resolveImport(fromFile: string, spec: string): string {
  const parts = fromFile.split("/").slice(0, -1).concat(spec.split("/"));
  const out: string[] = [];
  for (const p of parts) {
    if (p === "." || p === "") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

/**
 * Value imports only.
 *
 * `import type { X } from "./y.ts"` is erased before anything runs, so a module
 * reached only that way cannot spend a cent - scripts/backfill-tag-reads.ts
 * takes exactly one type off ai-extract.ts, and counting that as "can reach
 * getLightweightModel" would make the script declare a tier it never touches.
 * Over-declaring is not free: it turns an unrelated stale pin into a refusal,
 * and a guard that cries wolf gets --allow-model-drift taped to the command.
 */
async function localImports(file: string): Promise<string[]> {
  const src = await read(file);
  if (!src) return [];
  const out: string[] = [];
  for (const m of src.matchAll(/\bimport\s+(type\s+)?[^;]*?from\s+"(\.[^"]+\.ts)"/g)) {
    if (m[1]) continue;
    out.push(resolveImport(file, m[2]!));
  }
  return out;
}

/**
 * ai-config.ts DEFINES every resolver, so it mentions all seven. Scanning it
 * for calls makes every script look like it spends on every tier, which reads
 * as maximum strictness and is really no signal at all.
 */
const RESOLVER_DEFINITION_SITE = "src/lib/ai-config.ts";

/**
 * Every module reachable from `entry`, entry included.
 *
 * Full closure, not one hop: an AI call three modules down spends exactly the
 * same money as one in the script itself.
 */
async function closure(entry: string): Promise<string[]> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    if (!(await read(file))) continue;
    seen.add(file);
    for (const dep of await localImports(file)) queue.push(dep);
  }
  return [...seen];
}

/** Which model-tier resolvers does this closure call? */
async function tiersSpentOn(files: string[]): Promise<Set<ModelTier>> {
  const found = new Set<ModelTier>();
  for (const f of files) {
    if (f === RESOLVER_DEFINITION_SITE) continue;
    const src = await read(f);
    if (!src) continue;
    for (const [tier, fn] of Object.entries(MODEL_TIER_RESOLVERS)) {
      if (src.includes(`${fn}()`)) found.add(tier as ModelTier);
    }
  }
  return found;
}

/** Recursively list every .ts file under a directory. */
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory) out.push(...(await walk(path)));
    else if (e.isFile && e.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

interface Spender {
  path: string;
  src: string;
  tiers: Set<ModelTier>;
}

async function findSpenders(): Promise<{ spenders: Spender[]; scanned: number }> {
  const files = await walk(SCRIPTS);
  const spenders: Spender[] = [];
  for (const path of files) {
    const files = await closure(path);
    let reaches = false;
    for (const f of files) {
      const src = await read(f);
      if (src && AI_MARKERS.some((m) => src.includes(m))) {
        reaches = true;
        break;
      }
    }
    if (!reaches) continue;
    spenders.push({
      path,
      src: (await read(path))!,
      tiers: await tiersSpentOn(files),
    });
  }
  return { spenders, scanned: files.length };
}

Deno.test("US-3184: every AI-spending operator script checks for model drift", async () => {
  const { spenders, scanned } = await findSpenders();
  const offenders = spenders
    .filter((s) => !s.src.includes("checkModelDrift("))
    .map((s) =>
      `${s.path}: can reach an Anthropic call but never calls checkModelDrift(). ` +
      `Add the banner + refusal from src/lib/operator-model-guard.ts, or, if ` +
      `it genuinely cannot spend, stop importing the module that can.`
    );

  assert(scanned > 10, `scanned only ${scanned} scripts - the walk broke`);
  assertEquals(offenders, [], offenders.join("\n"));
  // Guard-the-guard: if the scan stops FINDING the one script we know spends,
  // it has silently started passing on everything.
  assert(
    spenders.some((s) => s.path === "scripts/backfill-tag-reads.ts"),
    `the scan no longer sees backfill-tag-reads.ts as AI-spending, so a clean ` +
      `result here means nothing. Saw: ${
        spenders.map((s) => s.path).join(", ") || "(none)"
      }`,
  );
});

Deno.test("US-3184: the guard's verdict is acted on, not merely obtained", async () => {
  // Calling checkModelDrift and dropping the result reads identically to being
  // guarded in every grep, every diff and every review. It is the cheapest way
  // for this whole mechanism to become decoration.
  const { spenders } = await findSpenders();
  const offenders: string[] = [];
  for (const s of spenders) {
    if (!s.src.includes("checkModelDrift(")) continue;
    const printsBanner = /\.banner/.test(s.src);
    const exitsOnRefusal = /\.ok\b/.test(s.src) && /Deno\.exit\(/.test(s.src);
    if (!printsBanner || !exitsOnRefusal) {
      offenders.push(
        `${s.path}: calls checkModelDrift() but ${
          !printsBanner ? "never prints verdict.banner" : ""
        }${!printsBanner && !exitsOnRefusal ? " and " : ""}${
          !exitsOnRefusal ? "never exits on !verdict.ok" : ""
        }. A verdict nobody reads is not a guard.`,
      );
    }
  }
  assertEquals(offenders, [], offenders.join("\n"));
});

Deno.test("US-3184: a script declares its tiers through resolveOperatorModels", async () => {
  // THE TIER GAP, and why this test is shaped the way it is.
  //
  // The first guard compared getDefaultModel() against the code default and
  // nothing else. That was right for the two scripts that existed and would
  // have been wrong for the next one: the same stale .env that pinned
  // DEFAULT_AI_MODEL on 2026-09-02 also pins LIGHTWEIGHT_AI_MODEL.
  //
  // The obvious fix - "declare every tier your import closure reaches" - was
  // tried and measured here first. It makes backfill-tag-reads.ts declare five
  // tiers, four of which it never calls, because it imports ai-listing.ts for
  // one pure helper. Every one of those four is a refusal waiting to fire on an
  // unrelated env line, and a guard that cries wolf gets --allow-model-drift
  // taped to the command line. So the closure is NOT the rule.
  //
  // The real enforcement is at runtime: resolveOperatorModels() arms
  // ai-config.ts, and an undeclared tier throws when it resolves (see
  // operator-model-guard_test.ts). All this test has to do is make sure every
  // spender goes through that door rather than hand-building a pair, which
  // would leave the arming off.
  const { spenders } = await findSpenders();
  const offenders = spenders
    .filter((s) => !/models:\s*resolveOperatorModels\(/.test(s.src))
    .map((s) =>
      `${s.path}: passes checkModelDrift a hand-built model pair instead of ` +
      `models: resolveOperatorModels([...]). The hand-built form does not arm ` +
      `the tier check in ai-config.ts, so a call this script adds later to ` +
      `${
        [...s.tiers].map((t) => MODEL_TIER_RESOLVERS[t]).join("/") ||
        "another tier"
      } would spend unannounced.`
    );
  assertEquals(offenders, [], offenders.join("\n"));
  assert(spenders.length > 0, "no AI-spending scripts found - the scan broke");
});
