import { describe, it, expect } from "vitest";
import { certNotFoundResponse } from "../../functions/cert/cert-not-found";
import { notFoundResponse, type PagesEnv } from "../../functions/_shared/blog-render";

// US-1945 AC2: a made-up / unresolvable /cert/:id must return a DISTINCT,
// cert-branded "certificate not found" page — never the old blog 404 ("That
// post doesn't exist… Back to the blog") and never byte-identical to the
// generic default 404. Otherwise a buyer cannot tell a genuine-but-missing
// certificate from a forgery, which is the whole point of a verifiable cert.
//
// certNotFoundResponse is the exact 404 the cert Pages Function serves when the
// public certificate lookup returns nothing.

const env: PagesEnv = { PUBLIC_SITE_URL: "https://gradethread.com" };

async function bodyOf(res: Response): Promise<string> {
  return await res.text();
}

describe("cert SSR 404 (US-1945 AC2)", () => {
  it("returns a 404 with cert-branded copy", async () => {
    const res = certNotFoundResponse(env);
    expect(res.status).toBe(404);
    const html = await bodyOf(res);
    expect(html).toContain("Certificate not found");
    expect(html).toContain("could not be found or verified");
    // Points the buyer somewhere cert-relevant, not the blog.
    expect(html).toContain("Browse verified sellers");
  });

  it("never serves the old blog 404 copy", async () => {
    const html = (await bodyOf(certNotFoundResponse(env))).toLowerCase();
    expect(html).not.toContain("that post doesn't exist");
    expect(html).not.toContain("back to the blog");
    expect(html).not.toContain("go to the blog");
  });

  it("is noindex so a 404 can never rank as a certificate", async () => {
    const html = await bodyOf(certNotFoundResponse(env));
    expect(html).toContain("noindex");
  });

  it("is NOT byte-identical to the generic default 404 (genuine vs forged is distinguishable)", async () => {
    const certHtml = await bodyOf(certNotFoundResponse(env));
    const genericHtml = await bodyOf(notFoundResponse(env));
    expect(certHtml).not.toBe(genericHtml);
    // The generic default carries its own copy; the cert page must not.
    expect(genericHtml).toContain("couldn't find that page");
    expect(certHtml).not.toContain("couldn't find that page");
  });
});
