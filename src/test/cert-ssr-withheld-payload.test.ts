// US-3383 AC6: drive the certificate SSR page with a WITHHELD payload.
//
// isCertificateWithheld (services/edge-functions/src/lib/certificate-visibility.ts)
// is tested on the Deno side, and that is where the decision is made: a flagged
// or still-preliminary submission makes /api/content/public/certificates/:id
// answer 404 (content-public.ts, the US-484 gate). functions/cert/[id].ts cannot
// import that file, runs in a different runtime, and INHERITS the behaviour by
// trusting the shape of the upstream response. Nothing drove this page with such
// a payload, so the inheritance was assumed rather than checked.
//
// Read-only on functions/cert/[id].ts for this story (another agent owns it),
// so this drives the exported handler and asserts behaviour, not source text.
// That also makes it survive their edit.
//
// Two failure modes, opposite directions, both serious:
//   withheld served as a page  -> a forged or manipulated grade gets a public,
//                                 indexable, AI-citable certificate
//   unreachable served as a 404 -> a REAL certificate is deindexed by a blip,
//                                 and every shared cert link is a backlink

// NOTE ON THE IMPORT. functions/cert/[id].ts declares PagesFunction and
// EventContext, Workers globals only tsconfig.functions.json provides, so a
// static import pulls the module into the app project and fails `tsc -b`. The
// specifier is assembled at runtime so TypeScript does not follow it; vitest
// resolves it. Same idiom as src/test/llms-txt-upstream-failure.test.ts.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PagesEnv } from "../../functions/_shared/blog-render";

type Handler = (context: unknown) => Promise<Response>;

let onRequestGet: Handler;

beforeAll(async () => {
  const specifier = "../../functions/cert/" + "[id]";
  const mod = (await import(/* @vite-ignore */ specifier)) as {
    onRequestGet: Handler;
  };
  onRequestGet = mod.onRequestGet;
});

const ENV: PagesEnv = {
  PUBLIC_SITE_URL: "https://gradethread.com",
  EDGE_API_URL: "https://functions.gradethread.com",
};

const CERT_ID = "11111111-2222-3333-4444-555555555555";

// A complete, renderable certificate, used to prove the page DOES render when
// the upstream says yes. Without this half, "always 404" would pass.
const LIVE_CERT = {
  certificate: {
    id: CERT_ID,
    certificate_number: "GT-000123",
    title: "Vintage Carhartt Detroit Jacket",
    brand: "Carhartt",
    garment_type: "jacket",
    garment_category: "outerwear",
    description: "Worn but honest.",
    overall_score: 8.4,
    grade_tier: "Very Good",
    fabric_condition_score: 8.5,
    structural_integrity_score: 8.5,
    cosmetic_appearance_score: 8.0,
    functional_elements_score: 8.5,
    odor_cleanliness_score: 8.5,
    ai_summary: "Even fade, no structural faults.",
    buyer_writeup: null,
    created_at: "2026-02-01T00:00:00.000Z",
    hero_image_url: "https://cdn.example.test/hero.jpg",
    images: [],
  },
};

// What a withheld certificate must never leak. If any of this reaches the HTML,
// the moderation gate has been rendered around rather than enforced.
const WITHHELD_MARKERS = [
  "Vintage Carhartt Detroit Jacket",
  "GT-000123",
  "Very Good",
  "8.4",
];

function run(env: PagesEnv = ENV): Promise<Response> {
  return onRequestGet({
    request: new Request(`https://gradethread.com/cert/${CERT_ID}`),
    env,
    params: { id: CERT_ID },
    waitUntil: () => {},
  });
}

function stub(impl: () => Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => vi.restoreAllMocks());

describe("US-3383 AC6: withheld certificates never render a page", () => {
  it("a withheld cert (upstream 404) serves the branded 404, not a grade", async () => {
    // This is the literal wire shape of the US-484 gate: the public endpoint
    // returns `{ error: "Not found" }` with a 404 for a flagged or
    // pending_review submission, exactly as it does for one that never existed.
    const spy = stub(
      async () =>
        new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
    );
    const res = await run();
    expect(spy, "the page never called the upstream").toHaveBeenCalledTimes(1);
    expect(res.status).toBe(404);

    const html = await res.text();
    expect(html).toContain("Certificate not found");
    // noindex, or a withheld certificate still earns a search result.
    expect(html.toLowerCase()).toContain("noindex");
    for (const marker of WITHHELD_MARKERS) {
      expect(html, `withheld certificate leaked "${marker}"`).not.toContain(marker);
    }
  });

  it("an upstream 200 carrying no certificate is also a 404", async () => {
    // The second shape the page has to survive: a 200 whose body does not hold
    // a certificate. `!data?.certificate` is the only thing standing between
    // that and a render against undefined.
    stub(
      async () => new Response(JSON.stringify({ certificate: null }), { status: 200 }),
    );
    const res = await run();
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("Certificate not found");
    expect(html.toLowerCase()).toContain("noindex");
  });

  it("an empty 200 body does not render a half-certificate", async () => {
    stub(async () => new Response("{}", { status: 200 }));
    const res = await run();
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Certificate not found");
  });

  it("a malformed 200 body is a read failure, not an absence", async () => {
    // Cloudflare Pages answers a missing asset with the SPA shell: a 200 whose
    // body is HTML. Parsing that as "no certificate" would 404 a real cert.
    stub(async () => new Response("<!doctype html><html></html>", { status: 200 }));
    const res = await run();
    expect(
      res.status,
      "unparseable is 'we could not read the answer', which is a 503",
    ).toBe(503);
  });

  it("WITHHELD and UNREACHABLE are different answers", async () => {
    // The asymmetry that makes this worth a test. 404 deindexes; 503 makes
    // Googlebot back off and KEEP the URL. Serving 404 for an outage would
    // drop real certificates, and certificates are the distribution flywheel.
    for (const status of [500, 502, 429, 403]) {
      stub(async () => new Response("upstream is unwell", { status }));
      const res = await run();
      expect(res.status, `upstream ${status} must not become a 404`).toBe(503);
      expect(res.headers.get("Retry-After")).toBeTruthy();
      expect((res.headers.get("Cache-Control") ?? "").toLowerCase()).toContain(
        "no-store",
      );
    }
  });

  it("a network error is a 503 too", async () => {
    stub(async () => {
      throw new TypeError("fetch failed");
    });
    expect((await run()).status).toBe(503);
  });

  it("a live certificate still renders, or 'never renders' is trivially true", async () => {
    const spy = stub(
      async () => new Response(JSON.stringify(LIVE_CERT), { status: 200 }),
    );
    const res = await run();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Vintage Carhartt Detroit Jacket");
    expect(html).toContain("8.4");
    expect(html).not.toContain("Certificate not found");
  });
});
