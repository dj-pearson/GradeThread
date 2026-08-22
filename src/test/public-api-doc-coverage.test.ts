import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Every path the public API serves is either written up in docs/PUBLIC_API.md
// or named there as not yet written up.
//
// FOUND BY COMPARING THE DOC TO THE LIVE SPEC, 2026-08-22. The API serves 16
// paths. PUBLIC_API.md described four. The words "sandbox", "price-guide",
// "usage", "listings", "sales", "items" and "batch" appeared in it ZERO times —
// so a paying customer reading the documentation could not discover twelve of
// the sixteen endpoints they are entitled to.
//
// WHY THE EXISTING PARITY TEST DID NOT CATCH IT. api-v1-surface-parity.test.ts
// compares the OpenAPI SPEC to the ROUTES, and both are correct: 16 and 16, no
// drift, and the live spec matches the committed one exactly. The doc is a
// THIRD copy that nothing compared to either. That is the recurring shape in
// this repo — two artefacts held together while a third drifts beside them.
//
// THE BAR IS DELIBERATELY LOW: a path must be MENTIONED. Prose quality is not
// something a test can judge, and demanding a full section per path would have
// left this failing on arrival and then been switched off. Naming the gap is
// what turns twelve invisible endpoints into twelve known ones.

const ROOT = process.cwd();
const DOC = resolve(ROOT, "docs/PUBLIC_API.md");
const SPEC = resolve(ROOT, "services/edge-functions/src/lib/openapi-spec.ts");

/** Path literals declared in the spec builder, e.g. "/api/v1/grades/{id}". */
function specPaths(): string[] {
  const src = readFileSync(SPEC, "utf8");
  return [
    ...new Set(
      [...src.matchAll(/"(\/api\/v1\/[a-z0-9\-{}/]+)":\s*\{/gi)].map((m) => m[1]!),
    ),
  ].sort();
}

/** The doc writes them without the /api/v1 prefix, and with :id or {id}. */
function mentioned(doc: string, path: string): boolean {
  const stem = path.replace(/^\/api\/v1/, "");
  // Compare on the literal segments, so `{id}` and `:id` both count.
  const segments = stem.split("/").filter((s) => s && !/^[:{]/.test(s));
  const needle = `/${segments.join("/")}`;
  return doc.includes(needle);
}

describe("the public API doc covers what the API serves", () => {
  const paths = specPaths();
  const doc = readFileSync(DOC, "utf8");

  it("reads a real spec", () => {
    // Guards the guard: a renamed builder or a changed literal shape would
    // empty this and make every assertion below vacuously true.
    expect(paths.length).toBeGreaterThanOrEqual(12);
    expect(paths).toContain("/api/v1/grades");
  });

  it("names every served path somewhere", () => {
    const missing = paths.filter((p) => !mentioned(doc, p));
    expect(
      missing,
      `these paths are served and appear nowhere in docs/PUBLIC_API.md: ` +
        `${missing.join(", ")}. A customer cannot use an endpoint they cannot ` +
        `find. Write it up, or add it to the "Not yet written up" table.`,
    ).toEqual([]);
  });

  it("points at the machine-readable spec, which is complete and public", () => {
    // The prose will always lag. The spec does not, it is served without a key,
    // and linking it is what makes the lag survivable rather than silent.
    expect(doc).toContain("https://functions.gradethread.com/api/v1/openapi.json");
  });

  it("does not document a path the API does not serve", () => {
    // The other direction, and the more embarrassing one: an endpoint promised
    // in the docs that answers 404 is worse than one that is merely missing.
    const documented = [
      ...new Set(
        [...doc.matchAll(/`(?:GET|POST|PUT|PATCH|DELETE)\s+(\/[a-z0-9\-{}:/]+)`/gi)].map(
          (m) => m[1]!,
        ),
      ),
    ];
    const stems = new Set(
      paths.map((p) => p.replace(/^\/api\/v1/, "").replace(/\{[^}]+\}/g, "")),
    );
    const phantom = documented.filter(
      (d) => !stems.has(d.replace(/\{[^}]+\}|:[a-z]+/gi, "")),
    );
    expect(
      phantom,
      `documented but not served: ${phantom.join(", ")}`,
    ).toEqual([]);
  });
});
