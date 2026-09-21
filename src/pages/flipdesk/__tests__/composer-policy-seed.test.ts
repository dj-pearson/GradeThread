import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// US-2855: the composer's three business-policy controls opened blank.
//
// The default was already applied at PUBLISH time, so the right policy reached
// eBay either way; what the seller could not do was see which one, or change it
// before pressing publish. The preview line compensated for display only, which
// made the gap harder to notice rather than smaller.
//
// WHY A SOURCE SCAN. The two properties below are both about an EFFECT'S WAIT
// CONDITION, and a wait condition is invisible to any test that lets the effect
// settle: seed too early and the value is null, and the effect then sets
// `initialised` so it never runs again. Both failure modes render a composer
// that looks fine. Mounting a 3,800-line page to observe the order these
// resolve in is a worse test than reading the two lines that decide it.

const SRC = readFileSync(
  join(__dirname, "../composer.tsx"),
  "utf8",
);

describe("business-policy seed (US-2855)", () => {
  it("seeds all three policies through the shared resolver", () => {
    // Not re-implemented inline: the resolver is where the "a saved row owns
    // its value, including null" rule is written down and unit-tested.
    expect(SRC).toContain('resolveSeedPolicyId(listing, "shipping", policyDefaults)');
    expect(SRC).toContain('resolveSeedPolicyId(listing, "payment", policyDefaults)');
    expect(SRC).toContain('resolveSeedPolicyId(listing, "return", policyDefaults)');
  });

  it("waits for the policy defaults before seeding", () => {
    // Without the wait the seed runs against undefined, writes null into all
    // three controls and then sets `initialised`, so the default is lost for
    // good rather than arriving late. eslint's exhaustive-deps caught this one
    // as a missing dependency, which is the cheap half of the same finding.
    expect(SRC).toMatch(/if \(ebayConnection && ebayPoliciesLoading\) return;/);
  });

  it("only waits when there is a connection to wait for", () => {
    // THE HAZARD THE LINE ABOVE AVOIDS. useEbayPolicies is DISABLED without a
    // connection, so an unconditional wait never resolves and the composer
    // never initialises -- for every seller who does not use eBay, which is the
    // larger group. The guard is the `ebayConnection &&`, and this asserts the
    // unguarded form is absent rather than trusting the guarded one to be the
    // only occurrence.
    expect(SRC).not.toMatch(/if \(ebayPoliciesLoading\) return;/);
  });
});
