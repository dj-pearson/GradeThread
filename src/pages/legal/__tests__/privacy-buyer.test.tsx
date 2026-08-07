// US-1846: the privacy policy must describe the buyer platform's data, and it
// must describe the extension's ALERTS check accurately.
//
// The second half is the one with teeth. The extension section used to end
// "Results are not stored on our servers" — true when it was written, and false
// from the moment US-1808 shipped an endpoint that writes a listing row keyed to
// the buyer's account and keeps it for 90 days. Nothing failed: a stale sentence
// in prose has no compiler. This page is the URL submitted to the Chrome Web
// Store and to AMO as the extension's privacy policy, so the sentence was a
// failed store review waiting to be noticed by a reviewer rather than by us.
//
// Every assertion below pairs with a claim in extension-unified/SUBMISSION.md or
// with an entry in services/edge-functions/src/lib/buyer-pii.ts.
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

describe("privacy policy: buyer platform disclosure", () => {
  it("has a buyer-features section", () => {
    const html = render();
    expect(html).toContain('id="buyer-data"');
  });

  it("names each category of buyer data we hold", () => {
    const html = render();
    // One phrase per group in BUYER_PII_TABLES. A table added to the register
    // without a line here means we hold something the policy doesn't mention.
    expect(html).toMatch(/body measurements/i);
    expect(html).toMatch(/closet/i);
    expect(html).toMatch(/saved searches/i);
    expect(html).toMatch(/watchlist/i);
    expect(html).toMatch(/trust score/i);
    expect(html).toMatch(/reward-credit/i);
  });

  it("classifies measurements and browsing as sensitive", () => {
    const html = render();
    expect(html).toMatch(/sensitive/i);
    expect(html).toMatch(/never shown on a certificate/i);
  });

  it("says the public buyer profile is off by default", () => {
    const html = render();
    expect(html).toMatch(/off by default/i);
    expect(html).toMatch(/Nothing about\s+you is published unless you turn on/i);
  });

  it("discloses that grade confirmations are de-identified, not destroyed", () => {
    // The single `unlink` entry in the register. Claiming account deletion
    // destroys everything would be the easy sentence and the false one.
    const html = render();
    expect(html).toMatch(/de-identified/i);
  });
});

describe("privacy policy: the extension's alerts check", () => {
  it("no longer claims results are never stored", () => {
    // The exact sentence US-1808 falsified. Its return would mean someone
    // reverted the correction, or wrote the old summary again from memory.
    const html = render();
    expect(html).not.toMatch(/[Rr]esults are not stored on our servers/);
  });

  it("discloses that the alerts check IS retained, and for how long", () => {
    const html = render();
    expect(html).toMatch(/check this against my alerts/i);
    expect(html).toMatch(/90 days/);
    // The two mechanical anti-crawl limits the endpoint actually enforces —
    // stated because "we only read what you're looking at" is the whole basis
    // on which this is not a browsing tracker.
    expect(html).toMatch(/one listing per press/i);
    expect(html).toMatch(/never fetch the listing page/i);
  });

  it("keeps the retention schedule covering buyer data", () => {
    const html = render();
    expect(html).toMatch(/Listings you asked the extension to check/i);
    expect(html).toMatch(/Buyer profile data/i);
  });
});
