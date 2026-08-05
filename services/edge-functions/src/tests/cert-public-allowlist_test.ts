// US-2400: the public certificate endpoint serves an EXPLICIT ALLOWLIST, and a
// field that is not in it is not "missing" — it is silently undefined on every
// surface that reads the endpoint.
//
// That is how the AI disclosure (US-2399) shipped half-broken. functions/cert/
// [id].ts and functions/embed/grade/[id].ts both get their certificate from
// GET /api/content/public/certificates/:id, whose select is CERT_REPORT_COLUMNS.
// human_reviewed was never in it, so `cert.human_reviewed === true` was always
// false there and both surfaces always printed the stricter AI-only wording —
// while the SPA certificate page, which reads the public_grade_reports VIEW
// directly, mounted over the SSR bytes and printed the human-finalized wording.
// Two provenance claims about one grade, in one page load.
//
// These are SOURCE guards, matching cert-id-validation_test.ts: the route needs
// a live Supabase, and the property that regressed is static — "the column is
// named in the allowlist and survives the payload strip".

import { assert } from "@std/assert";

const PUB = Deno.readTextFileSync(
  new URL("../routes/content-public.ts", import.meta.url),
);
const CERT_SSR = Deno.readTextFileSync(
  new URL("../../../../functions/cert/[id].ts", import.meta.url),
);

/** The value of a `const NAME = "a" + "b";` string declaration, as one string. */
function declaredString(src: string, name: string): string {
  const start = src.indexOf(`const ${name} =`);
  assert(start > -1, `${name} is gone — update this guard rather than deleting it`);
  const decl = src.slice(start, src.indexOf(";", start));
  const chunks = decl.match(/"([^"]*)"/g) ?? [];
  assert(chunks.length > 0, `${name} is no longer a plain string declaration`);
  return chunks.map((c) => c.slice(1, -1)).join("");
}

/** The columns the public certificate select actually asks Postgres for. */
function selectedColumns(name: string): string[] {
  return declaredString(PUB, name)
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

const GENESIS = selectedColumns("CERT_REPORT_GENESIS_COLUMNS");
const EXTRA = selectedColumns("CERT_REPORT_EXTRA_COLUMNS");
const ALL = [...GENESIS, ...EXTRA];

Deno.test("US-2400 AC1: human_reviewed is in the public certificate allowlist", () => {
  assert(
    ALL.includes("human_reviewed"),
    "human_reviewed is not selected, so the /cert SSR page and the partner " +
      "widget can never render the human-finalized AI disclosure",
  );
});

Deno.test("US-2400 AC1: it is in the EXTRA set, not GENESIS", () => {
  // US-1945 drift-safety: a column missing from the database makes the WHOLE
  // select 42703 and every certificate 404. The genesis-only fallback is what
  // stops that, and it can only help for columns kept out of the genesis set.
  assert(
    EXTRA.includes("human_reviewed"),
    "human_reviewed must be in CERT_REPORT_EXTRA_COLUMNS",
  );
  assert(
    !GENESIS.includes("human_reviewed"),
    "human_reviewed is in the GENESIS set — under migration drift the whole " +
      "certificate surface would 404 instead of degrading",
  );
});

Deno.test("US-2400 AC2: human_reviewed survives into the certificate payload", () => {
  // Selecting a column is not the same as serving it. The handler spreads the
  // row and then DELETES the structured anti-fraud signals (they are reduced to
  // booleans by projectTrustSignals). human_reviewed must not join that list.
  const start = PUB.indexOf("const publicReport: Record<string, unknown> = { ...rep };");
  assert(start > -1, "the certificate payload build was restructured");
  const build = PUB.slice(start, PUB.indexOf("});", start));

  const stripped = [...build.matchAll(/delete publicReport\.(\w+)/g)].map((m) => m[1]);
  assert(
    !stripped.includes("human_reviewed"),
    "human_reviewed is stripped from the payload after being selected — the " +
      "disclosure variant would still be undefined on every SSR surface",
  );
  assert(
    build.includes("...publicReport"),
    "the payload no longer spreads the selected row, so an allowlisted column " +
      "no longer implies a served field — this guard needs rewriting",
  );
});

// ── AC5: the interface and the allowlist cannot drift ─────────────
//
// functions/ is NOT typechecked by the build (tsconfig.functions.json exists but
// nothing runs it), so a field declared on PublicCertificate that the API never
// sends is invisible at build time: the code compiles, the field is undefined,
// and the page silently renders the absent branch. That is the generalizable
// half of this story — human_reviewed was one instance of it.

/** Fields the ROUTE adds itself (from submissions / storage / trust signals). */
const ROUTE_ADDED = new Set([
  "id",
  "title",
  "brand",
  "garment_type",
  "garment_category",
  "description",
  "hero_image_url",
  "images",
  "verified_capture_passed",
  "live_capture_verified",
  "verified_360_badge",
  "original_photos_verified",
]);

/** Top-level field names of `interface PublicCertificate { … }`. */
function publicCertificateFields(src: string): string[] {
  const start = src.indexOf("interface PublicCertificate {");
  assert(start > -1, "the PublicCertificate interface is gone");
  const body = src.slice(start, src.indexOf("\n}", start));
  // Two-space indent = a top-level member. Nested object types in this file are
  // written inline on one line (images), so they never match.
  return [...body.matchAll(/^ {2}(\w+)\??\s*:/gm)].map((m) => m[1]!);
}

Deno.test("US-2400 AC5: every /cert SSR field is one the endpoint actually sends", () => {
  const declared = publicCertificateFields(CERT_SSR);
  assert(declared.length > 10, `parsed only ${declared.length} fields — parser broke`);

  const phantom = declared.filter((f) => !ALL.includes(f) && !ROUTE_ADDED.has(f));
  assert(
    phantom.length === 0,
    `PublicCertificate in functions/cert/[id].ts declares field(s) the public ` +
      `certificate endpoint never sends: ${phantom.join(", ")}. Add them to ` +
      `CERT_REPORT_EXTRA_COLUMNS in content-public.ts, or drop them from the ` +
      `interface. functions/ is not typechecked, so nothing else catches this — ` +
      `the field is just undefined and the page renders the absent branch.`,
  );
});
