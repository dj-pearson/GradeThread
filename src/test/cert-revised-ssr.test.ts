// US-2569 AC4: the /cert/:id SSR page renders the revised state.
//
// The branded 404 (US-1945) exists so a buyer can tell a real certificate from a
// forgery. A REVISED certificate is neither: it was real, it still identifies
// this garment, and the grade moved. Serving it the 404 tells a buyer holding a
// hangtag that the number they were told to trust was never worth anything, and
// deindexes a URL that is still the correct entry point.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { certRevisedResponse } from "../../functions/cert/cert-not-found";

const env = { SITE_URL: "https://gradethread.com" } as never;

describe("certRevisedResponse", () => {
  it("answers 200, not 404 — the page has real content", async () => {
    const res = certRevisedResponse(env, {
      message: "This certificate was replaced on 2026-08-14. The current grade is GT-BBBBBBB.",
      current_certificate_id: "11111111-1111-4111-8111-111111111111",
      current_certificate_number: "GT-BBBBBBB",
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("This certificate was revised");
    expect(html).toContain("GT-BBBBBBB");
    expect(html).toContain("/cert/11111111-1111-4111-8111-111111111111");
  });

  it("canonicalises to the CURRENT certificate and stays indexable", async () => {
    // A crawler that already holds this URL should follow the revision forward
    // rather than drop a link that still points at the right garment.
    const res = certRevisedResponse(env, {
      message: "replaced",
      current_certificate_id: "22222222-2222-4222-8222-222222222222",
      current_certificate_number: "GT-CCCCCCC",
    });
    const html = await res.text();
    expect(html).toContain(
      'rel="canonical" href="https://gradethread.com/cert/22222222-2222-4222-8222-222222222222"',
    );
    expect(html).not.toContain("noindex");
  });

  it("does not invent a link when the replacement has not landed", async () => {
    // "Revised, new grade pending" is a real state — a regrade that is still
    // running, or one that failed. Linking to a certificate that does not exist
    // would be a worse answer than the 404 this replaces.
    const res = certRevisedResponse(env, {
      message: "This certificate was replaced on 2026-08-14. The updated grade is not published yet.",
      current_certificate_id: null,
      current_certificate_number: null,
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("/verify");
    expect(html).not.toMatch(/\/cert\/[0-9a-f-]{36}/);
  });

  it("escapes the message rather than trusting it", async () => {
    // The message is built server-side today, but it carries a certificate
    // number that originates in the database, and this renders raw HTML.
    const res = certRevisedResponse(env, {
      message: '<script>alert(1)</script>',
      current_certificate_id: null,
      current_certificate_number: null,
    });
    const html = await res.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("the SSR page routes the revised state", () => {
  const source = readFileSync(
    resolve(process.cwd(), "functions/cert/[id].ts"),
    "utf8",
  );

  it("checks for revised BEFORE falling through to the branded 404", () => {
    const revisedIdx = source.indexOf("certRevisedResponse(env");
    const notFoundIdx = source.indexOf("if (!data?.certificate) return certNotFoundResponse(env);");
    expect(revisedIdx).toBeGreaterThan(-1);
    expect(notFoundIdx).toBeGreaterThan(-1);
    expect(revisedIdx).toBeLessThan(notFoundIdx);
  });

  it("still serves 503 for an unreachable upstream, not a 404", () => {
    // US-2044. A revised certificate must not have blurred that distinction:
    // answering 404 for an outage deindexes real certificates.
    expect(source).toContain("upstreamUnavailableResponse()");
  });
});
