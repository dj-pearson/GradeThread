// US-3382: /llms.txt answers 503 rather than a shorter map.
//
// THE REPRODUCTION, measured 2026-09-11 before anything was changed, driving
// onRequestGet with a manifest built from the real 276-route registry:
//
//   manifest 200 / upstream 200 -> status 200, 281 entries, 64,167 bytes
//   manifest 500 / upstream 200 -> status 200,  13 entries,  1,988 bytes
//   manifest 500 / upstream 500 -> status 200,  13 entries,  1,988 bytes
//
// Live /llms.txt carried 311 entries the same morning. The 13 were a hand-
// written 8-route FALLBACK_ROUTES list plus whatever survived, served 200 with
// `public, max-age=3600` through withEdgeCache, which stores publicly-cacheable
// 200s. Answer engines poll this file because it claims to be the map of the
// site; a cached map with 8 of 276 destinations is worse than no map, which is
// the reasoning llms-full.txt.ts:33-53 already applies to the same class of
// failure.
//
// NOTE ON THE IMPORT. functions/llms.txt.ts declares PagesFunction, a Workers
// global that only tsconfig.functions.json provides, so a static import would
// pull the module into the app project and fail `tsc -b`. The specifier is
// assembled at runtime so TypeScript does not follow it; vitest resolves it.

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_ROUTES } from "../lib/seo/public-routes";

type Handler = (context: unknown) => Promise<Response>;

async function loadLlmsTxt(): Promise<Handler> {
  const specifier = "../../functions/" + "llms.txt";
  const mod = (await import(/* @vite-ignore */ specifier)) as {
    onRequestGet: Handler;
  };
  return mod.onRequestGet;
}

const MANIFEST = {
  routes: PUBLIC_ROUTES.map((r) => ({
    path: r.path,
    title: r.title,
    description: r.description,
    priority: r.priority,
  })),
};

const SECTION_PAYLOADS: Record<string, unknown> = {
  "certificates.json": { certificates: [{ id: "abc" }] },
  "sellers.json": { sellers: [{ handle: "demo" }] },
  "authors.json": { authors: [{ slug: "jane", name: "Jane Doe" }] },
  "public/posts": { posts: [{ slug: "a-post", title: "A post", excerpt: "x" }] },
  "public/help": {
    categories: [{ key: "k", title: "Getting started", slug: "getting-started", summary: "s" }],
    articles: [
      { slug: "first", title: "First", summary: "s", category_key: "k", sort_order: 1 },
    ],
  },
};

/** Which upstream to break, and how. */
interface Breakage {
  /** Substring of the URL to break. Omit for a fully healthy stub. */
  target?: string;
  status?: number;
  body?: string;
  network?: boolean;
}

