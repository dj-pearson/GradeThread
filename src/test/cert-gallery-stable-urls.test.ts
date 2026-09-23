import { afterEach, describe, expect, it, vi } from "vitest";
import type { PagesEnv } from "../../functions/_shared/blog-render";

// grading.md action 5. The certificate SSR gallery wrote cert.images[].url
// straight into the HTML. Those urls are storage urls signed for 15 minutes
// (CERT_IMAGE_TTL, content-public.ts), and the page is served with
// SSR_CACHE_CONTROL (s-maxage=3600, stale-while-revalidate=86400) and stored by
// withEdgeCache. So every cached render older than 15 minutes showed crawlers,
// no-JS viewers and the pre-hydration paint a grid of 403s.
//
// This drives the real renderer against a stubbed upstream whose photo urls
// look exactly like Supabase signed urls, and reads the body it produced.
//
// The specifier is built at runtime on purpose: a static import of
// functions/cert/[id].ts pulls Workers globals into the app project and breaks
// `tsc -b` (same idiom as cert-noindex-incomplete-read.test.ts).
const loadCertRenderer = () =>
  import(/* @vite-ignore */ "../../functions/cert/" + "[id]") as Promise<{
    renderCertificate: (context: unknown) => Promise<Response>;
  }>;

const CERT_ID = "6d0d0f7a-23db-41f2-a891-5245e89eb504";
const SIGNED_BASE =
  "https://api.gradethread.com/storage/v1/object/sign/submission-images/u1/s1";

const env: PagesEnv = {
  PUBLIC_SITE_URL: "https://gradethread.com",
  EDGE_API_URL: "https://functions.example.invalid",
};

function signed(name: string): string {
  return `${SIGNED_BASE}/${name}.jpg?token=eyJhbGciOiJIUzI1NiJ9.sig-${name}`;
}

const payload = {
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
    hero_image_url: signed("front"),
    images: [
      { id: "i0", image_type: "front", display_order: 0, url: signed("front") },
      { id: "i1", image_type: "back", display_order: 1, url: signed("back") },
      { id: "i2", image_type: "label", display_order: 2, url: signed("label") },
    ],
  },
};

async function renderBody(): Promise<string> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ),
  );
  const { renderCertificate } = await loadCertRenderer();
  const res = await renderCertificate({
    request: new Request(`https://gradethread.com/cert/${CERT_ID}`),
    env,
    params: { id: CERT_ID },
    waitUntil: () => {},
  });
  expect(res.status).toBe(200);
  return await res.text();
}

describe("certificate SSR gallery uses stable photo urls (grading.md action 5)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("puts no signed url, token or signed query string anywhere in the cached body", async () => {
    const body = await renderBody();
    expect(body).not.toContain("token=");
    expect(body).not.toContain("/object/sign/");
    expect(body).not.toContain(SIGNED_BASE);
  });

  it("links every gallery photo to /cert-photo/<id>/<n> in display order, with no query", async () => {
    const body = await renderBody();
    const gallery = body.match(/<div class="cert-gallery">([\s\S]*?)<\/div>/);
    expect(gallery).not.toBeNull();
    const grid = gallery?.[1] ?? "";
    const srcs = [...grid.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]);
    const hrefs = [...grid.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
    const expected = [0, 1, 2].map((n) => `/cert-photo/${CERT_ID}/${n}`);
    expect(srcs).toEqual(expected);
    expect(hrefs).toEqual(expected);
  });
});
