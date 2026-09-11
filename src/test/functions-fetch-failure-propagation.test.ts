// US-3383: every network read under functions/ either propagates its failure or
// carries a named, dated exemption.
//
// WHY THIS FILE EXISTS, in one sentence: src/test/sitemap-upstream-failure.test.ts
// asserts `expect(src).toMatch(/throw new UpstreamUnavailable/)` against the WHOLE
// of functions/_shared/sitemap.ts, one helper in that file contains the string, so
// the file passes whatever the sibling helper 28 lines above it does. Its own
// comment says it guards against "the kind that gets fixed in one file and left in
// ten". It was fixed in one function and left in another, in the same file.
//
// The five regex assertions in that file are NOT replaced. A regex over a whole
// file can only answer "does this string appear somewhere"; this guard answers
// "which call site, and does ITS enclosing function propagate". Different
// questions, and the older file still pins the specific US-2097 wording. What
// this supplements is stated per-case at the bottom of this header:
//
//   sitemap-upstream-failure.test.ts:23-30  "fetchEdgeJson THROWS"
//       -> supplemented by CANARY_PROPAGATING below, which names the HOLDER
//          (fetchEdgeJson) rather than the file, so fetchManifest can no longer
//          satisfy it by proximity.
//   sitemap-upstream-failure.test.ts:47-63  "every sub-sitemap route is guarded"
//       -> supplemented by the whole-corpus sweep here, which covers every
//          functions/ file rather than the sitemap-*.xml.ts glob.
//   sitemap-upstream-failure.test.ts:34-37 / 39-43 / 65-72 are untouched: they
//       pin 404-is-a-real-answer and the two index/image routes, which are
//       statements about specific code this sweep deliberately does not make.
//
// HOW IT WORKS. The subject is derived from the filesystem, never from a line
// number or a string anybody typed today:
//   1. walk functions/**/*.ts
//   2. blank out comments, string bodies, template chunks and regex bodies, so a
//      JSDoc block that MENTIONS UpstreamUnavailable cannot make the function
//      below it look guarded (that exact confusion is one blank line away in
//      sitemap.ts, where fetchEdgeJson's docstring sits inside fetchManifest's
//      region)
//   3. find every `fetch(` and `ASSETS.fetch(` that survives
//   4. attribute each to its enclosing module-level declaration
//   5. classify that declaration: it PROPAGATES when it throws
//      UpstreamUnavailable, answers 503, or calls a helper that answers 503,
//      AND every catch block in it does one of those three. Anything else
//      SWALLOWS.
//
// Point 5's third clause is not slack. functions/_shared/spa-shell.ts answers
// `return shellUnavailable("status 500")`, with the literal 503 one declaration
// away, and an earlier draft of this guard called that a swallow. A guard that
// reports a defect that is not there is spent as fast as one that misses a
// defect that is. So the helper names are resolved from the corpus, and the
// self-check below feeds the parser a helper that answers 200 to prove the
// resolver is not crediting delegation itself.
//
// A swallow is not automatically a bug. The badge and og image proxies degrade to
// a 1x1 PNG on purpose, and that is better than a broken image. What is a bug is a
// swallow nobody decided on. So each one needs a row in EXEMPTIONS with a date and
// a reason, and, modelled on `knownNoise` in scripts/check-ui-antipatterns.mjs, an
// entry that stops matching a live swallowing site FAILS. The ledger can only
// shrink.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const FUNCTIONS = join(ROOT, "functions");

// ---------------------------------------------------------------------------
// 1. Blank comments and literal bodies, preserving offsets and line numbers.
// ---------------------------------------------------------------------------

/**
 * Returns `src` with comment text, string bodies, template-literal chunks and
 * regex bodies replaced by spaces. Length, newlines and CR bytes are preserved,
 * so line numbers survive and a CRLF file behaves identically to an LF one.
 *
 * `${...}` substitutions inside a template literal are LEFT ALONE, because they
 * are code: `${edgeApi(env)}` has to stay visible to the site scan.
 */
