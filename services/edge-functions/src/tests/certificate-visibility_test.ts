// US-484: a flagged grade must 404 on the public cert endpoints until cleared.
// The endpoints (GET /certificates/:id and /:id/verify in content-public.ts)
// both gate on isCertificateWithheld(submission) — so testing the pure predicate
// proves the withhold behaviour without a live DB.

import { assertEquals } from "@std/assert";
import {
  isCertificateWithheld,
  indexableCertificates,
} from "../lib/certificate-visibility.ts";

Deno.test("flagged + not-yet-approved is withheld (404)", () => {
  // moderation_status null (freshly flagged in the pipeline, never reviewed)
  assertEquals(
    isCertificateWithheld({ flagged: true, moderation_status: null }),
    true,
  );
  // moderation_status explicitly 'pending' / 'rejected' is still withheld
  assertEquals(
    isCertificateWithheld({ flagged: true, moderation_status: "pending" }),
    true,
  );
  assertEquals(
    isCertificateWithheld({ flagged: true, moderation_status: "rejected" }),
    true,
  );
});

Deno.test("flagged grade is resolvable again once a human approves (US-476)", () => {
  // Admin approve sets flagged=false + moderation_status='approved'. Either
  // alone is enough to clear the gate, but both happen together in practice.
  assertEquals(
    isCertificateWithheld({ flagged: false, moderation_status: "approved" }),
    false,
  );
  // Belt-and-braces: an explicit 'approved' clears it even if flagged lingered.
  assertEquals(
    isCertificateWithheld({ flagged: true, moderation_status: "approved" }),
    false,
  );
});

Deno.test("an unflagged grade is publicly resolvable", () => {
  assertEquals(
    isCertificateWithheld({ flagged: false, moderation_status: null }),
    false,
  );
  assertEquals(isCertificateWithheld({}), false);
  assertEquals(isCertificateWithheld(null), false);
  assertEquals(isCertificateWithheld(undefined), false);
});

Deno.test("a preliminary (pending_review) grade is withheld until finalized", () => {
  // Mandatory review: the certificate exists but isn't official yet.
  assertEquals(isCertificateWithheld({ status: "pending_review" }), true);
  // Even an otherwise-clean (unflagged) grade is withheld while in review.
  assertEquals(
    isCertificateWithheld({
      status: "pending_review",
      flagged: false,
      moderation_status: null,
    }),
    true,
  );
  // Once finalized (status='completed'), an unflagged grade is resolvable again.
  assertEquals(
    isCertificateWithheld({
      status: "completed",
      flagged: false,
      moderation_status: null,
    }),
    false,
  );
});

// US-1680: the SAME predicate also gates SITEMAP inclusion. A cert that would
// 404 on the public path is never listed (no soft-404 / crawl bloat as cert
// volume scales).
//
// ⚠ This used to be titled "iff it is publicly resolvable", and that stopped
// being true: a resolvable certificate with no garment photo is served noindex
// and is not listed either. Resolvability is one of two rules now, and
// indexableCertificates() below is the whole policy.
Deno.test("sitemap withholds a cert that would 404 (US-1680)", () => {
  const eligibleForSitemap = (
    sub: Parameters<typeof isCertificateWithheld>[0],
  ) => !isCertificateWithheld(sub);

  // Included: a finalized, unflagged cert.
  assertEquals(
    eligibleForSitemap({ status: "completed", flagged: false, moderation_status: "approved" }),
    true,
  );
  assertEquals(eligibleForSitemap({}), true);
  // Excluded: flagged-but-unapproved, or still pending_review.
  assertEquals(eligibleForSitemap({ flagged: true, moderation_status: null }), false);
  assertEquals(eligibleForSitemap({ status: "pending_review" }), false);
});

// The sitemap list applies TWO rules, and for months it applied one.
//
// A withheld certificate 404s, so listing it is a soft 404 — that rule was
// there. A certificate with no garment photo resolves and is served `noindex`
// (US-1665 AC4), and nothing stopped the list from advertising it at priority
// 0.7 and then telling the crawler to drop it. On a surface built to hold
// 50,000 URLs that is real crawl budget spent on pages we asked not to index.

Deno.test("the sitemap list drops a certificate with no garment photo", () => {
  const rows = [
    { certificate_id: "c1", submission_id: "s1", submissions: { flagged: false } },
    { certificate_id: "c2", submission_id: "s2", submissions: { flagged: false } },
  ];
  const listed = indexableCertificates(rows, new Set(["s1"]));
  assertEquals(listed.map((r) => r.certificate_id), ["c1"]);
});

Deno.test("the photo rule does not replace the withhold rule", () => {
  const rows = [
    // Has a photo, but its submission is flagged and unapproved: still 404s.
    {
      certificate_id: "c1",
      submission_id: "s1",
      submissions: { flagged: true, moderation_status: null },
    },
    // Has a photo and is clean: the only one worth advertising.
    { certificate_id: "c2", submission_id: "s2", submissions: { flagged: false } },
    // Clean, but pending_review, which withholds regardless of photos.
    {
      certificate_id: "c3",
      submission_id: "s3",
      submissions: { status: "pending_review", flagged: false },
    },
  ];
  const listed = indexableCertificates(rows, new Set(["s1", "s2", "s3"]));
  assertEquals(listed.map((r) => r.certificate_id), ["c2"]);
});

Deno.test("a to-one embed that arrives as an array is read the same way", () => {
  // supabase-js occasionally returns the embed as a one-element array, which is
  // why the withhold check unwraps it. The same unwrapping has to survive here.
  const rows = [
    {
      certificate_id: "c1",
      submission_id: "s1",
      submissions: [{ flagged: true, moderation_status: null }],
    },
  ];
  assertEquals(indexableCertificates(rows, new Set(["s1"])).length, 0);
});

Deno.test("a row with no submission_id is never advertised", () => {
  // No submission id means the photo question cannot be answered, and the
  // failure direction matches the sitemap's: omit rather than advertise a page
  // that may be served noindex.
  const rows = [{ certificate_id: "c1", submission_id: null, submissions: { flagged: false } }];
  assertEquals(indexableCertificates(rows, new Set(["s1"])).length, 0);
});
