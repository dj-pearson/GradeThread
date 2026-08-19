// US-9127 AC4: the Claude connector is a real data-flow change and the legal
// pages have to say so BEFORE it is switched on, not after.
//
// The disclosure that matters is the DIRECTION. Section 4 already covers
// GradeThread sending photos to Anthropic under our own API agreement, where
// Anthropic is our subprocessor. The connector reverses that: the seller's own
// Claude client pulls data out of their account, and the answer lands in a
// conversation we neither control nor can read. A policy that describes only
// the first flow is not merely incomplete, it is describing the wrong party as
// the controller.
//
// Assertions are about disclosures a reader (or a directory reviewer) could
// check against the shipped code, not about wording.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { PrivacyPage } from "@/pages/legal/privacy";
import { TermsPage } from "@/pages/legal/terms";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

const privacy = () => render(<PrivacyPage />);
const terms = () => render(<TermsPage />);

describe("privacy policy: the Claude connector", () => {
  it("has a connector section of its own", () => {
    const html = privacy();
    expect(html).toContain('id="connector"');
    expect(html).toMatch(/Claude connector/);
  });

  it("says GradeThread does not send the account data to Anthropic on this path", () => {
    // The claim the whole section exists to make. If this ever stops being
    // true, the sentence is a misrepresentation and this test should fail.
    const html = privacy();
    expect(html).toMatch(/does not send your account data to Anthropic/i);
    expect(html).toMatch(/governed by your own agreement/i);
  });

  it("states the ZDR exclusion for the Messages API connector", () => {
    // Anthropic documents the Messages API MCP connector as NOT eligible for
    // zero-data-retention. Saying nothing here would let a reader assume our
    // enterprise arrangement in section 4 covers this path too.
    const html = privacy();
    expect(html).toMatch(/zero-data-retention/i);
    expect(html).toMatch(/Messages API connector/i);
  });

  it("says what an answer can contain, and what it cannot", () => {
    const html = privacy();
    // Photo links are real: gradethread_get_item returns signed photo URLs in
    // its structured content, so "we only send text" would be false.
    expect(html).toMatch(/links to your own item photos/i);
    expect(html).toMatch(/never contains your\s*password/i);
  });

  it("does not claim drafting stopped being our own AI call", () => {
    // Asking Claude to write a listing still runs ai-listing.ts against our own
    // Anthropic account. Two flows, both disclosed.
    const html = privacy();
    expect(html).toMatch(/our own API agreement/i);
  });

  it("discloses the audit log and its retention, with the row in the table", () => {
    const html = privacy();
    expect(html).toMatch(/400 days/);
    expect(html).toMatch(/tool-call audit log/i);
  });

  it("keeps the section numbering and the in-body cross references in step", () => {
    // The connector was inserted as 7, which shifted nine headings. A stale
    // "Section 9" pointing at retention is the kind of thing nobody notices.
    const html = privacy();
    for (const [n, id] of [
      [7, "connector"],
      [8, "radar"],
      [9, "sharing"],
      [10, "retention"],
      [11, "your-rights"],
      [16, "contact"],
    ] as const) {
      expect(html, `heading ${n} (#${id}) is out of step`).toMatch(
        new RegExp(`id="${id}"[^>]*>${n}\\.`),
      );
    }
    // Every "Section N" link in the body must name the heading it points at.
    const refs = [...html.matchAll(/href="#([a-z-]+)"[^>]*>Section (\d+)</g)];
    expect(refs.length).toBeGreaterThan(0);
    for (const [, id, n] of refs) {
      expect(html, `"Section ${n}" links to #${id}, which is not section ${n}`).toMatch(
        new RegExp(`id="${id}"[^>]*>${n}\\.`),
      );
    }
  });
});

describe("terms of service: the Claude connector", () => {
  it("covers the connector under API access", () => {
    const html = terms();
    expect(html).toContain('id="connector"');
    expect(html).toMatch(/Claude connector/);
  });

  it("puts responsibility for approved actions on the account holder", () => {
    const html = terms();
    expect(html).toMatch(/actions taken through a connection you authorized are your actions/i);
    // Grades cost money and a model can ask for them. Say so.
    expect(html).toMatch(/not refundable on the grounds that a model asked for it/i);
  });

  it("makes defeating the confirmation flow a breach rather than a nuisance", () => {
    const html = terms();
    expect(html).toMatch(/second, confirmed\s*call/i);
    expect(html).toMatch(/breach of these Terms/i);
  });

  it("names the client relationship as the user's, not ours", () => {
    const html = terms();
    expect(html).toMatch(/governed by your agreement with them/i);
  });

  it("says a downgrade or lapse reaches the connector immediately", () => {
    // connector-allowance.ts fails closed and resolves a paused subscription to
    // Free. The Terms should not promise grandfathering the code does not do.
    const html = terms();
    expect(html).toMatch(/downgrade, pause or lapse takes effect on the connector at once/i);
  });
});