export function blankCommentsAndLiterals(src: string): string {
  const out = src.split("");
  const n = src.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
    }
  };
  // Characters after which a `/` starts a regex literal rather than a division.
  const REGEX_PREV = new Set([
    "", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-",
    "*", "%", "~", "^", "<", ">", "\n",
  ]);
  let i = 0;
  let prev = "";
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && c2 === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      blank(i, Math.min(j + 2, n));
      i = Math.min(j + 2, n);
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === c || src[j] === "\n") break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      prev = c;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          blank(j, j + 2);
          j += 2;
          continue;
        }
        if (src[j] === "`") break;
        if (src[j] === "$" && src[j + 1] === "{") {
          let depth = 1;
          let k = j + 2;
          while (k < n && depth > 0) {
            if (src[k] === "{") depth++;
            else if (src[k] === "}") depth--;
            k++;
          }
          j = k;
          continue;
        }
        if (out[j] !== "\n" && out[j] !== "\r") out[j] = " ";
        j++;
      }
      i = j + 1;
      prev = "`";
      continue;
    }
    if (c === "/" && REGEX_PREV.has(prev)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        blank(i + 1, j);
        i = j + 1;
        prev = "/";
        continue;
      }
    }
    if (c === "\n") prev = "\n";
    else if (!/\s/.test(c as string)) prev = c as string;
    i++;
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// 2. Derive the corpus.
// ---------------------------------------------------------------------------

function listFunctionSources(dir = FUNCTIONS, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listFunctionSources(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const rel = (abs: string) => abs.slice(ROOT.length + 1).replace(/\\/g, "/");

// A module-level declaration. These files are Prettier-formatted, so every
// top-level declaration starts at column 0 and nothing else does.
const DECL =
  /^(export\s+)?(default\s+)?(async\s+)?(function|const|let|var|class|interface|type|enum|import)\b/;

const TYPE_DECL = /^(export\s+)?(declare\s+)?(interface|type)\b/;

/** Anything that turns a failure into a status the caller can see, in place. */
const INLINE_SIGNAL = /throw\s+new\s+UpstreamUnavailable|\b503\b/;

/**
 * The region reads the RESPONSE, not just the exception.
 *
 * This clause exists because of a measurement, not a hunch. Run against
 * `git show HEAD:functions/_shared/spa-shell.ts` on 2026-09-11, the first draft
 * of this guard said PROPAGATE: the function carried `status: 503` for the
 * missing-ASSETS-binding case and had no catch block to fault. It also did
 * `const shell = await env.ASSETS.fetch(...)` and went straight to
 * `shell.text()`, so a 500 from the asset server was served to a shopper on
 * /login as a 200 with the full app security headers (US-3384). A non-2xx
 * Response is not an exception, so "has a 503 somewhere and never swallows a
 * throw" is only half the property. The other half is that something looked at
 * `.ok` or `.status`.
 */
const RESPONSE_CHECKED = /\.\s*(ok|status)\b/;

export interface FetchSite {
  file: string;
  line: number;
  holder: string;
  isAssets: boolean;
  source: string;
  propagates: boolean;
  signal: boolean;
  swallowingCatches: number;
}

function catchBlocks(body: string): string[] {
  const out: string[] = [];
  const re = /\bcatch\b\s*(\([^)]*\))?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < body.length && depth > 0) {
      if (body[i] === "{") depth++;
      else if (body[i] === "}") depth--;
      i++;
    }
    out.push(body.slice(m.index, i));
  }
  return out;
}

/**
 * Split a blanked source into its module-level declaration regions.
 * These files are Prettier-formatted, so every top-level declaration starts at
 * column 0 and a region runs to the next one.
 */
function regions(lines: string[]): Array<{ name: string; header: string; body: string }> {
  const declLines: number[] = [];
  lines.forEach((l, i) => {
    if (DECL.test(l)) declLines.push(i);
  });
  return declLines.map((start, k) => {
    const end = declLines[k + 1] ?? lines.length;
    const header = (lines[start] ?? "").trim();
    return {
      name:
        /(?:function|const|let|var|class)\s+([\w$]+)/.exec(header)?.[1] ??
        header.slice(0, 60),
      header,
      body: lines.slice(start, end).join("\n"),
    };
  });
}

