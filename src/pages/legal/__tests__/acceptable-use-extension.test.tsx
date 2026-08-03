// US-1757 / US-1885: the AUP must cover what the extension's consent clickwrap
// claims the user is agreeing to.
//
// extension-unified/popup.js points its "Read the terms" link at
// /acceptable-use, next to a checkbox reading "I understand the Lister fills
// forms in MY browser session and that I am responsible for each marketplace's
// Terms of Service." Before this section existed, that link landed on a page
// that never mentioned the extension, browser automation, or cross-posting — a
// consent gate whose terms did not describe the thing being consented to.
//
// The last test reads the extension source directly, so if someone repoints the
// link at a different page this fails rather than silently orphaning the
// clickwrap again.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { AcceptableUsePage } from "@/pages/legal/acceptable-use";

function render() {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AcceptableUsePage />
    </MemoryRouter>,
  );
}

describe("acceptable use: extension / assisted cross-posting", () => {
  it("has an extension section", () => {
    const html = render();
    expect(html).toContain('id="extension"');
    expect(html).toMatch(/cross-posting/i);
  });

  it("states the automation runs in the user's own session, as them", () => {
    // This is the load-bearing claim: it is why responsibility sits with the
    // user, and it must match the privacy policy and SUBMISSION.md.
    const html = render();
    expect(html).toMatch(/own logged-in browser session/i);
    expect(html).toMatch(/never receive your marketplace\s+passwords or cookies/i);
  });

  it("says each marketplace's own rules take precedence", () => {
    // The clickwrap makes the user responsible for marketplace ToS, so the AUP
    // has to actually say that some marketplaces restrict assisted listing.
    const html = render();
    expect(html).toMatch(/restrict or prohibit automated or assisted listing/i);
    expect(html).toMatch(/takes precedence/i);
  });

  it("forbids using it to evade marketplace limits or bans", () => {
    const html = render();
    expect(html).toMatch(/listing caps, rate limits, suspensions, or\s+bans/i);
  });

  it("numbers every section sequentially", () => {
    const html = render();
    const numbers = [...html.matchAll(/<h2[^>]*>(\d+)\./g)].map((m) => Number(m[1]));
    expect(numbers.length).toBeGreaterThan(5);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });

  it("is still where the extension popup sends people for the terms", () => {
    // If the popup is repointed, this section stops being the consent target
    // and the clickwrap is orphaned again — the exact bug this fixes.
    const popup = readFileSync("extension-unified/popup.js", "utf8");
    const line = popup.split("\n").find((l) => l.includes("termsLink"));
    expect(line, "popup.js must still set a termsLink href").toBeTruthy();
    expect(line).toContain("/acceptable-use");
  });
});
