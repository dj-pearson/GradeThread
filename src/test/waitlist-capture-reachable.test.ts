// US-2449: if the waitlist gate can be CLOSED, there must be a way IN.
//
// THE BUG THIS EXISTS FOR. Every piece of the staged-launch waitlist shipped
// and worked: the anonymous capture route (/api/waitlist), the per-account gate
// (access-gate.ts), the operator queue (/admin/waitlist) with its nav entry, the
// pending page, and one feature_flags row (waitlist_gating) that turns the whole
// thing on. Every piece except the form. src/components/waitlist-form.tsx had
// ZERO importers — the only other mention of it in the repo was a COMMENT in
// newsletter-signup.tsx saying it mirrored the same prerender-safe pattern.
//
// So flipping one flag row would have gated every non-staff account while the
// only public way to create the row that ungates you was a component nothing
// rendered. And the half nobody would have noticed is the operator's: they open
// /admin/waitlist and see a queue that can only ever shrink, which looks exactly
// like a quiet launch rather than a broken one.
//
// WHY A SOURCE SCAN. An orphaned component is invisible to every runtime check
// there is. It compiles, it type-checks, it lints, and its own unit tests pass —
// tests import it directly, which is precisely the reachability a caller-less
// module fakes. Only the IMPORT GRAPH can tell the difference, which is the
// lesson US-1995 wrote down after audit-unwired-exports.mjs first MISSED
// title-sync.ts by counting per-function references instead of imports.
//
// The importers are DISCOVERED, not listed. A future refactor that unwires the
// form again fails here rather than shipping a lockout.
//
// DECIDED 2026-09-02 (US-9211 AC4), so nobody re-opens this from scratch: the
// gate is confirmed OFF in production -- GET /api/waitlist/status answered
// {"gatingActive": false} -- and the form is KEPT anyway. Dj's call. A capability
// that renders nothing costs nothing, and removing the form alone would put the
// lockout above back one flag flip away. If the staged-launch gate is ever
// retired, retire it whole: the flag row, the access-gate branch, the operator
// queue, the pending page, the hook, the form, and this guard with them.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";

const ROOT = process.cwd();
const SRC = resolve(ROOT, "src");
const EDGE = resolve(ROOT, "services/edge-functions/src");
const read = (p: string) => readFileSync(p, "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "components/ui") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const ALL = walk(SRC);

/** Production source only: no test files, no the-module-importing-itself. */
function productionImportersOf(modulePath: string, aliases: string[]): string[] {
  const self = resolve(SRC, modulePath);
  const hits: string[] = [];
  for (const file of ALL) {
    if (file === self) continue;
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (/\.test\.tsx?$/.test(rel) || rel.includes("/__tests__/") || rel.includes("/test/")) continue;
    const src = read(file);
    // Strip comments first — the reason this story was hard to see is that the
    // ONLY other repo mention of WaitlistForm was a comment, and a naive grep
    // reads that as a caller.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    if (aliases.some((a) => new RegExp(`from\\s+["']${a}["']`).test(code) ||
      new RegExp(`import\\(\\s*["']${a}["']\\s*\\)`).test(code))) {
      hits.push(rel);
    }
  }
  return hits;
}

describe("US-2449: the waitlist gate cannot be closed with no way in", () => {
  it("the public capture form is imported by production code, not only by tests", () => {
    const importers = productionImportersOf("components/waitlist-form.tsx", [
      "@/components/waitlist-form",
    ]);
    expect(
      importers,
      "WaitlistForm has no production importer. The waitlist_gating flag can " +
        "still be turned on, which would gate every non-staff account with no " +
        "public way to create an approved entry. Either render the form " +
        "somewhere reachable, or retire the whole feature together (route, " +
        "admin page, nav entry, edge-fetch branch and the flag row) per " +
        "US-2449 AC2 — do not leave the switch armed and the door welded.",
    ).not.toHaveLength(0);
  });

  it("the form is shown only while the gate is actually closed", () => {
    // US-1949 removed every public waitlist CTA because it read as vaporware
    // next to a live "Start Grading Free". Re-rendering it unconditionally
    // would reintroduce exactly that, so the condition is load-bearing.
    const importers = productionImportersOf("components/waitlist-form.tsx", [
      "@/components/waitlist-form",
    ]);
    for (const rel of importers) {
      const code = read(resolve(ROOT, rel));
      expect(
        code,
        `${rel} renders WaitlistForm but never reads the gate state. A ` +
          "waitlist offered while the product is open is the vaporware signal " +
          "US-1949 exists to remove — gate the render on useWaitlistGating().",
      ).toMatch(/useWaitlistGating/);
    }
  });

  it("the gate state has a public read, since the form renders on a page with no session", () => {
    const routeSrc = read(resolve(EDGE, "routes/waitlist.ts"));
    expect(routeSrc).toMatch(/waitlistRoutes\.get\(\s*"\/status"/);
    // authMiddleware must stay pinned to the EXACT /me path. Widening it to
    // /api/waitlist/* would 401 the status read on the landing page, and the
    // hook fails closed — so the form would silently stop rendering and the
    // lockout would be back with every test still green.
    const mainSrc = read(resolve(EDGE, "main.ts"));
    expect(mainSrc).toMatch(/app\.use\(\s*"\/api\/waitlist\/me"\s*,\s*authMiddleware\s*\)/);
    expect(mainSrc).not.toMatch(/app\.use\(\s*"\/api\/waitlist\/\*"\s*,\s*authMiddleware/);
  });

  it("an account gated after signup is put on the queue the page says it is on", () => {
    // Nothing else writes a waitlist_entries row: signup does not, and
    // handle_new_user does not. Without this the pending page tells someone
    // they are in a queue that has no record of them, and the operator has
    // nobody to approve.
    const pending = read(resolve(SRC, "pages/waitlist-pending.tsx"));
    expect(
      pending,
      "waitlist-pending.tsx must enrol the signed-in account via POST " +
        "/api/waitlist, or a gated user is invisible in /admin/waitlist.",
    ).toMatch(/edgeFetch\(\s*"\/api\/waitlist"/);
    expect(pending).toMatch(/method:\s*"POST"/);
  });

  it("every part of the feature is present, or the story's retire path was taken as a whole", () => {
    // AC2's failure mode is a HALF retirement: delete the form, keep the flag.
    // These stand or fall together.
    const parts = [
      resolve(SRC, "components/waitlist-form.tsx"),
      resolve(SRC, "pages/waitlist-pending.tsx"),
      resolve(EDGE, "routes/waitlist.ts"),
      resolve(EDGE, "routes/admin-waitlist.ts"),
      resolve(EDGE, "lib/access-gate.ts"),
    ];
    const present = parts.filter((p) => existsSync(p));
    expect(
      present.length === 0 || present.length === parts.length,
      "the waitlist feature is half-retired: " +
        parts.filter((p) => !existsSync(p)).map((p) => relative(ROOT, p)).join(", ") +
        " were removed while the rest survives. Retire it together (including " +
        "the waitlist_gating flag row) or keep it together — US-2449 AC2.",
    ).toBe(true);
  });
});
