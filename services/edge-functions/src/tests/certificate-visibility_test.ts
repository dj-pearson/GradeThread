// US-484: a flagged grade must 404 on the public cert endpoints until cleared.
// The endpoints (GET /certificates/:id and /:id/verify in content-public.ts)
// both gate on isCertificateWithheld(submission) — so testing the pure predicate
// proves the withhold behaviour without a live DB.

import { assertEquals } from "@std/assert";
import { isCertificateWithheld } from "../lib/certificate-visibility.ts";

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
