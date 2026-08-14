// US-2569: a regraded certificate is revised, not vanished.
//
// The chain walk is the part that has to be right. A garment can be regraded
// more than once, so the number printed on a two-year-old hangtag may sit three
// hops behind the live grade — and following only the first hop would send a
// buyer to a certificate that is ITSELF retired. That answer is worse than the
// 404 it replaced, because it looks authoritative.

import { assert, assertEquals } from "@std/assert";
import {
  resolveRevisionChain,
  revisionMessage,
  type RevisionRow,
} from "../lib/cert-revision.ts";

const AT = "2026-08-14T10:00:00.000Z";

function rev(over: Partial<RevisionRow> = {}): RevisionRow {
  return {
    superseded_report_id: "r1",
    superseded_certificate_id: "c1",
    superseded_certificate_number: "GT-AAAAAAA",
    superseded_overall_score: 7.5,
    superseded_grade_tier: "Good",
    superseding_report_id: "r2",
    superseding_certificate_id: "c2",
    superseding_certificate_number: "GT-BBBBBBB",
    superseding_overall_score: 8.5,
    superseding_grade_tier: "Excellent",
    reason: "regrade",
    superseded_at: AT,
    ...over,
  };
}

function index(rows: RevisionRow[]): Map<string, RevisionRow> {
  return new Map(rows.map((r) => [r.superseded_report_id, r]));
}

Deno.test("a single revision resolves to its successor", () => {
  const r = rev();
  const out = resolveRevisionChain(r, index([r]));
  assertEquals(out.status, "revised");
  if (out.status !== "revised") return;
  assertEquals(out.currentCertificateId, "c2");
  assertEquals(out.currentCertificateNumber, "GT-BBBBBBB");
  assertEquals(out.hops.length, 1);
});

Deno.test("a certificate revised TWICE resolves to the live grade, not the middle one", () => {
  // AC6. The failure this prevents: a buyer types the oldest number, is sent to
  // GT-BBBBBBB, and finds another revised page. Two hops of that and the
  // certificate system has taught them not to bother.
  const first = rev({
    superseded_report_id: "r1",
    superseded_certificate_number: "GT-AAAAAAA",
    superseding_report_id: "r2",
    superseding_certificate_id: "c2",
    superseding_certificate_number: "GT-BBBBBBB",
  });
  const second = rev({
    superseded_report_id: "r2",
    superseded_certificate_id: "c2",
    superseded_certificate_number: "GT-BBBBBBB",
    superseding_report_id: "r3",
    superseding_certificate_id: "c3",
    superseding_certificate_number: "GT-CCCCCCC",
    superseded_at: "2026-08-15T10:00:00.000Z",
  });

  const out = resolveRevisionChain(first, index([first, second]));
  assertEquals(out.status, "revised");
  if (out.status !== "revised") return;
  assertEquals(out.currentCertificateId, "c3");
  assertEquals(out.currentCertificateNumber, "GT-CCCCCCC");
});

Deno.test("the full chain is reported, so the history is visible", () => {
  const first = rev({ superseded_report_id: "r1", superseding_report_id: "r2" });
  const second = rev({
    superseded_report_id: "r2",
    superseded_certificate_number: "GT-BBBBBBB",
    superseding_report_id: "r3",
    superseding_certificate_id: "c3",
    superseding_certificate_number: "GT-CCCCCCC",
  });
  const out = resolveRevisionChain(first, index([first, second]));
  assertEquals(out.hops.length, 2);
  assertEquals(out.hops[0].fromCertificateNumber, "GT-AAAAAAA");
  assertEquals(out.hops[1].fromCertificateNumber, "GT-BBBBBBB");
  assertEquals(out.hops[1].toCertificateNumber, "GT-CCCCCCC");
});

Deno.test("an unresolved revision reports PENDING, not not-found", () => {
  // The regrade is still running, or it failed. "Revised, new grade pending" is
  // true; "not found" is not, and the difference is the whole story.
  const r = rev({
    superseding_report_id: null,
    superseding_certificate_id: null,
    superseding_certificate_number: null,
  });
  const out = resolveRevisionChain(r, index([r]));
  assertEquals(out.status, "pending");
  assertEquals(out.hops.length, 1);
});

Deno.test("a successor that exists but was never certified is PENDING", () => {
  // superseding_report_id is set, superseding_certificate_id is not — a grade
  // that landed in review and has no public certificate yet. Naming it would
  // point a buyer at a page that 404s.
  const r = rev({ superseding_certificate_id: null });
  const out = resolveRevisionChain(r, index([r]));
  assertEquals(out.status, "pending");
});

Deno.test("a cycle terminates instead of hanging the public endpoint", () => {
  // Only reachable through a bug, but this runs on an unauthenticated path and
  // an infinite walk there is an outage, not a wrong answer.
  const a = rev({ superseded_report_id: "r1", superseding_report_id: "r2" });
  const b = rev({
    superseded_report_id: "r2",
    superseding_report_id: "r1",
    superseding_certificate_id: "c1",
    superseding_certificate_number: "GT-AAAAAAA",
  });
  const out = resolveRevisionChain(a, index([a, b]));
  assert(out.hops.length <= 2);
});

