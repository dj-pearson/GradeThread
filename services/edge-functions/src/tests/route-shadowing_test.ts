// US-2954: no two routes in the same file may claim the same method and path.
//
// admin-grading.ts registered GET /accuracy/outcomes TWICE, about ninety lines
// apart. Hono serves the first match, so the second was dead code - and its own
// comment said "WIRED - Outcomes tab of GradingAccuracyPanel", which is the
// worst kind of wrong: a claim that reads like verification.
//
// The failure was invisible from either end. The route existed, the panel
// called it, the request returned 200. It returned the WRONG SHAPE, and the tab
// threw on an undefined array rather than showing bad numbers - so the symptom
// was "the Outcomes tab is broken" with nothing in the route to explain it.
//
// A duplicate is always a mistake here. Neither handler is reachable-by-design,
// there is no fallthrough in Hono to make the second meaningful, and the file
// is long enough that two people can add the same path a year apart without
// either seeing the other.

import { assertEquals } from "@std/assert";

const ROUTES_DIR = new URL("../routes/", import.meta.url);

/** One route registration: which router, the method, the path, and where. */
interface Registration {
  /**
   * The router variable it was registered on.
   *
   * NOT optional, and not cosmetic. help-center.ts declares THREE Hono
   * instances - helpPublicRoutes, helpReaderRoutes, helpAdminRoutes - mounted
   * at different prefixes, so GET "/" appearing on each of them is correct and
   * routine. A guard keyed on method+path alone called six of those a shadow.
   */
  router: string;
  method: string;
  path: string;
  line: number;
}

/**
 * Every `<router>.<method>("<path>"` in a source.
 *
 * Comments are stripped FIRST. This story's own fix leaves a comment that reads
 * `// GET /accuracy/outcomes - post-sale feedback`, and a scan that counted the
 * documentation would report a duplicate that does not exist - which is the
 * failure mode where a guard trips on the note written about it.
 */
