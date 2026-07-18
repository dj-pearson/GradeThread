import { describe, expect, it } from "vitest";
import {
  ensureSellerCredentials,
  SELLER_CREDENTIALS_MARKER,
  splitSellerCredentials,
} from "./listing-templates";

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
});

describe("ensureSellerCredentials", () => {
  it("re-appends the original block to a rewrite that dropped it", () => {
    const original = `Old copy.\n\n${BLOCK}`;
    const rewritten = "Fresh AI copy about the sweater.";
    const result = ensureSellerCredentials(rewritten, original);
    expect(result).toBe(`Fresh AI copy about the sweater.\n${BLOCK}`);
  });

  it("does not duplicate the block if the rewrite echoed it", () => {
    const original = `Old copy.\n\n${BLOCK}`;
    const rewritten = `Fresh copy.\n${BLOCK}`;
    const result = ensureSellerCredentials(rewritten, original);
    // exactly one marker survives
    expect(result.split(SELLER_CREDENTIALS_MARKER).length - 1).toBe(1);
    expect(result).toBe(`Fresh copy.\n${BLOCK}`);
  });

  it("is a no-op when the original had no block", () => {
    const result = ensureSellerCredentials("Fresh copy.", "Old copy.");
    expect(result).toBe("Fresh copy.");
  });

  it("returns just the block when the rewrite is empty", () => {
    const result = ensureSellerCredentials("", `Old.\n\n${BLOCK}`);
    expect(result).toBe(BLOCK);
  });
});
