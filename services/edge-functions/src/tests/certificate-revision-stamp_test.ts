// US-2392: a resealed certificate records when its content changed.
//
// `grade_reports` had no `updated_at` at all — only `created_at` and
// `superseded_at`. A human-review adjustment rewrites overall_score, grade_tier,
// all five factor scores, content_hash, content_signature and integrity_version
// on a LIVE, publicly-served row and recorded no timestamp on it.
//
// THE INTEGRITY HASH IS WHAT MAKES THIS SHARPER THAN MISSING METADATA. That hash
// exists so a buyer can verify a certificate has not been tampered with — and a
// legitimate adjustment RECOMPUTES it. So the certificate verifies clean both
// before and after a score change, with nothing on the row marking that one
// happened. Not a tamper hole (the change is authorised and audited in
// human_reviews) but the certificate carried no evidence of its own revision.
//
// TWO PROPERTIES CARRY THE FIX AND BOTH FAIL SILENTLY:
//
//   1. the stamp is written INSIDE the certificate branch — an adjustment to an
//      uncertified report has no certificate to have revised, and stamping one
//      would put a modification date on something never published;
//   2. a REGRADE must never set it. 00150 mints a NEW row with a NEW
//      certificate_id and nulls the old one's, so the new certificate's
//      modification date IS its publication date.

import { assert } from "@std/assert";

const read = (p: string) => Deno.readTextFileSync(new URL(p, import.meta.url));
const ADJ = read("../lib/grade-adjustment.ts");
const PUB = read("../routes/content-public.ts");
const SQL = Deno.readTextFileSync(
  new URL(
    "../../../../supabase/migrations/00522_grade_report_certified_content_updated_at.sql",
    import.meta.url,
  ),
);

Deno.test("US-2392: the adjustment path stamps the revision time", () => {
  assert(
    ADJ.includes("update.certified_content_updated_at"),
    "the reseal no longer records when the certified content changed",
  );
});

Deno.test("US-2392: the stamp is inside the certificate branch", () => {
  // An adjustment to an UNCERTIFIED report has no certificate to have revised.
  // Stamping one there would put a modification date on something never
  // published — and nothing downstream could tell it apart from a real one.
  const branch = ADJ.indexOf("if (report.certificate_id) {");
  const stamp = ADJ.indexOf("update.certified_content_updated_at");
  const close = ADJ.indexOf("await updateByIdChecked");
  assert(branch > -1, "the certificate branch was restructured");
  assert(stamp > branch, "the stamp moved above the certificate check");
  assert(stamp < close, "the stamp moved outside the branch, onto every adjustment");
});

Deno.test("US-2392 AC2: a regrade does not set it", () => {
  // The regrade path (00150) creates a NEW grade_reports row rather than
  // adjusting one, so it must never touch this column. Asserted by absence
  // across the whole lib+routes surface: the ONLY writer is the adjustment.
  const dirs = [new URL("../lib/", import.meta.url), new URL("../routes/", import.meta.url)];
  const writers: string[] = [];
  for (const dir of dirs) {
    for (const e of Deno.readDirSync(dir)) {
      if (!e.isFile || !e.name.endsWith(".ts")) continue;
      const src = Deno.readTextFileSync(new URL(e.name, dir));
      // A write looks like `certified_content_updated_at:` or `.certified… =`.
      if (/certified_content_updated_at\s*[:=]/.test(src)) writers.push(e.name);
    }
  }
  assert(
    writers.length === 1 && writers[0] === "grade-adjustment.ts",
    `exactly one writer expected (grade-adjustment.ts), found: ${writers.join(", ")}. ` +
      `A regrade mints a new certificate_id — its modification date IS its ` +
      `publication date, and setting this would say a fresh certificate was edited.`,
  );
});

Deno.test("US-2392 AC3: the public read exposes it, in the EXTRA set", () => {
  assert(
    /CERT_REPORT_EXTRA_COLUMNS[\s\S]{0,400}certified_content_updated_at/.test(PUB),
    "the column is not in the public certificate allowlist, so the cert page " +
      "cannot tell a revised certificate from an unrevised one",
  );
  // NOT in the genesis set: the 42703 fallback must still serve certificates on
  // a database where 00522 is unapplied.
  //
  // Sliced to the DECLARATION's own value, not to the region between the two
  // constants — the explanatory comment above the EXTRA set names this column,
  // so a region slice picks up the prose and the assertion fires on it. That is
  // the fourth time today a guard has accused its own explanation; the rule is
  // to bound on the construct, never on a marker a comment can precede.
  const gStart = PUB.indexOf("const CERT_REPORT_GENESIS_COLUMNS");
  const genesis = PUB.slice(gStart, PUB.indexOf(";", gStart));
  assert(
    !genesis.includes("certified_content_updated_at"),
    "the column is in the GENESIS set — under migration drift the whole " +
      "certificate surface would 404 instead of degrading",
  );
});

Deno.test("US-2392 AC1: a column, not a derivation", () => {
  // The decision, pinned. The alternative was max(human_reviews.reviewed_at),
  // which needs no migration and coupled the public certificate read to an
  // operator table that has a retention story — the certificate would silently
  // lose its revision date the day that table was pruned.
  assert(
    /add column if not exists certified_content_updated_at timestamptz/.test(SQL),
    "the column is gone",
  );
  assert(
    !/human_reviews/.test(PUB.slice(PUB.indexOf("loadPublicCertReport"))),
    "the public certificate read now joins human_reviews — that is the " +
      "derivation this deliberately did not choose",
  );
});

Deno.test("US-2392 AC5: the migration keeps the US-1108 triple", () => {
  assert(
    SQL.includes("insert into public.applied_migrations (version) values ('00522')"),
    "missing the self-record footer",
  );
  assert(SQL.includes("add column if not exists"), "not idempotent");
  const version = read("../lib/schema-version.ts");
  const expected = /EXPECTED_SCHEMA_VERSION = "(\d+)"/.exec(version)?.[1];
  assert(expected && expected >= "00522", `EXPECTED_SCHEMA_VERSION is ${expected}`);
});