export function extractRoutes(source: string): Registration[] {
  const code = stripComments(source);

  const out: Registration[] = [];
  // THE PATH MUST START WITH A SLASH, and that clause is the whole difference
  // between a route scan and a nonsense one. Hono's CONTEXT has a .get() too -
  // c.get("userId"), c.get("adminRole") - and without this the first run of this
  // guard reported HUNDREDS of duplicates across account.ts, admin-ads.ts and
  // admin-agents.ts, every one of them the same context key read twice in one
  // file. Every Hono route path starts with a slash; no context key does.
  const re =
    /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*(["'`])(\/[^"'`]*)\3/g;
  for (const m of code.matchAll(re)) {
    out.push({
      router: m[1]!,
      method: m[2]!.toUpperCase(),
      path: m[4]!,
      line: code.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

/**
 * Blank out comment lines, keeping the line count so reported line numbers are
 * real.
 *
 * LINE-BASED, WITH A FLAG, and not a regex - which is not a style preference.
 * The first version of this used /\\/\\*[\\s\\S]*?\\*\\//g and it destroyed 89% of
 * admin-grading.ts: 157,575 characters in, 17,657 out, and the route count fell
 * from 75 to 7. A stray "/*" inside a string or a line comment opens a block the
 * regex then closes at some far-away "*\/", swallowing every route between them.
 *
 * The failure is silent in the worst direction: fewer routes extracted means
 * fewer collisions found, so the guard reports a CLEAN codebase precisely
 * because it is broken. It passed a sabotage that reintroduced the exact
 * duplicate this story exists to prevent.
 *
 * A block comment here only ever starts a line (they are doc comments), so
 * requiring that is both true of the codebase and impossible to run away with.
 */
export function stripComments(source: string): string {
  let inBlock = false;
  return source
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      if (inBlock) {
        if (trimmed.includes("*/")) inBlock = false;
        return "";
      }
      if (trimmed.startsWith("/*")) {
        // A one-line /* ... */ closes on the same line.
        if (!trimmed.includes("*/")) inBlock = true;
        return "";
      }
      if (trimmed.startsWith("//")) return "";
      return line;
    })
    .join("\n");
}

/** Registrations that collide on method + path within one file. */
export function shadowedRoutes(source: string): string[] {
  const seen = new Map<string, Registration>();
  const clashes: string[] = [];
  for (const r of extractRoutes(source)) {
    const key = `${r.router} ${r.method} ${r.path}`;
    const first = seen.get(key);
    if (first) {
      clashes.push(
        `${r.method} ${r.path} on ${r.router} registered at line ${first.line} ` +
          `and again at line ${r.line} — Hono serves the first, so the second never runs`,
      );
    } else {
      seen.set(key, r);
    }
  }
  return clashes;
}

async function routeFiles(): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(ROUTES_DIR)) {
    if (entry.isFile && entry.name.endsWith(".ts")) out.push(entry.name);
  }
  return out.sort();
}

Deno.test("US-2954 AC4: the extractor still finds routes", async () => {
  // GUARDS THE GUARD. An extractor that stops matching reports zero duplicates
  // across every file, which is indistinguishable from a clean codebase.
  const files = await routeFiles();
  assertEquals(files.length > 10, true, `expected many route files, saw ${files.length}`);

  let total = 0;
  for (const name of files) {
    total += extractRoutes(await Deno.readTextFile(new URL(name, ROUTES_DIR))).length;
  }
  assertEquals(total > 200, true, `expected the extractor to find routes, saw ${total}`);
});

Deno.test("US-2954 AC4: comment stripping does not eat code", async () => {
  // THE FLOOR ABOVE WAS NOT ENOUGH, and this is why it is here. With the
  // original regex stripper the extractor found 7 of admin-grading.ts's 75
  // registrations - and the total across all files still cleared 200, so the
  // floor passed while the guard was blind. Per-file, against a count taken
  // from the RAW source, is the check that actually notices.
  for (const name of await routeFiles()) {
    const src = await Deno.readTextFile(new URL(name, ROUTES_DIR));
    const rawCount =
      [...src.matchAll(/\b[A-Za-z_$][\w$]*\s*\.\s*(?:get|post|put|patch|delete|all)\s*\(\s*["'`]\//g)]
        .length;
    if (rawCount === 0) continue;
    const kept = extractRoutes(src).length;
    assertEquals(
      kept >= Math.floor(rawCount * 0.8),
      true,
      `${name}: comment stripping dropped ${rawCount - kept} of ${rawCount} registrations ` +
        "— the stripper is swallowing code, and a guard that sees fewer routes " +
        "reports fewer collisions",
    );
  }
});

Deno.test("US-2954 AC4: a deliberate duplicate is caught", () => {
  // The fixture is the shape that shipped: two GETs on one path, far apart,
  // the second carrying a comment insisting it is wired.
  const fixture = `
    const r = new Hono();
    r.get("/accuracy/outcomes", async (c) => c.json({ a: 1 }));
    r.post("/model-comparison", async (c) => c.json({}));
    // GET /accuracy/outcomes — post-sale feedback per category.
    // US-1564 wire decision: WIRED — Outcomes tab of GradingAccuracyPanel.
    r.get("/accuracy/outcomes", async (c) => c.json({ b: 2 }));
  `;
  const clashes = shadowedRoutes(fixture);
  assertEquals(clashes.length, 1, `expected one clash, got ${JSON.stringify(clashes)}`);
  assertEquals(clashes[0]!.includes("GET /accuracy/outcomes"), true);
});

Deno.test("US-2954 AC4: two ROUTERS may share a path", () => {
  // The false positive the first run of this guard produced. help-center.ts
  // really does declare three Hono instances and register GET "/" on more than
  // one; they are mounted at different prefixes, so nothing is shadowed. A
  // guard that cannot tell them apart reports six defects that do not exist,
  // and the cost of that is not the six - it is that the next real one is read
  // as more noise.
  const fixture = `
    export const helpPublicRoutes = new Hono();
    export const helpAdminRoutes = new Hono();
    helpPublicRoutes.get("/", async (c) => c.json({}));
    helpAdminRoutes.get("/", async (c) => c.json({}));
    helpPublicRoutes.get("/search", async (c) => c.json({}));
    helpAdminRoutes.get("/search", async (c) => c.json({}));
  `;
  assertEquals(shadowedRoutes(fixture), []);
});

Deno.test("US-2954 AC4: a path named only in a comment is not a duplicate", () => {
  // The complement, and the reason the stripper exists. Without it the fix for
  // this very story would fail its own guard, because the surviving handler is
  // preceded by a comment naming its path.
  const fixture = `
    const r = new Hono();
    // GET /accuracy/outcomes — post-sale feedback per category.
    /* r.get("/accuracy/outcomes", old) */
    r.get("/accuracy/outcomes", async (c) => c.json({}));
  `;
  assertEquals(shadowedRoutes(fixture), []);
});

Deno.test("US-2954 AC3: no route file shadows one of its own routes", async () => {
  const offenders: string[] = [];
  for (const name of await routeFiles()) {
    const src = await Deno.readTextFile(new URL(name, ROUTES_DIR));
    for (const clash of shadowedRoutes(src)) offenders.push(`${name}: ${clash}`);
  }
  assertEquals(
    offenders,
    [],
    "a route is registered twice in one file and the second is unreachable:\n" +
      offenders.join("\n"),
  );
});