/**
 * Names of helpers, anywhere under functions/, whose body emits a 503.
 *
 * Without this, a function that answers `return shellUnavailable("status 500")`
 * reads as a swallow purely because the literal 503 lives one declaration away.
 * That is a guard reporting a defect that is not there, which costs exactly as
 * much trust as a guard missing one that is. Resolved across the whole corpus
 * rather than per file, because `upstreamUnavailableResponse` is defined in
 * _shared/blog-render.ts and called from eleven route files.
 */
function resolve503Helpers(): Set<string> {
  const names = new Set<string>();
  for (const abs of listFunctionSources()) {
    const lines = blankCommentsAndLiterals(readFileSync(abs, "utf8")).split(/\r?\n/);
    for (const r of regions(lines)) {
      if (TYPE_DECL.test(r.header)) continue;
      if (/\b503\b/.test(r.body)) names.add(r.name);
    }
  }
  return names;
}

let helper503Cache: Set<string> | null = null;
function helpers503(): Set<string> {
  helper503Cache ??= resolve503Helpers();
  return helper503Cache;
}

/** True when `text` calls a helper that answers 503. */
function callsA503Helper(text: string, helpers: ReadonlySet<string>): boolean {
  for (const name of helpers) {
    if (new RegExp(`\\b${name}\\s*\\(`).test(text)) return true;
  }
  return false;
}

export function analyseSource(
  relPath: string,
  raw: string,
  helpers: ReadonlySet<string> = new Set(),
): FetchSite[] {
  const code = blankCommentsAndLiterals(raw);
  const lines = code.split(/\r?\n/);
  const rawLines = raw.split(/\r?\n/);
  const declLines: number[] = [];
  lines.forEach((l, i) => {
    if (DECL.test(l)) declLines.push(i);
  });
  // Helpers defined in THIS source count too, so a fixture is self-contained.
  const local = new Set(helpers);
  for (const r of regions(lines)) {
    if (!TYPE_DECL.test(r.header) && /\b503\b/.test(r.body)) local.add(r.name);
  }

  const sites: FetchSite[] = [];
  lines.forEach((line, idx) => {
    const re = /(?:^|[^\w.$])((?:[\w.$]+\.)?fetch)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      // Locate the enclosing module-level declaration.
      let start = 0;
      for (const d of declLines) {
        if (d <= idx) start = d;
        else break;
      }
      let end = lines.length;
      for (const d of declLines) {
        if (d > idx) {
          end = d;
          break;
        }
      }
      const header = (lines[start] ?? "").trim();
      // `ASSETS?: { fetch(...): Promise<Response> }` in an interface is a type,
      // not a call. A type declaration cannot reach the network.
      if (TYPE_DECL.test(header)) continue;
      const holder =
        /(?:function|const|let|var|class)\s+([\w$]+)/.exec(header)?.[1] ??
        header.slice(0, 60);
      const body = lines.slice(start, end).join("\n");
      const signal =
        (INLINE_SIGNAL.test(body) || callsA503Helper(body, local)) &&
        RESPONSE_CHECKED.test(body);
      const swallowing = catchBlocks(body).filter(
        (b) =>
          !/\bthrow\b/.test(b) && !/\b503\b/.test(b) && !callsA503Helper(b, local),
      );
      sites.push({
        file: relPath,
        line: idx + 1,
        holder,
        isAssets: /ASSETS\s*\.\s*fetch/.test(m[1] ?? ""),
        source: (rawLines[idx] ?? "").trim(),
        signal,
        swallowingCatches: swallowing.length,
        propagates: signal && swallowing.length === 0,
      });
    }
  });
  return sites;
}

function allFetchSites(): FetchSite[] {
  const helpers = helpers503();
  return listFunctionSources().flatMap((abs) =>
    analyseSource(rel(abs), readFileSync(abs, "utf8"), helpers),
  );
}

