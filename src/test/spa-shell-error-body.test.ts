import { describe, expect, it } from "vitest";
import { serveSpaShell } from "../../functions/_shared/spa-shell";
import type { PagesEnv } from "../../functions/_shared/blog-render";

// US-3384. serveSpaShell never checked the Response from ASSETS.fetch. A non-2xx
// shell got the robots regex applied (matching nothing), the bootstrap hash
// computed over it, and was served as a 200 with the full app security headers,
// across sixteen route groups — /login, /signup, /dashboard/**, /admin/**,
// /auth/**, /claim/**, /buyer/**, /capture/**, /connect/**, /t/**, /trust/**,
// /accept-invite, /waitlist-pending, /buyer-guarantee/claim, /connect-extension
// and the embed. The same call in blog-render.ts checks `.ok` and catches; this
// is that shape, and these tests drive it rather than reading the source.
const request = () => new Request("https://gradethread.com/dashboard/items");

const shellEnv = (fetchImpl: () => Promise<Response>): PagesEnv => ({
  PUBLIC_SITE_URL: "https://gradethread.com",
  ASSETS: { fetch: fetchImpl },
});

const OK_SHELL =
  '<!doctype html><html><head><meta name="robots" content="index, follow">' +
  '<title>GradeThread</title></head><body><div id="root"></div></body></html>';

describe("the SPA shell never serves an error body as a success", () => {
  it("still serves the shell with a 200 when the asset fetch succeeds", async () => {
    const res = await serveSpaShell(
      request(),
      shellEnv(async () => new Response(OK_SHELL, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div id="root">');
    // The app routes stay out of the index, which is the US-2045 rule.
    expect(html).toContain('content="noindex, nofollow"');
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    // US-2330: the security headers are only applied here, so prove they survive.
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
  });

  for (const status of [404, 500, 503]) {
    it(`answers 503, not 200, when the shell asset returns ${status}`, async () => {
      const res = await serveSpaShell(
        request(),
        shellEnv(async () =>
          new Response(`<html><body>asset server error ${status}</body></html>`, {
            status,
            headers: { "content-type": "text/html" },
          })
        ),
      );
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("60");
      expect(res.headers.get("cache-control")).toBe("no-store");
      // The error body must not reach the reader dressed as the app.
      expect(await res.text()).not.toContain("asset server error");
    });
  }

  it("answers 503 when the asset fetch throws", async () => {
    const res = await serveSpaShell(
      request(),
      shellEnv(() => Promise.reject(new Error("binding exploded"))),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("x-gt-shell")).toBe("fetch threw");
  });

  it("answers 503 when the shell body cannot be read", async () => {
    const unreadable = new Response(OK_SHELL, { status: 200 });
    Object.defineProperty(unreadable, "text", {
      value: () => Promise.reject(new Error("stream aborted")),
    });
    const res = await serveSpaShell(request(), shellEnv(async () => unreadable));
    expect(res.status).toBe(503);
    expect(res.headers.get("x-gt-shell")).toBe("body unreadable");
  });

  it("answers 503 when the ASSETS binding is missing entirely", async () => {
    const res = await serveSpaShell(request(), { PUBLIC_SITE_URL: "https://gradethread.com" });
    expect(res.status).toBe(503);
    expect(res.headers.get("x-gt-shell")).toBe("binding missing");
  });
});
