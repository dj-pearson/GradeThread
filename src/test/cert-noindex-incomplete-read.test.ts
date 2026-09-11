import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SSR_CACHE_CONTROL,
  withEdgeCache,
  type PagesEnv,
} from "../../functions/_shared/blog-render";

// US-3384. `noindex: !cert.hero_image_url` was a decision made from a field that
// two swallowed errors upstream could null out, so a transient storage-signing
// or table-read failure put `noindex` on a REAL certificate, dropped its
// shareable slab image and its whole photo gallery — and then the answer was
// served 200 with `s-maxage=3600, stale-while-revalidate=86400` and stored by
// withEdgeCache, which turns one bad second into a day of bad certificate.
//
// These tests DRIVE the renderer. They are not a check that `error` is
// destructured somewhere: each case runs functions/cert/[id].ts against a
// stubbed upstream and reads the status, the robots meta and the Cache-Control
// off the Response it actually produced.
//
// WHY THE SPECIFIER IS BUILT AT RUNTIME: functions/cert/[id].ts declares
// PagesFunction handlers, a Workers global that tsconfig.app.json does not load.
// A static import would pull the module into the app project and break
// `tsc -b` for all of src/ (exactly what functions/llms.txt.ts does when a test
// imports it literally). The concatenation is load-bearing; do not "tidy" it.
const loadCertRenderer = () =>
  import(/* @vite-ignore */ "../../functions/cert/" + "[id]") as Promise<{
    renderCertificate: (context: unknown) => Promise<Response>;
  }>;

const CERT_ID = "6d0d0f7a-23db-41f2-a891-5245e89eb504";

const env: PagesEnv = {
  PUBLIC_SITE_URL: "https://gradethread.com",
  EDGE_API_URL: "https://functions.example.invalid",
};

function certificate(over: Record<string, unknown>) {
  return {
    certificate: {
      id: CERT_ID,
      certificate_number: "GT-2026-000123",
      title: "Levi's 501 Straight Jeans",
      brand: "Levi's",
      garment_type: "jeans",
      garment_category: "bottoms",
      description: null,
      overall_score: 8.5,
      grade_tier: "Excellent",
      fabric_condition_score: 8.5,
      structural_integrity_score: 9,
      cosmetic_appearance_score: 8,
      functional_elements_score: 8.5,
      odor_cleanliness_score: 8,
      ai_summary: "Light, even wear across the garment.",
      buyer_writeup: null,
      created_at: "2026-09-01T00:00:00.000Z",
      hero_image_url: null,
      images: [],
      ...over,
    },
  };
}

/** The upstream answers 200 with this body, like the edge does. */
function stubUpstream(body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ),
  );
}

function context(): { request: Request; env: PagesEnv; params: { id: string }; waitUntil: (p: Promise<unknown>) => void } {
  return {
    request: new Request(`https://gradethread.com/cert/${CERT_ID}`),
    env,
    params: { id: CERT_ID },
    waitUntil: () => {},
  };
}

async function render(body: unknown): Promise<Response> {
  stubUpstream(body);
  const { renderCertificate } = await loadCertRenderer();
  return await renderCertificate(context());
}

const robotsOf = (html: string): string | null =>
  html.match(/<meta\s+name="robots"\s+content="([^"]+)"/i)?.[1] ?? null;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a certificate page never claims 'thin' from a read that failed (AC1)", () => {
  it("indexes and caches a certificate whose photos resolved", async () => {
    const res = await render(
      certificate({
        hero_image_url: "https://storage.example.invalid/front.jpg?token=abc",
        photos_unavailable: false,
        images: [
          {
            id: "img-1",
            image_type: "front",
            display_order: 0,
            url: "https://storage.example.invalid/front.jpg?token=abc",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(robotsOf(await res.text())).toBe("index, follow");
    expect(res.headers.get("Cache-Control")).toBe(SSR_CACHE_CONTROL);
  });

  it("still noindexes a certificate that genuinely has no photos (US-1665 AC4 intact)", async () => {
    // The read SUCCEEDED and came back empty. This page really is thin, and
    // keeping it out of the index is the rule this story must not break while
    // fixing the case next door.
    const res = await render(
      certificate({ hero_image_url: null, photos_unavailable: false, images: [] }),
    );
    expect(res.status).toBe(200);
    expect(robotsOf(await res.text())).toBe("noindex, nofollow");
    expect(res.headers.get("Cache-Control")).toBe(SSR_CACHE_CONTROL);
  });

  it("does NOT noindex when the upstream says the photo read failed", async () => {
    // Same null hero as the case above, different meaning. Absent and unknown
    // are different answers, and this is the whole defect.
    const res = await render(
      certificate({ hero_image_url: null, photos_unavailable: true, images: [] }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(robotsOf(html)).toBe("index, follow");
    // The certificate itself still renders: the grade is what a buyer came for.
    expect(html).toContain("8.5");
  });

  it("treats a payload with no photos_unavailable field exactly as it did before", async () => {
    // Deploy order: Pages ships separately from the edge, so a Pages build can
    // be live against an edge that predates the field. Absent must read false.
    const body = certificate({ hero_image_url: null, images: [] }) as {
      certificate: Record<string, unknown>;
    };
    delete body.certificate.photos_unavailable;
    const res = await render(body);
    expect(robotsOf(await res.text())).toBe("noindex, nofollow");
  });
});

describe("an incomplete certificate render is never stored (AC2)", () => {
  it("serves it no-store, so withEdgeCache refuses to keep it", async () => {
    const res = await render(
      certificate({ hero_image_url: null, photos_unavailable: true, images: [] }),
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    // s-maxage + stale-while-revalidate is what turns one transient failure
    // into a day of it. Neither may survive on this path.
    expect(res.headers.get("Cache-Control")).not.toContain("s-maxage");
    expect(res.headers.get("Cache-Control")).not.toContain("stale-while-revalidate");
  });

  it("proves it through the real edge cache: put() is called for a good render and not for an incomplete one", async () => {
    const { renderCertificate } = await loadCertRenderer();
    const put = vi.fn(async () => {});
    vi.stubGlobal("caches", {
      default: { match: async () => undefined, put },
    });

    const good = certificate({
      hero_image_url: "https://storage.example.invalid/front.jpg?token=abc",
      photos_unavailable: false,
      images: [
        {
          id: "img-1",
          image_type: "front",
          display_order: 0,
          url: "https://storage.example.invalid/front.jpg?token=abc",
        },
      ],
    });
    stubUpstream(good);
    const ctx = context();
    await withEdgeCache(ctx, () => renderCertificate(ctx));
    expect(put).toHaveBeenCalledTimes(1);

    put.mockClear();
    stubUpstream(certificate({ hero_image_url: null, photos_unavailable: true, images: [] }));
    const ctx2 = context();
    await withEdgeCache(ctx2, () => renderCertificate(ctx2));
    expect(put).not.toHaveBeenCalled();
  });
});
