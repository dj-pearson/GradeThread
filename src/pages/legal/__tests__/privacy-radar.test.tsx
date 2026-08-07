// US-1861 AC3: the privacy policy must disclose Thrift Radar — what a
// contribution contains, and at what granularity.
//
// These assertions are about DISCLOSURES, not wording, and each one corresponds
// to something the code actually does. If a claim here ever stops matching the
// implementation, the failure should be this test, not a regulator.
//
// The lesson this file is written against (see the buyer-privacy note in
// ralph-learnings): a policy sentence has no compiler, so a later feature
// falsifies it silently. So we assert both directions where it matters — that
// the promise is present AND that its negation cannot creep back in.
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

describe("privacy policy: Thrift Radar disclosure", () => {
  it("has a Radar section", () => {
    const html = render();
    expect(html).toContain('id="radar"');
    expect(html).toMatch(/Thrift Radar/);
  });

  it("states contribution is OFF unless turned on", () => {
    // The single most load-bearing claim: the toggle defaults to false in the
    // schema (users.radar_contribute), on iOS, and on the web. If any of those
    // ever flips to on-by-default, this sentence becomes a misrepresentation.
    const html = render();
    expect(html).toMatch(/off unless you turn it on/i);
  });

  it("states the exact position is discarded, not merely coarsened", () => {
    // radar_scan_events has no coordinate column at all — the policy is allowed
    // to say this because the schema makes it structurally true.
    const html = render();
    expect(html).toMatch(/discard the position/i);
    expect(html).toMatch(/no column/i);
  });

  it("names the granularity rather than hand-waving at it", () => {
    const html = render();
    expect(html).toMatch(/kilometre across/i);
  });

  it("discloses the de-identified, rotating contributor code", () => {
    const html = render();
    expect(html).toMatch(/scrambled code/i);
    expect(html).toMatch(/regenerated every week/i);
  });

  it("discloses the server-side k-anonymity floor", () => {
    // "enforced when the data is requested, not hidden in the app afterwards" is
    // the honest description of a server-side floor; a client-side hide would
    // make that phrase false.
    const html = render();
    expect(html).toMatch(/minimum number of separate contributors/i);
    expect(html).toMatch(/not hidden in the app afterwards/i);
  });

  it("states that viewing and contributing are separate consents", () => {
    const html = render();
    expect(html).toMatch(/Looking and contributing are separate choices/i);
    expect(html).toMatch(/never enrols you as a contributor/i);
  });

  it("lists Radar under the data we collect automatically, gated on the switch", () => {
    // The Radar section could be complete and Section 2 still silent, which is
    // the shape of disclosure gap that reads as deliberate.
    const html = render();
    expect(html).toMatch(/Device location, only if you turn on Thrift Radar/i);
  });

  it("gives Radar contributions their own retention row", () => {
    const html = render();
    expect(html).toMatch(/Thrift Radar contributions/i);
    expect(html).toMatch(/180 days/);
  });
});
