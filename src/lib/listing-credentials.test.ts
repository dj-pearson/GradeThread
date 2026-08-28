import { describe, expect, it } from "vitest";
import { SELLER_CREDENTIALS_MARKER, splitSellerCredentials } from "./listing-templates";

// US-2965 deleted `ensureSellerCredentials` and its four cases with it. Its job
// was to re-append the pre-rewrite credentials block to a fresh AI description,
// back when the draft string was the only copy of the badge. It is the
// `credentials` description block now, rendered by the edge service on every
// save, so re-appending it printed the card twice. `splitSellerCredentials`
// stays: the eBay view-item preview reads it to draw the card apart from the
// body, which is a READ of a rendered description and not a second writer.

const BLOCK =
  `${SELLER_CREDENTIALS_MARKER}<div style="border:1px solid #e5e7eb"><div>✓ GradeThread Verified Seller — Pearson Mercantile</div><div>13 items independently graded · <strong>8.2 / 10</strong> average condition grade</div></div>`;

describe("splitSellerCredentials", () => {
  it("returns the whole string as body when no marker is present", () => {
    const { body, credentials } = splitSellerCredentials("Plain description.");
    expect(body).toBe("Plain description.");
    expect(credentials).toBe("");
  });

  it("splits the body from the trailing credentials block", () => {
    const desc = `Great sweater.\n\n${BLOCK}`;
    const { body, credentials } = splitSellerCredentials(desc);
    expect(body).toBe("Great sweater.");
    expect(credentials).toBe(BLOCK);
  });

  it("keeps everything from the marker on, including a grade line after it", () => {
    // The marker has no closing tag, so "from the marker to the end" is the
    // definition — and the cert/grade line the server appends at publish sits
    // AFTER the block. A reader that stopped at the first </div> would drop it.
    const desc = `Body.\n\n${BLOCK}\n\nGraded by GradeThread — Condition Grade 8.5`;
    const { body, credentials } = splitSellerCredentials(desc);
    expect(body).toBe("Body.");
    expect(credentials).toContain("Condition Grade 8.5");
  });
});