// ---------------------------------------------------------------------------
// 3. The exemption ledger. Shrink-only.
// ---------------------------------------------------------------------------
//
// A row here says: this network read swallows its failure ON PURPOSE, somebody
// decided that on this date, and here is the reason. Keyed on file + the name of
// the enclosing declaration, never a line number, because three agents are
// editing this tree at once and a line number would be noise by tomorrow.
//
// The rule that makes it a ratchet, copied from knownNoise in
// scripts/check-ui-antipatterns.mjs: an entry that matches NO live swallowing
// site fails the suite. Fix the swallow, delete the row. There is no way to add
// slack to this list without also adding a live swallowing call site.

interface Exemption {
  file: string;
  holder: string;
  since: string;
  why: string;
}

const EXEMPTIONS: readonly Exemption[] = [
  {
    file: "functions/badge/achievement/[key].ts",
    holder: "onRequestGet",
    since: "2026-09-11",
    why:
      "Image proxy. An unreachable edge serves the transparent 1x1 at max-age=300 " +
      "rather than a broken image in somebody else's page. The file carries the " +
      "US-2620 'this route's GET can never 404' marker, which is the same decision " +
      "stated from the HEAD side.",
  },
  {
    file: "functions/badge/cert/[id].ts",
    holder: "onRequestGet",
    since: "2026-09-11",
    why: "Image proxy, same contract as badge/achievement. Fallback PNG, 300s TTL.",
  },
  {
    file: "functions/badge/level/[level].ts",
    holder: "onRequestGet",
    since: "2026-09-11",
    why: "Image proxy, same contract as badge/achievement. Fallback PNG, 300s TTL.",
  },
  {
    file: "functions/badge/verified/[handle].ts",
    holder: "onRequestGet",
    since: "2026-09-11",
    why: "Image proxy, same contract as badge/achievement. Fallback PNG, 300s TTL.",
  },
  {
    file: "functions/cert-photo/[id]/[n].ts",
    holder: "onRequestGet",
    since: "2026-09-11",
    why:
      "Image proxy for the certificate gallery. Degrades to the placeholder image; " +
      "the certificate PAGE that embeds it is the surface that must 503, and it " +
      "does (functions/cert/[id].ts propagates).",
  },
  {
    file: "functions/og/cert/[id].ts",
    holder: "onRequestGet",
    since: "2026-09-11",
    why:
      "Open Graph card. A social scraper that gets a 5xx caches NO image at all " +
      "for the life of the share; the branded fallback at a 300s TTL is the " +
      "deliberate trade (see _shared/og-template.ts brandedFallbackResponse).",
  },
  {
    file: "functions/slab/cert/[id].ts",
    holder: "onRequestGet",
    since: "2026-09-11",
    why:
      "Shareable graded-photo proxy, embedded in marketplace listings. Same trade " +
      "as og/cert: a fallback PNG beats a broken image inside an eBay listing.",
  },
  {
    file: "functions/help/feedback.ts",
    holder: "onRequestPost",
    since: "2026-09-11",
    why:
      "Best-effort vote forward, and quiet to the READER on purpose: an error on " +
      "a page somebody was only trying to be helpful on is worse than a lost " +
      "datum. Not quiet to us, which is the part that matters here - US-3384 made " +
      "it read res.ok, log the rejection, and drop ?thanks=1 when the edge said no.",
  },
  {
    file: "functions/_shared/help-analytics.ts",
    holder: "countHelpArticleView",
    since: "2026-09-11",
    why:
      "Fire-and-forget view count, run inside waitUntil AFTER the page has been " +
      "delivered. A throw here would be a Function error on an already-sent " +
      "response, which is strictly worse than an undercount.",
  },
  {
    file: "functions/_shared/og-template.ts",
    holder: "brandedFallbackResponse",
    since: "2026-09-11",
    why:
      "This IS the fallback path. It fetches the static brand PNG and falls " +
      "through to an embedded 1x1 when even that is unreachable. Propagating from " +
      "here would mean the fallback has a fallback that fails.",
  },
  {
    file: "functions/_shared/render-via-edge.ts",
    holder: "renderViaEdge",
    since: "2026-09-11",
    why:
      "Card renderer for the OG/badge/slab surfaces above. Returns " +
      "brandedFallbackResponse on every failure branch by design (US-2612), and " +
      "buffers the body first so a mid-stream failure cannot leave as a 200 " +
      "(US-2620).",
  },
  {
    file: "functions/_shared/blog-render.ts",
    holder: "renderHydratableSsrResponse",
    since: "2026-09-11",
    why:
      "env.ASSETS.fetch of the built SPA shell, used to MERGE the SSR document " +
      "into the app shell. The catch falls back to serving the same document " +
      "standalone, so the content and status are unchanged and only hydration is " +
      "lost. Not a silent content gap, which is the class this guard is about.",
  },
];

