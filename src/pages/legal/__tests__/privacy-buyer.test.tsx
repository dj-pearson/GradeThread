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

  it("discloses the seller engagement tool, its consent and its human-check rule", () => {
    // US-2482 shipped a tool that clicks in the seller's own tab on a
    // third-party site. That is exactly the behaviour a store reviewer reads
    // this page to find, and SUBMISSION.md already declares it — a policy that
    // stops at cross-posting describes an extension we no longer ship.
    const html = render();
    expect(html).toMatch(/sharing a listing/i);
    expect(html).toMatch(/its own consent/i);
    expect(html).toMatch(/human\s+check/i);
    expect(html).toMatch(/We never answer one/i);
  });

  it("discloses what the mobile queue stores, and what it does not", () => {
    // US-2481. The whole design rests on the server holding an instruction and
    // never a credential; if the policy does not say so, the claim is only in
    // a commit message.
    const html = render();
    expect(html).toMatch(/7 days/);
    expect(html).toMatch(/never store a marketplace password, cookie, or session/i);
  });

  it("discloses sold-sync, and what it deliberately does not read", () => {
    // US-2697..US-2700. This reads a page that prints the BUYER's name and
    // shipping address, which makes the negative claim the load-bearing half:
    // stating what we take, without stating what we refuse, leaves a reader to
    // assume the worst about a page they can see carries both.
    const html = render();
    expect(html).toMatch(/sold-sync/i);
    // The renderer emits a real curly apostrophe, not the JSX entity.
    expect(html).toMatch(/buyer[\u2019']s name/i);
    expect(html).toMatch(/shipping address/i);
    expect(html).toMatch(/never reads another seller/i);
  });

  it("discloses the SCHEDULED sold-sync read, its own consent and its stop rules", () => {
    // US-2701 shipped an alarm that opens a tab on the seller's marketplace
    // while they are doing something else. SUBMISSION.md had said the opposite
    // ("there is no scheduled read") and this page said nothing at all — the
    // third time a seller-side behaviour on a third-party site shipped with the
    // store listing updated and the policy untouched.
    //
    // Asserted by MEANING, so the wording can improve and no promise can quietly
    // leave: that it is off until turned on, that its consent is its own, and
    // that a human check stops it for good.
    const html = render();
    expect(html).toMatch(/off/i);
    expect(html).toMatch(/its own consent screen/i);
    expect(html).toMatch(/unfocused tab/i);
    expect(html).toMatch(/30 minutes and 6 hours/i);
    expect(html).toMatch(/stops for that\s+marketplace and stays stopped/i);
    expect(html).toMatch(/only you\s+can start it again/i);
  });

  it("keeps the retention schedule covering buyer data", () => {
    const html = render();
    expect(html).toMatch(/Listings you asked the extension to check/i);
    expect(html).toMatch(/Buyer profile data/i);
  });
});
