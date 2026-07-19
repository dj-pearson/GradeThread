// US-2096: the certificate sitemap must follow next_cursor to exhaustion.
//
// certUrls() made ONE unparameterised request to /certificates.json and dropped
// next_cursor on the floor. The endpoint defaults to limit=1000, so the sitemap
// silently stopped at the first 1,000 certificates — a growth ceiling that
// reported itself as success: a well-formed 200, no error, no log line.
// Certificates are the highest-volume indexable asset class in the product.
//
// These tests drive certUrls() against a mocked multi-page cursor rather than
// asserting on source text, so they fail if the loop is ever unwound.

import { describe, expect, it, vi, afterEach } from "vitest";
import { certUrls } from "../../functions/_shared/sitemap";

const ENV = {
  SITE_URL: "https://gradethread.com",
  EDGE_API_URL: "https://functions.gradethread.com",
} as never;

/** Serve `pages` in order, keyed by the cursor the client sends back. */
function mockCertPages(pages: Array<{ ids: string[]; next: string | null }>) {
  const seen: Array<string | null> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const cursor = new URL(url).searchParams.get("cursor");
      seen.push(cursor);
      const page = pages[seen.length - 1];
      if (!page) throw new Error(`certUrls requested page ${seen.length}, more than mocked`);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          certificates: page.ids.map((id) => ({
            id,
            updated_at: "2026-01-01T00:00:00Z",
          })),
          next_cursor: page.next,
        }),
      } as never;
    }),
  );
  return { seen };
}

afterEach(() => vi.unstubAllGlobals());

describe("US-2096: certificate sitemap pagination", () => {
  it("returns URLs from EVERY page, not just the first", async () => {
    mockCertPages([
      { ids: ["a1", "a2"], next: "2026-03-01T00:00:00Z" },
      { ids: ["b1", "b2"], next: "2026-02-01T00:00:00Z" },
      { ids: ["c1"], next: null },
    ]);

    const urls = await certUrls(ENV);

    expect(
      urls.map((u) => u.loc),
      "dropping next_cursor silently capped this at page one",
    ).toEqual([
      "https://gradethread.com/cert/a1",
      "https://gradethread.com/cert/a2",
      "https://gradethread.com/cert/b1",
      "https://gradethread.com/cert/b2",
      "https://gradethread.com/cert/c1",
    ]);
  });

  it("sends each page's cursor back on the next request", async () => {
    const { seen } = mockCertPages([
      { ids: ["a1"], next: "CURSOR_1" },
      { ids: ["b1"], next: "CURSOR_2" },
      { ids: ["c1"], next: null },
    ]);

    await certUrls(ENV);

    // First request carries no cursor; each subsequent one echoes the previous
    // page's next_cursor. A loop that refetched page one would show [null,null,…].
    expect(seen).toEqual([null, "CURSOR_1", "CURSOR_2"]);
  });

  it("stops when the cursor fails to advance", async () => {
    // A duplicate created_at or an upstream bug must not spin the edge forever.
    mockCertPages(
      Array.from({ length: 5 }, () => ({ ids: ["dup"], next: "STUCK" })),
    );

    const urls = await certUrls(ENV);

    // Page 1 (cursor=null) then page 2 (cursor=STUCK, whose next is STUCK again).
    expect(urls.length).toBe(2);
  });

  it("requests the endpoint's maximum page size", async () => {
    let requested: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requested = new URL(url).searchParams.get("limit");
        return {
          ok: true,
          status: 200,
          json: async () => ({ certificates: [], next_cursor: null }),
        } as never;
      }),
    );

    await certUrls(ENV);

    // The endpoint caps limit at 5000; asking for less just means more
    // round trips at the edge for the same result.
    expect(requested).toBe("5000");
  });
});
