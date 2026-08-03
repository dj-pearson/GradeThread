// US-1757 AC1: the privacy policy must disclose what the browser extension does.
//
// extension-unified/SUBMISSION.md sends operators to https://gradethread.com/privacy
// as the extension's privacy policy, and both the Chrome Web Store and Firefox
// AMO require that page to cover the extension's data use. Before this section
// existed the page was silent about it, so the submission would have pointed at
// a policy that did not describe the product being submitted.
//
// These assertions are deliberately about DISCLOSURES, not wording — each one
// corresponds to a claim in SUBMISSION.md that a store reviewer can check
// against the shipped code.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { PrivacyPage } from "@/pages/legal/privacy";

function render() {
  return renderToStaticMarkup(
    <MemoryRouter>
      <PrivacyPage />
    </MemoryRouter>,
  );
}

describe("privacy policy: browser extension disclosure", () => {
  it("has an extension section", () => {
    const html = render();
    expect(html).toContain('id="extension"');
    expect(html).toMatch(/browser extension/i);
  });

  it("discloses what a condition read sends", () => {
    const html = render();
    expect(html).toMatch(/photo URLs/i);
    // The store disclosure is "website content on user action" — the policy has
    // to say it is the page you are already looking at, not background browsing.
    expect(html).toMatch(/does not browse on your behalf/i);
  });

  it("states that diagnostics are OPT-IN and carry no identifiers", () => {
    // This is the claim most likely to be checked, and the one I added code for
    // this session (selector-health telemetry). If the toggle ever becomes
    // on-by-default, this wording is a lie and the test should fail loudly.
    const html = render();
    expect(html).toMatch(/off by default/i);
    expect(html).toMatch(/not.*send the listing, the page address/is);
  });

  it("states marketplace credentials are never sent", () => {
    const html = render();
    expect(html).toMatch(/passwords and cookies are never sent/i);
  });

  it("numbers every section sequentially", () => {
    // Inserting a section means renumbering the ones after it and fixing any
    // "Section N" cross-references — I got that wrong by hand while adding the
    // extension section, and only a manual re-read caught the duplicate 7.
    const html = render();
    const numbers = [...html.matchAll(/<h2[^>]*>(\d+)\./g)].map((m) => Number(m[1]));
    expect(numbers.length).toBeGreaterThan(10);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });

  it("keeps every in-page Section cross-reference pointing at a real heading", () => {
    const html = render();
    const headingByAnchor = new Map<string, number>();
    for (const m of html.matchAll(/<h2[^>]*id="([^"]+)"[^>]*>(\d+)\./g)) {
      headingByAnchor.set(m[1] ?? "", Number(m[2] ?? 0));
    }
    const refs = [...html.matchAll(/href="#([a-z-]+)"[^>]*>Section (\d+)</g)];
    expect(refs.length).toBeGreaterThan(0);
    for (const m of refs) {
      const anchor = m[1] ?? "";
      const num = Number(m[2] ?? 0);
      expect(headingByAnchor.get(anchor), `#${anchor} must exist`).toBeDefined();
      expect(headingByAnchor.get(anchor), `"Section ${num}" -> #${anchor}`).toBe(num);
    }
  });
});