Deno.test("numeric scores arriving as strings are normalized", () => {
  // PostgREST hands back `numeric` as a string; a UI that formats it would print
  // "7.50" beside "8.5" and look broken.
  const r = rev({ superseded_overall_score: "7.5", superseding_overall_score: "8.5" });
  const out = resolveRevisionChain(r, index([r]));
  assertEquals(out.hops[0].fromScore, 7.5);
  assertEquals(out.hops[0].toScore, 8.5);
});

Deno.test("the message names the successor and the date", () => {
  const r = rev();
  const out = resolveRevisionChain(r, index([r]));
  const msg = revisionMessage(out);
  assert(msg.includes("GT-BBBBBBB"));
  assert(msg.includes("2026-08-14"));
});

Deno.test("the PENDING message does not invent a successor", () => {
  const r = rev({ superseding_report_id: null, superseding_certificate_id: null });
  const msg = revisionMessage(resolveRevisionChain(r, index([r])));
  assert(msg.includes("not published yet"));
  assert(!msg.includes("GT-BBBBBBB"));
});

// ── The migration's guarantees ─────────────────────────────────────────────

const MIGRATION = new URL(
  "../../../../supabase/migrations/00600_grade_report_revisions.sql",
  import.meta.url,
);

Deno.test("a revision row can never be deleted", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assert(/BEFORE UPDATE OR DELETE ON public\.grade_report_revisions/i.test(sql));
  assert(
    /TG_OP = 'DELETE'[\s\S]{0,200}RAISE EXCEPTION/i.test(sql),
    "DELETE must raise",
  );
  assert(/restrict_violation/.test(sql));
});

Deno.test("the superseded half of a revision is frozen", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  for (const col of [
    "superseded_report_id",
    "superseded_certificate_id",
    "superseded_certificate_number",
    "superseded_overall_score",
    "superseded_grade_tier",
    "superseded_at",
  ]) {
    assert(
      new RegExp(`NEW\\.${col} IS DISTINCT FROM OLD\\.${col}`).test(sql),
      `${col} must be frozen by the guard`,
    );
  }
  // IS DISTINCT FROM, not <>: a NULL on either side of <> yields NULL, and the
  // check would silently pass for exactly the columns most likely to be null.
  assert(!/NEW\.superseded_\w+ <> OLD\./.test(sql));
});

Deno.test("a resolved revision cannot be re-pointed at a different successor", async () => {
  // Filling the superseding half once is the ONE permitted transition. Changing
  // it afterwards would rewrite what a buyer was already shown.
  const sql = await Deno.readTextFile(MIGRATION);
  assert(
    /OLD\.superseding_report_id IS NOT NULL[\s\S]{0,200}RAISE EXCEPTION/i.test(sql),
    "a second resolution must raise",
  );
});

Deno.test("one revision row per retired report", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assert(
    /CREATE UNIQUE INDEX[\s\S]{0,160}\(superseded_report_id\)/i.test(sql),
    "a second supersede of the same report is a bug, not a second revision",
  );
});

Deno.test("the table is deny-all — a revision is not a way around a moderation hold", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assert(/ENABLE ROW LEVEL SECURITY/i.test(sql));
  assert(
    !/CREATE POLICY[\s\S]{0,80}grade_report_revisions/i.test(sql),
    "no policy — the public endpoint reads it service-role and re-applies " +
      "isCertificateWithheld to the successor",
  );
});

// ── Wiring ─────────────────────────────────────────────────────────────────

Deno.test("the supersede records the certificate BEFORE nulling it", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/grading-pipeline.ts", import.meta.url),
  );
  const select = src.indexOf('"id, certificate_id, certificate_number, overall_score, grade_tier"');
  const insert = src.indexOf('.from("grade_report_revisions")');
  const nulling = src.indexOf("certificate_id: null");
  assert(select > -1, "the supersede must read the certified facts");
  assert(insert > -1, "the supersede must write a revision row");
  assert(
    insert < nulling,
    "the revision must be recorded BEFORE certificate_id is nulled — after, " +
      "there is nothing left to record",
  );
});

Deno.test("the resolve only touches UNRESOLVED revisions", async () => {
  // 00600's trigger refuses a second resolution, and this runs on every
  // completed grade for the submission — including ones that superseded nothing.
  const src = await Deno.readTextFile(
    new URL("../lib/grading-pipeline.ts", import.meta.url),
  );
  const idx = src.indexOf("superseding_report_id: gradeReport.id");
  assert(idx > -1, "the pipeline must resolve open revisions");
  assert(
    src.slice(idx, idx + 600).includes('.is("superseding_report_id", null)'),
    "the update must be scoped to unresolved rows",
  );
});

Deno.test("the public cert endpoint answers revised instead of 404", async () => {
  const src = await Deno.readTextFile(
    new URL("../routes/content-public.ts", import.meta.url),
  );
  assert(src.includes("loadRevisionResolution({ certificateId: certId })"));
  assert(src.includes("loadRevisionResolution({ certificateNumber: number })"));
  assert(
    src.includes("isCertificateWithheld(sub as never)"),
    "the successor must pass the same publicity gate a live certificate does — " +
      "a revision must not read around a moderation hold",
  );
});
