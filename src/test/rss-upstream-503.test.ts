// US-3383 AC4: /rss.xml answers 503 when it could not reach the upstream.
//
// This contract had NO test. That matters more than the usual missing-coverage
// complaint, because it is the precedent everything else cites:
// functions/_shared/sitemap.ts's fetchEdgeJson docstring says "rss.xml.ts was
// hardened against exactly this in US-2044", and
// src/test/sitemap-upstream-failure.test.ts repeats the claim in its header.
// Both point at a behaviour nothing was holding. Deleting the catch at
// functions/rss.xml.ts:56-57 was a silent change until this file existed.
//
// Driven through the exported handler rather than by grepping the source, so it
// holds whatever shape the file takes next: another agent is editing this tree
// today, and a regex assertion would only prove the string survived the edit.

// NOTE ON THE IMPORT. functions/rss.xml.ts declares PagesFunction, a Workers
// global only tsconfig.functions.json provides, so a static import pulls the
// module into the app project and fails `tsc -b`. The specifier is assembled at
// runtime so TypeScript does not follow it; vitest resolves it. Same idiom as
// src/test/llms-txt-upstream-failure.test.ts.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PagesEnv } from "../../functions/_shared/blog-render";

type Handler = (context: unknown) => Promise<Response>;

let onRequestGet: Handler;

beforeAll(async () => {
  const specifier = "../../functions/" + "rss.xml";
  const mod = (await import(/* @vite-ignore */ specifier)) as {
    onRequestGet: Handler;
  };
  onRequestGet = mod.onRequestGet;
});

const ENV: PagesEnv = {
  PUBLIC_SITE_URL: "https://gradethread.com",
  EDGE_API_URL: "https://functions.gradethread.com",
};

const POST = {
  slug: "how-to-grade-a-hoodie",
  title: "How to grade a hoodie",
  excerpt: "A worked example.",
  published_at: "2026-01-02T03:04:05.000Z",
  hero_image_url: "https://cdn.example.test/hero.jpg",
  author: "Dj Pearson",
  tags: ["grading"],
  primary_keyword: "condition grading",
};

function context() {
  return {
    request: new Request("https://gradethread.com/rss.xml"),
    env: ENV,
    waitUntil: () => {},
  } as never;
}

const run = () => onRequestGet(context());

afterEach(() => vi.restoreAllMocks());

describe("US-3383 AC4: /rss.xml and the upstream", () => {
  it("answers 503, not an empty 200 feed, when the upstream is unreachable", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await run();
    // Prove the stub was actually reached, or a 503 from somewhere else would
    // read as a pass.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    // A 503 that gets cached is worse than the uncached behaviour it replaced:
    // one blip would pin "temporarily unavailable" on the feed for the TTL.
    expect((res.headers.get("Cache-Control") ?? "").toLowerCase()).toContain(
      "no-store",
    );
    // And it must not be XML a reader would accept as a feed with no items.
    const body = await res.text();
    expect(body).not.toContain("<rss");
    expect(body).not.toContain("<channel>");
  });

  it("answers 503 on an upstream 5xx as well as on a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream is unwell", { status: 500 })),
    );
    const res = await run();
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("<rss");
  });

  it("answers 503 on a 429 from the public rate limiter", async () => {
    // Not hypothetical: the edge caps /api/content/public/* at 60/min per IP,
    // fail-closed, and every SSR surface reaches it through one Pages worker.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("slow down", { status: 429 })),
    );
    expect((await run()).status).toBe(503);
  });

  it("answers 503 on a 403, which is what a rotated origin secret looks like", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 403 })),
    );
    expect((await run()).status).toBe(503);
  });

  it("a 404 is a real answer and still serves a valid, empty feed", async () => {
    // The other half of the contract, and the half that keeps the 503 honest:
    // if EVERY non-200 became a 503 the feed would be down whenever the blog
    // genuinely had no index. 404 means "no such collection".
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    const res = await run();
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<rss");
    expect(body).toContain("<channel>");
    expect(body).not.toContain("<item>");
  });

  it("serves the feed on a healthy upstream (the guard is not just 'always 503')", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ posts: [POST] }), { status: 200 }),
      ),
    );
    const res = await run();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/rss+xml");
    const body = await res.text();
    expect(body).toContain("<item>");
    expect(body).toContain("How to grade a hoodie");
    expect(body).toContain("https://gradethread.com/blog/how-to-grade-a-hoodie");
  });
});