// ---------------------------------------------------------------------------
// 4. Canaries. A corpus floor on its own is not evidence: 85 of 128 still looks
//    like plenty (partial-index-conflict_test.ts, 2026-09-11).
// ---------------------------------------------------------------------------

const CANARY_FILES = [
  "functions/_shared/sitemap.ts",
  "functions/_shared/blog-render.ts",
  "functions/_shared/spa-shell.ts",
  "functions/_shared/render-via-edge.ts",
  "functions/llms.txt.ts",
  "functions/llms-full.txt.ts",
  "functions/badge/cert/[id].ts",
  "functions/help/feedback.ts",
];

// Holders that must stay on the propagating side. These are the ones whose
// regression is invisible: each serves a 200 that a crawler believes.
const CANARY_PROPAGATING: ReadonlyArray<[string, string]> = [
  ["functions/_shared/sitemap.ts", "fetchEdgeJson"],
  ["functions/_shared/blog-render.ts", "fetchJson"],
  ["functions/llms-full.txt.ts", "onRequestGet"],
  ["functions/_shared/spa-shell.ts", "serveSpaShell"],
];

// ---------------------------------------------------------------------------
// 5. Self-check. Point the parser at code known to be bad and watch it fire
//    before believing a clean result.
//
//    The scope fence on this story forbids editing functions/, so the sabotage
//    is a set of in-memory fixtures fed to the same analyseSource() the corpus
//    sweep uses, rather than a mutation of a real file. Each fixture asserts
//    the mutation LANDED (the blanker actually changed the text, the site was
//    actually found) before asserting the verdict.
// ---------------------------------------------------------------------------

// VERBATIM from `git show HEAD:functions/_shared/sitemap.ts`, the shape this
// story was filed against. src/test/sitemap-upstream-failure.test.ts passed over
// this, because the string it greps for lives in the NEXT function down.
// Measured 2026-09-11: manifest 500 -> staticUrls() returned 1 of 275 routes,
// served 200, cached an hour.
const FIXTURE_SWALLOW = [
  "async function fetchManifest(env: PagesEnv): Promise<SeoManifest | null> {",
  "  try {",
  "    const res = await fetch(`${siteUrl(env)}/seo-manifest.json`, {",
  "      signal: AbortSignal.timeout(8_000),",
  "      cf: { cacheTtl: 300, cacheEverything: true },",
  "    } as RequestInit);",
  "    if (!res.ok) return null;",
  "    return (await res.json()) as SeoManifest;",
  "  } catch {",
  "    return null;",
  "  }",
  "}",
  "",
].join("\n");

// VERBATIM from `git show HEAD:functions/llms.txt.ts`. Same shape, different
// file, which is the point: the manifest read here fell back to the 8-entry
// FALLBACK_ROUTES in place of the 276-route registry, and answered 200.
const FIXTURE_SWALLOW_LLMS = [
  "async function fetchJsonSafe<T>(url: string, init?: RequestInit): Promise<T | null> {",
  "  try {",
  "    const res = await fetch(url, {",
  "      signal: AbortSignal.timeout(8_000),",
  "      cf: { cacheTtl: 300, cacheEverything: true },",
  "      ...init,",
  "    } as RequestInit);",
  "    if (!res.ok) return null;",
  "    return (await res.json()) as T;",
  "  } catch {",
  "    return null;",
  "  }",
  "}",
].join("\n");

