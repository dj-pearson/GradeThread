// US-2620: every dynamic Pages route must be able to answer HEAD.
//
// THE DEFECT THIS PINS. Cloudflare Pages picks a route handler by method, so a
// module exporting only `onRequestGet` has nothing to answer HEAD with and
// Pages falls through to the 404 catch-all. Measured in production 2026-08-15:
// HEAD /sitemap.xml, /rss.xml, /llms.txt, /blog and /og/social/card all
// returned 404 while GET returned 200 — and seven image routes that already
// exported `onRequestHead` all returned 200, which is what proved the
// mechanism rather than the documentation.
//
// WHY A SOURCE SCAN AND NOT A REQUEST. There is no Pages runtime in this
// checkout, so the only thing assertable here is that every GET route declares
// a HEAD path. That is the property the fix delivers; whether Pages dispatches
// it is settled by the production probe above and by the seven routes that have
// worked this way for months.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

const FUNCTIONS = join(process.cwd(), "functions");

function moduleFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      // _shared holds helpers, not routes.
      if (e.name === "_shared") continue;
      out.push(...moduleFiles(p));
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

const rel = (p: string) => p.replace(process.cwd(), "").split(sep).join("/");

describe("US-2620: HEAD coverage across Pages Functions", () => {
  it("every module that handles GET also handles HEAD", () => {
    const offenders: string[] = [];
    for (const file of moduleFiles(FUNCTIONS)) {
      const src = readFileSync(file, "utf8");
      if (!/export const onRequestGet\b/.test(src)) continue;
      // `onRequest` (no method suffix) already covers every method.
      const catchAll = /export const onRequest\b(?!Get|Head|Post|Options|Put|Patch|Delete)/;
      if (catchAll.test(src)) continue;
      if (/export const onRequestHead\b/.test(src)) continue;
      offenders.push(rel(file));
    }
    expect(
      offenders,
      "these answer GET and 404 on HEAD, so a link checker or social validator " +
        "reports a live URL as missing. Add `export const onRequestHead = " +
        "headOf(onRequestGet);` with the helper from functions/_shared/head-of.ts.",
    ).toEqual([]);
  });

  it("HEAD is served by the shared helper, not by hand-written twins", () => {
    // The failure mode a per-file handler invites: a canned response that
    // answers 200 for a resource whose GET would 404. That is worse than the
    // 404 this replaced, because a validator then reports a dead URL as healthy.
    // So the helper is the only sanctioned mechanism, and a bespoke HEAD must
    // say why it is bespoke.
    const bespoke: string[] = [];
    for (const file of moduleFiles(FUNCTIONS)) {
      const src = readFileSync(file, "utf8");
      if (!/export const onRequestHead\b/.test(src)) continue;
      if (/export const onRequestHead\s*=\s*headOf\(/.test(src)) continue;
      // An explicit opt-out is allowed and must be argued in the file.
      if (/US-2620:\s*deliberately bespoke/.test(src)) continue;
      bespoke.push(rel(file));
    }
    expect(
      bespoke,
      "these write their own HEAD instead of headOf(onRequestGet), so they can " +
        "drift from the GET they claim to mirror — most dangerously by " +
        "answering 200 where the GET would 404. Convert them, or write " +
        "`US-2620: deliberately bespoke` in the file with the reason.",
    ).toEqual([]);
  });

  it("the helper copies the status through rather than assuming 200", () => {
    // The whole correctness argument rests on this line, so assert it directly:
    // a helper that hardcoded 200 would turn every 404 into a false healthy.
    const helper = readFileSync(join(FUNCTIONS, "_shared", "head-of.ts"), "utf8");
    expect(helper).toMatch(/status:\s*res\.status/);
    expect(helper).toMatch(/headers:\s*res\.headers/);
    expect(helper).toMatch(/new Response\(\s*null/);
  });
});