function stub(breakage: Breakage = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      const broken = breakage.target && url.includes(breakage.target);
      if (broken) {
        if (breakage.network) throw new TypeError("fetch failed");
        if (breakage.body !== undefined) {
          return new Response(breakage.body, { status: 200 });
        }
        return new Response("upstream error", { status: breakage.status ?? 500 });
      }
      if (url.includes("/seo-manifest.json")) {
        return new Response(JSON.stringify(MANIFEST), { status: 200 });
      }
      for (const [needle, payload] of Object.entries(SECTION_PAYLOADS)) {
        if (url.includes(needle)) {
          return new Response(JSON.stringify(payload), { status: 200 });
        }
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

function context() {
  return {
    request: new Request("https://gradethread.com/llms.txt"),
    env: {} as Record<string, string>,
    waitUntil: () => {},
  };
}

async function get(breakage: Breakage = {}) {
  stub(breakage);
  const handler = await loadLlmsTxt();
  const res = await handler(context());
  const body = await res.text();
  return {
    status: res.status,
    body,
    entries: body.split("\n").filter((l) => l.startsWith("- [")).length,
    cacheControl: res.headers.get("Cache-Control") ?? "",
  };
}

afterEach(() => vi.restoreAllMocks());

describe("US-3382: /llms.txt refuses rather than shrinking", () => {
  it("serves the whole registry when every upstream answers", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.entries).toBeGreaterThanOrEqual(PUBLIC_ROUTES.length);
  });

  // The reproduction, inverted. Each of these used to be a 200 with 13 entries.
  for (const status of [500, 502, 429, 403]) {
    it(`answers 503 when the manifest returns ${status}`, async () => {
      const res = await get({ target: "/seo-manifest.json", status });
      expect(res.status).toBe(503);
    });
  }

  it("answers 503 when the manifest is unreachable", async () => {
    const res = await get({ target: "/seo-manifest.json", network: true });
    expect(res.status).toBe(503);
  });

  it("answers 503 when the manifest 200s with the SPA shell", async () => {
    const res = await get({
      target: "/seo-manifest.json",
      body: "<!doctype html><html><body>app</body></html>",
    });
    expect(res.status).toBe(503);
  });

  // A 404 is the one status that means "the build has not landed". It is still
  // not a document worth publishing: zero routes is below any floor.
  it("answers 503 when the manifest is absent", async () => {
    const res = await get({ target: "/seo-manifest.json", status: 404 });
    expect(res.status).toBe(503);
  });

  // AC5: all six read sites, not just the one the story named.
  for (const target of [
    "certificates.json",
    "sellers.json",
    "authors.json",
    "public/posts",
    "public/help",
  ]) {
    it(`answers 503 when ${target} fails`, async () => {
      const res = await get({ target, status: 500 });
      expect(res.status).toBe(503);
    });

    // ...but an empty collection is a real answer and must still serve. A new
    // install with no certificates is not an outage.
    it(`still serves 200 when ${target} reports no such collection`, async () => {
      const res = await get({ target, status: 404 });
      expect(res.status).toBe(200);
      expect(res.entries).toBeGreaterThanOrEqual(PUBLIC_ROUTES.length);
    });
  }

  // The load-bearing half: a cached wrong answer is worse than a slow one, and
  // withEdgeCache stores exactly one thing, a publicly-cacheable 200.
  it("the 503 is not storable", async () => {
    const res = await get({ target: "/seo-manifest.json", status: 500 });
    expect(res.status).toBe(503);
    expect(res.cacheControl).toContain("no-store");
    const cache = readFileSync(
      join(process.cwd(), "functions/_shared/blog-render.ts"),
      "utf8",
    );
    expect(cache).toMatch(/response\.status !== 200[\s\S]{0,160}return response/);
  });
});

// ---------------------------------------------------------------------------
// AC6. The header claimed two things that were not true of the code under it,
// and the second claim is why nobody looked at the first.
describe("US-3382: the llms.txt header describes the code under it", () => {
  const src = readFileSync(join(process.cwd(), "functions/llms.txt.ts"), "utf8");

  /**
   * Comments stripped, because the header now DISCUSSES the names it used to
   * ship (FALLBACK_ROUTES, fetchJsonSafe) and a naive grep would read that
   * discussion as the code still being there.
   *
   * The stripper is asserted to have done something. This tree mixes CRLF and
   * LF, and a stripper that silently matches nothing is the failure mode that
   * makes a guard pass against broken code.
   */
  const code = (() => {
    const normalized = src.replace(/\r\n/g, "\n");
    const stripped = normalized
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .join("\n");
    expect(stripped.length, "the comment stripper matched nothing").toBeLessThan(
      normalized.length,
    );
    expect(stripped, "the comment stripper ate the code").toContain(
      "export const onRequestGet",
    );
    return stripped;
  })();

  it("carries no hand-written route list", () => {
    expect(
      code,
      "FALLBACK_ROUTES was an 8-route hand-curated list shipping under a header " +
        "that said the list was no longer hand-curated",
    ).not.toContain("FALLBACK_ROUTES");
  });

  it("has no silent degradation left: every read either throws or is a 404", () => {
    expect(code).not.toContain("fetchJsonSafe");
    expect(code).toContain("UpstreamUnavailable");
    expect(code).toContain("upstreamUnavailableResponse()");
  });

  // AC6: the header may name a guard only if that guard drives THIS function.
  // The claim it used to make named src/test/llms-txt.test.ts, which renders
  // buildLlmsSections() with PUBLIC_ROUTES handed to it: a guard on the
  // serializer, which never imported this file and could not see what it
  // served. That is what let the 8-route fallback ship unnoticed.
  it("names a guard that actually drives onRequestGet", () => {
    const named = [...src.matchAll(/src\/test\/([\w.-]+\.test\.ts)/g)].map((m) => m[1]!);
    expect(named.length, "the header names no guard at all").toBeGreaterThan(0);
    const covering = named.filter((f) => {
      const guard = readFileSync(join(process.cwd(), "src/test", f), "utf8");
      return guard.includes("onRequestGet") && guard.includes("functions/llms.txt");
    });
    expect(
      covering,
      `none of the tests named in the header (${named.join(", ")}) drives ` +
        `functions/llms.txt.ts, so the header is claiming a guard that does ` +
        `not exist`,
    ).not.toEqual([]);
  });
});