const FIXTURE_PROPAGATE = [
  "async function readIt(env: Env): Promise<T | null> {",
  "  try {",
  "    const res = await fetch(`${api(env)}/thing`);",
  "    if (res.status === 404) return null;",
  "    if (!res.ok) throw new UpstreamUnavailable(`status ${res.status}`);",
  "    return await res.json();",
  "  } catch (e) {",
  "    throw new UpstreamUnavailable('network');",
  "  }",
  "}",
].join("\n");

// The exact confusion that let the live defect through: a docstring that names
// UpstreamUnavailable sitting immediately ABOVE the next declaration, so it
// lands inside the PREVIOUS declaration's region.
const FIXTURE_COMMENT_ONLY = [
  "async function swallower(env: Env) {",
  "  try {",
  "    const res = await fetch('https://example.test/a');",
  "    if (!res.ok) return null;",
  "    return await res.json();",
  "  } catch {",
  "    return null;",
  "  }",
  "}",
  "",
  "/**",
  " * This one THROWS: throw new UpstreamUnavailable and a 503, in prose.",
  " */",
  "async function thrower(env: Env) {",
  "  const res = await fetch('https://example.test/b');",
  "  if (!res.ok) throw new UpstreamUnavailable('x');",
  "  return await res.json();",
  "}",
].join("\n");

// A URL in a string, on the same line as the call, plus a regex literal holding
// both quote characters. A naive `//` stripper eats the rest of the line here
// and the call site vanishes with no error and no warning.
const FIXTURE_TRICKY = [
  "const RE = /<meta\\s+name=[\"']robots[\"'][^>]*>/i;",
  "async function grab(env: Env) {",
  "  const base = \"https://gradethread.com\"; const res = await fetch(base + '/x');",
  "  if (!res.ok) return null;",
  "  return res;",
  "}",
].join("\n");

// A failure answered by a NAMED helper one declaration away. functions/_shared/
// spa-shell.ts is exactly this shape, and an earlier draft of this guard called
// it a swallow purely because the literal 503 was not in the same region.
const FIXTURE_DELEGATED_503 = [
  "function shellUnavailable(reason: string): Response {",
  "  return new Response('nope', { status: 503 });",
  "}",
  "",
  "export async function serve(request: Request, env: Env) {",
  "  let shell: Response;",
  "  try {",
  "    shell = await env.ASSETS.fetch(`${origin}/`);",
  "  } catch (e) {",
  "    return shellUnavailable('fetch threw');",
  "  }",
  "  if (!shell.ok) return shellUnavailable(`status ${shell.status}`);",
  "  return new Response(await shell.text(), { status: 200 });",
  "}",
].join("\n");

// The same shape with a helper that answers 200. The delegation resolver must
// NOT treat "calls a named helper" as "handles the failure" on its own.
const FIXTURE_DELEGATED_200 = [
  "function fallbackImage(): Response {",
  "  return new Response(BYTES, { status: 200 });",
  "}",
  "",
  "export async function serve(env: Env) {",
  "  try {",
  "    const upstream = await fetch(url);",
  "    if (!upstream.ok) return fallbackImage();",
  "    return new Response(upstream.body, { status: 200 });",
  "  } catch {",
  "    return fallbackImage();",
  "  }",
  "}",
].join("\n");

// VERBATIM from `git show HEAD:functions/_shared/spa-shell.ts`. The FIRST draft
// of this guard called this PROPAGATE, because of the 503 on the first line of
// the body. It is not: a 500 from the asset server arrives as a resolved
// Response, and this function never looks at it.
const FIXTURE_UNCHECKED_RESPONSE = [
  "export async function serveSpaShell(",
  "  request: Request,",
  "  env: PagesEnv,",
  "): Promise<Response> {",
  "  const origin = new URL(request.url).origin;",
  "  if (!env.ASSETS) {",
  "    return new Response('Service unavailable', { status: 503 });",
  "  }",
  "  const shell = await env.ASSETS.fetch(`${origin}/`);",
  "  let html = await shell.text();",
  "  html = html.replace(/<meta\\s+name=[\"']robots[\"'][^>]*>/i, '<meta>');",
  "  return new Response(html, { status: 200 });",
  "}",
].join("\n");

