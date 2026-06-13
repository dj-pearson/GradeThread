import { describe, it, expect, afterEach } from "vitest";
import { withEdgeCache } from "../../functions/_shared/blog-render";

// US-577: read-through Cloudflare edge cache for the SSR HTML surfaces
// (/cert/*, /verified/:handle, blog). The Cache API is what turns an
// otherwise-uncached Pages Function response into a real edge HIT; these tests
// pin the HIT/MISS contract and the safety guards against caching the wrong
// thing.

const SSR_CACHE_CONTROL =
  "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";

// A tiny in-memory stand-in for Cloudflare's `caches.default`.
class FakeCache {
  store = new Map<string, Response>();
  async match(req: Request): Promise<Response | undefined> {
    const hit = this.store.get(req.url);
    return hit ? hit.clone() : undefined;
  }
  async put(req: Request, res: Response): Promise<void> {
    this.store.set(req.url, res.clone());
  }
}

function installCache(cache: FakeCache) {
  (globalThis as { caches?: unknown }).caches = { default: cache };
}

function makeCtx(url: string, method = "GET") {
  const waited: Promise<unknown>[] = [];
  return {
    request: new Request(url, { method }),
    waitUntil: (p: Promise<unknown>) => void waited.push(p),
    waited,
  };
}

afterEach(() => {
  delete (globalThis as { caches?: unknown }).caches;
});

describe("withEdgeCache", () => {
  it("MISS then HIT on a repeat request to the same path", async () => {
    installCache(new FakeCache());
    let renders = 0;
    const build = async () => {
      renders++;
      return new Response("<html>cert</html>", {
        status: 200,
        headers: { "Cache-Control": SSR_CACHE_CONTROL },
      });
    };

    const ctx1 = makeCtx("https://gradethread.com/cert/abc");
    const first = await withEdgeCache(ctx1, build);
    expect(first.headers.get("x-gt-cache")).toBe("MISS");
    await Promise.all(ctx1.waited); // let the cache.put settle

    const second = await withEdgeCache(
      makeCtx("https://gradethread.com/cert/abc"),
      build,
    );
    expect(second.headers.get("x-gt-cache")).toBe("HIT");
    expect(await second.text()).toBe("<html>cert</html>");
    expect(renders).toBe(1); // the HIT did not re-render
  });

  it("ignores the query string so utm-tagged share links share one entry", async () => {
    installCache(new FakeCache());
    const build = async () =>
      new Response("<html>shared</html>", {
        status: 200,
        headers: { "Cache-Control": SSR_CACHE_CONTROL },
      });

    const ctx1 = makeCtx("https://gradethread.com/cert/abc");
    await withEdgeCache(ctx1, build);
    await Promise.all(ctx1.waited);

    const hit = await withEdgeCache(
      makeCtx("https://gradethread.com/cert/abc?utm_source=twitter"),
      build,
    );
    expect(hit.headers.get("x-gt-cache")).toBe("HIT");
  });

  it("does not cache private/no-store responses (e.g. blog preview)", async () => {
    installCache(new FakeCache());
    const build = async () =>
      new Response("<html>draft</html>", {
        status: 200,
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      });

    const ctx = makeCtx("https://gradethread.com/blog/preview/secret");
    const res = await withEdgeCache(ctx, build);
    expect(res.headers.get("x-gt-cache")).toBeNull(); // untouched, not stored
    expect(ctx.waited).toHaveLength(0);
  });

  it("does not cache error responses", async () => {
    installCache(new FakeCache());
    const build = async () =>
      new Response("nope", { status: 404 });
    const ctx = makeCtx("https://gradethread.com/cert/missing");
    const res = await withEdgeCache(ctx, build);
    expect(res.status).toBe(404);
    expect(res.headers.get("x-gt-cache")).toBeNull();
    expect(ctx.waited).toHaveLength(0);
  });

  it("renders directly (no caching) when the Cache API is unavailable", async () => {
    // No caches global installed → degrade gracefully for local/preview runs.
    let renders = 0;
    const build = async () => {
      renders++;
      return new Response("<html>x</html>", {
        status: 200,
        headers: { "Cache-Control": SSR_CACHE_CONTROL },
      });
    };
    const res = await withEdgeCache(makeCtx("https://gradethread.com/cert/x"), build);
    expect(res.headers.get("x-gt-cache")).toBeNull();
    expect(renders).toBe(1);
  });

  it("never caches non-GET requests", async () => {
    installCache(new FakeCache());
    const build = async () =>
      new Response("ok", {
        status: 200,
        headers: { "Cache-Control": SSR_CACHE_CONTROL },
      });
    const ctx = makeCtx("https://gradethread.com/cert/abc", "POST");
    const res = await withEdgeCache(ctx, build);
    expect(res.headers.get("x-gt-cache")).toBeNull();
    expect(ctx.waited).toHaveLength(0);
  });
});
