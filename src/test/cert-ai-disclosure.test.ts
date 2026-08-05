// US-2400: the /cert SSR page must be able to say a human finalized the grade.
//
// US-2399 put a per-grade AI disclosure on four surfaces. Two of them — the
// /cert SSR page and the white-label partner widget — read the public
// certificate endpoint, whose select is an explicit allowlist that did not
// contain human_reviewed. So the flag was always undefined there, the
// human-finalized branch was unreachable, and the SSR bytes said "AI-generated
// condition estimate" right before the SPA mounted over them and said
// "finalized by a human reviewer".
//
// The disclosure block now comes from a pure builder in _shared, for a reason
// worth stating: functions/cert/[id].ts uses the Cloudflare worker globals, so
// no test under src/ can import it, and the wording it emitted was assertable
// nowhere. An inline template on an untestable surface is how the unreachable
// branch shipped.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  aiDisclosureBody,
  aiDisclosureNoticeHtml,
  aiDisclosureTitle,
} from "../../functions/_shared/ai-disclosure";

const CERT_SSR = readFileSync("functions/cert/[id].ts", "utf8");

describe("cert SSR AI disclosure (US-2400)", () => {
  it("says human-finalized for a human_reviewed=true certificate", () => {
    const html = aiDisclosureNoticeHtml(true);
    expect(html).toContain("finalized by a human reviewer");
    expect(html).toContain("A GradeThread reviewer checked this grade");
  });

  it("says AI-generated for a human_reviewed=false certificate", () => {
    const html = aiDisclosureNoticeHtml(false);
    expect(html).toContain("AI-generated condition estimate");
    expect(html).not.toContain("human reviewer");
  });

  it("carries the shared copy verbatim, HTML-escaped", () => {
    // The apostrophe in "the seller's photos" is the only character that moves;
    // if this ever diverges, the SSR page is rendering copy that no parity test
    // covers.
    for (const reviewed of [true, false]) {
      const html = aiDisclosureNoticeHtml(reviewed);
      expect(html).toContain(aiDisclosureTitle(reviewed).replace(/'/g, "&#39;"));
      expect(html).toContain(aiDisclosureBody(reviewed).replace(/'/g, "&#39;"));
    }
    expect(aiDisclosureNoticeHtml(false)).toContain("seller&#39;s photos");
  });

  it("links to the Terms section the disclosure refers to", () => {
    expect(aiDisclosureNoticeHtml(true)).toContain('href="/terms"');
  });

  // The builder is only the truth if the page still renders it. [id].ts can't be
  // imported here (worker globals), so this asserts the wiring at the source.
  it("is the block the SSR page renders, keyed on the certificate's own flag", () => {
    expect(CERT_SSR).toContain(
      "const aiDisclosureHtml = aiDisclosureNoticeHtml(cert.human_reviewed === true);",
    );
    expect(CERT_SSR).toContain("${aiDisclosureHtml}");
    expect(CERT_SSR).toContain('from "../_shared/ai-disclosure"');
  });

  it("declares human_reviewed on the SSR certificate interface", () => {
    // Paired with the edge guard (cert-public-allowlist_test.ts), which proves
    // the endpoint actually sends it. Either half alone renders the wrong
    // variant with no error.
    expect(CERT_SSR).toMatch(/interface PublicCertificate \{[\s\S]*?human_reviewed\?: boolean \| null;/);
  });
});