describe("US-3383 self-check: the parser is armed", () => {
  it("blanks comment text (and says so by changing the bytes)", () => {
    const raw = "const a = 1; // throw new UpstreamUnavailable\n";
    const blanked = blankCommentsAndLiterals(raw);
    expect(blanked).not.toBe(raw);
    expect(blanked).not.toMatch(/UpstreamUnavailable/);
    expect(blanked.length).toBe(raw.length);
  });

  it("blanks a comment identically under CRLF (this tree mixes both)", () => {
    const lf = "const a = 1; // throw new UpstreamUnavailable\nconst b = 2;\n";
    const crlf = lf.replace(/\n/g, "\r\n");
    const blanked = blankCommentsAndLiterals(crlf);
    expect(blanked).not.toBe(crlf);
    expect(blanked).not.toMatch(/UpstreamUnavailable/);
    // Offsets and line count preserved, or every reported line number is wrong.
    expect(blanked.length).toBe(crlf.length);
    expect(blanked.split("\r\n").length).toBe(crlf.split("\r\n").length);
  });

  it("calls the real pre-fix sitemap fetchManifest a SWALLOW", () => {
    const sites = analyseSource("fixture/swallow.ts", FIXTURE_SWALLOW);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.holder).toBe("fetchManifest");
    expect(
      sites[0]?.propagates,
      "this is verbatim HEAD, and the guard that was supposed to hold it was " +
        "green over it for the whole time it was live",
    ).toBe(false);
  });

  it("calls the real pre-fix llms.txt fetchJsonSafe a SWALLOW", () => {
    const sites = analyseSource("fixture/swallow-llms.ts", FIXTURE_SWALLOW_LLMS);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.holder).toBe("fetchJsonSafe");
    expect(sites[0]?.propagates).toBe(false);
  });

  it("calls a propagating helper a PROPAGATE, 404-returns-null and all", () => {
    const sites = analyseSource("fixture/propagate.ts", FIXTURE_PROPAGATE);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.propagates).toBe(true);
  });

  it("a neighbouring docstring cannot launder a swallowing helper", () => {
    // Without the blanker, `swallower`'s region swallows up the JSDoc written
    // for `thrower` and reads as guarded. This is the live defect's mechanism.
    const sites = analyseSource("fixture/comment.ts", FIXTURE_COMMENT_ONLY);
    expect(sites.map((s) => s.holder)).toEqual(["swallower", "thrower"]);
    expect(sites[0]?.propagates, "prose is not a guard").toBe(false);
    expect(sites[1]?.propagates).toBe(true);
  });

  it("still finds a call site hiding behind a URL string and a regex literal", () => {
    const sites = analyseSource("fixture/tricky.ts", FIXTURE_TRICKY);
    expect(
      sites.map((s) => s.holder),
      "the // inside https:// swallowed the rest of the line",
    ).toEqual(["grab"]);
    expect(sites[0]?.propagates).toBe(false);
  });

  it("a 503 elsewhere in the body does not cover an UNREAD Response", () => {
    const sites = analyseSource("fixture/unchecked.ts", FIXTURE_UNCHECKED_RESPONSE);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.holder).toBe("serveSpaShell");
    expect(
      sites[0]?.propagates,
      "a non-2xx Response is not an exception. Nothing here reads .ok or " +
        "        .status, so the asset server's 500 leaves as a 200.",
    ).toBe(false);
  });

  it("credits a 503 answered by a named helper one declaration away", () => {
    const sites = analyseSource("fixture/delegated-503.ts", FIXTURE_DELEGATED_503);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.isAssets, "the ASSETS binding is in scope too").toBe(true);
    expect(sites[0]?.propagates).toBe(true);
  });

  it("does NOT credit a named helper that answers 200", () => {
    const sites = analyseSource("fixture/delegated-200.ts", FIXTURE_DELEGATED_200);
    expect(sites).toHaveLength(1);
    expect(
      sites[0]?.propagates,
      "delegation is not the signal. Answering 503 is.",
    ).toBe(false);
  });

  it("ignores the fetch SIGNATURE on an interface (a type cannot call out)", () => {
    const iface = [
      "export interface PagesEnv {",
      "  ASSETS?: { fetch(input: string): Promise<Response> };",
      "}",
    ].join("\n");
    expect(analyseSource("fixture/iface.ts", iface)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. The corpus sweep.
// ---------------------------------------------------------------------------

describe("US-3383 AC1: every network read under functions/ is accounted for", () => {
  const sites = allFetchSites();

  it("finds the whole corpus, not a sample", () => {
    // Floor, then canaries, because a floor alone reads as plenty right up to
    // the moment half the tree stops being scanned. Measured 2026-09-11: 18
    // sites, 6 propagating and 12 exempted. The floor sits two under, so it
    // catches the sweep breaking without firing on a route being deleted.
    expect(sites.length).toBeGreaterThanOrEqual(16);
    const files = new Set(sites.map((s) => s.file));
    const missing = CANARY_FILES.filter((f) => !files.has(f));
    expect(
      missing,
      "these files hold a known network read and the sweep did not see it, " +
        "which means the sweep is broken rather than the tree being clean",
    ).toEqual([]);
    // At least one ASSETS.fetch (the SPA shell binding) must be in scope.
    expect(sites.some((s) => s.isAssets)).toBe(true);
  });

  it("the holders that must never silently degrade still propagate", () => {
    const broken = CANARY_PROPAGATING.filter(
      ([file, holder]) =>
        !sites.some((s) => s.file === file && s.holder === holder && s.propagates),
    );
    expect(
      broken.map(([f, h]) => `${f} ${h}()`),
      "each of these serves a 200 a crawler believes. sitemap.ts fetchEdgeJson " +
        "is named HERE rather than by a file-wide regex precisely because a " +
        "file-wide regex is what let its sibling rot.",
    ).toEqual([]);
  });

  it("every swallowing call site is propagating or exempted", () => {
    const swallowing = sites.filter((s) => !s.propagates);
    const unexplained = swallowing.filter(
      (s) => !EXEMPTIONS.some((e) => e.file === s.file && e.holder === s.holder),
    );
    expect(
      unexplained.map(
        (s) => `${s.file}:${s.line} ${s.holder}() -- ${s.source.slice(0, 72)}`,
      ),
      "these turn an unreachable upstream into a 200 that looks like a real, " +
        "smaller answer. Either propagate the failure (throw UpstreamUnavailable " +
        "or answer 503) or add a dated row to EXEMPTIONS saying why a quiet " +
        "degrade is the right call here.",
    ).toEqual([]);
  });
});

describe("US-3383 AC2: the exemption ledger can only shrink", () => {
  const sites = allFetchSites();

  it("every entry still matches a live swallowing call site", () => {
    const stale = EXEMPTIONS.filter(
      (e) =>
        !sites.some(
          (s) => s.file === e.file && s.holder === e.holder && !s.propagates,
        ),
    );
    expect(
      stale.map((e) => `${e.file} ${e.holder}() (since ${e.since})`),
      "an exemption that matches nothing is either a fixed call site whose row " +
        "should be deleted, or a rename that moved the swallow somewhere this " +
        "ledger is no longer looking. Both need a human; neither may pass.",
    ).toEqual([]);
  });

  it("every entry is dated and carries a reason, not a shrug", () => {
    for (const e of EXEMPTIONS) {
      expect(e.since, `${e.file} ${e.holder}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.why.length, `${e.file} ${e.holder}`).toBeGreaterThan(60);
    }
  });

  it("has no duplicate rows (two rows would let one go stale unnoticed)", () => {
    const keys = EXEMPTIONS.map((e) => `${e.file}::${e.holder}`);
    expect(keys.length).toBe(new Set(keys).size);
  });
});
