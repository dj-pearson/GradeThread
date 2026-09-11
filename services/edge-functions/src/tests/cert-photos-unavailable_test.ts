// US-3384: a failed photo read is not a photoless certificate.
//
// GET /certificates/:id dropped the error on BOTH reads behind hero_image_url —
// the submission_images select and the createSignedUrl inside the gallery
// mapper. The null they produced is the same null a certificate with no photos
// produces, and functions/cert/[id].ts turns that null into `noindex`, then the
// Pages edge cache stores the result for an hour with a day of
// stale-while-revalidate behind it. One transient failure, a day of a real
// certificate telling Google not to index it.
//
// These DRIVE the route: a stubbed PostgREST/storage layer fails one read at a
// time and the assertions read the JSON the route actually returned.
//
//   deno test --allow-net --allow-env --allow-read src/tests/cert-photos-unavailable_test.ts

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";

const CERT_ID = "6d0d0f7a-23db-41f2-a891-5245e89eb504";
const SUBMISSION_ID = "1c2b7f10-0b3e-4c2a-9f77-0a3f0c6d5e11";

type Mode = "ok" | "images-error" | "sign-error" | "no-photos" | "submission-error";
let mode: Mode = "ok";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A PostgREST failure, shaped the way supabase-js expects one. */
function pgError(message: string): Response {
  return json({ code: "XX000", message, details: null, hint: null }, 500);
}

const REPORT_ROW = {
  certificate_id: CERT_ID,
  submission_id: SUBMISSION_ID,
  overall_score: 8.5,
  grade_tier: "Excellent",
  fabric_condition_score: 8.5,
  structural_integrity_score: 9,
  cosmetic_appearance_score: 8,
  functional_elements_score: 8.5,
  odor_cleanliness_score: 8,
  ai_summary: "Light, even wear.",
  created_at: "2026-09-01T00:00:00.000Z",
};

const SUBMISSION_ROW = {
  user_id: null,
  title: "Levi's 501 Straight Jeans",
  brand: "Levi's",
  garment_type: "jeans",
  garment_category: "bottoms",
  description: null,
  flagged: false,
  moderation_status: null,
  status: "completed",
  seller_statements: null,
};

const IMAGE_ROWS = [
  {
    id: "9a5f2f6e-1f3a-4a0b-9e42-0d4b6b2f4c01",
    storage_path: `${SUBMISSION_ID}/front.jpg`,
    image_type: "front",
    display_order: 0,
  },
  {
    id: "9a5f2f6e-1f3a-4a0b-9e42-0d4b6b2f4c02",
    storage_path: `${SUBMISSION_ID}/back.jpg`,
    image_type: "back",
    display_order: 1,
  },
];

// supabaseAdmin binds fetch on first use, so one stub installed before the route
// module loads serves every test in this file.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const wantsObject = (new Headers(init?.headers).get("Accept") ?? "").includes("object");
  const rows = (list: unknown[]) => json(wantsObject ? list[0] ?? null : list);

  if (url.includes("/storage/v1/object/sign/")) {
    if (mode === "sign-error") return Promise.resolve(json({ message: "signing failed" }, 500));
    const path = url.split("/storage/v1/object/sign/submission-images/")[1] ?? "x";
    return Promise.resolve(json({ signedURL: `/object/sign/submission-images/${path}?token=t` }));
  }
  if (url.includes("/rest/v1/submission_images")) {
    if (mode === "images-error") return Promise.resolve(pgError("could not read submission_images"));
    return Promise.resolve(rows(mode === "no-photos" ? [] : IMAGE_ROWS));
  }
  if (url.includes("/rest/v1/submissions")) {
    if (mode === "submission-error") return Promise.resolve(pgError("could not read submissions"));
    return Promise.resolve(rows([SUBMISSION_ROW]));
  }
  if (url.includes("/rest/v1/grade_reports")) {
    if (url.includes("per_image_analysis")) {
      return Promise.resolve(rows([{ per_image_analysis: null, limiting_flaw: null }]));
    }
    return Promise.resolve(rows([REPORT_ROW]));
  }
  if (url.includes("/rest/v1/")) return Promise.resolve(rows([]));
  return realFetch(input, init);
}) as typeof fetch;
addEventListener("unload", () => {
  globalThis.fetch = realFetch;
});

const { Hono } = await import("hono");
const { contentPublicRoutes } = await import("../routes/content-public.ts");
const app = new Hono().route("/", contentPublicRoutes);

interface CertBody {
  certificate: {
    hero_image_url: string | null;
    photos_unavailable?: boolean;
    images: unknown[];
  };
}

async function getCert(m: Mode): Promise<{ status: number; body: CertBody }> {
  mode = m;
  const res = await app.request(`/certificates/${CERT_ID}`);
  return { status: res.status, body: await res.json() as CertBody };
}

Deno.test("a certificate whose photos resolve says so, and says the read was fine", async () => {
  const { status, body } = await getCert("ok");
  assertEquals(status, 200);
  assert(body.certificate.hero_image_url, "the front photo is the hero");
  assertEquals(body.certificate.images.length, 2);
  assertEquals(body.certificate.photos_unavailable, false);
});

Deno.test("a certificate with genuinely no photos is ABSENT, not unknown", async () => {
  // The read succeeded and came back empty. hero_image_url is null and
  // photos_unavailable is false, which is what lets the SSR page keep
  // noindexing a thin certificate (US-1665 AC4).
  const { status, body } = await getCert("no-photos");
  assertEquals(status, 200);
  assertEquals(body.certificate.hero_image_url, null);
  assertEquals(body.certificate.images.length, 0);
  assertEquals(body.certificate.photos_unavailable, false);
});

Deno.test("a FAILED submission_images read is unknown, and the payload says so", async () => {
  const { status, body } = await getCert("images-error");
  assertEquals(status, 200, "the certificate itself still resolves; the grade is not in doubt");
  assertEquals(body.certificate.hero_image_url, null);
  assertEquals(
    body.certificate.photos_unavailable,
    true,
    "this is the flag the SSR page reads instead of inferring 'thin' from a null hero",
  );
});

Deno.test("a FAILED storage signing is unknown too, even though rows were read", async () => {
  const { status, body } = await getCert("sign-error");
  assertEquals(status, 200);
  assertEquals(body.certificate.images.length, 0, "an unsignable photo cannot be rendered");
  assertEquals(body.certificate.hero_image_url, null);
  assertEquals(body.certificate.photos_unavailable, true);
});

Deno.test("US-3384 AC5: a FAILED submission read no longer fails open", async () => {
  // isCertificateWithheld() reads a null submission as NOT withheld, which is
  // right for an absent row and wrong for one we could not read: the moderation
  // gate is the last one, and a DB blip used to publish a flagged or
  // pending_review certificate. 500 (not 404) on purpose — fetchJson() in the
  // Pages SSR turns 404/410 into "gone" and everything else into a 503 +
  // Retry-After that keeps the URL and caches nothing.
  mode = "submission-error";
  const res = await app.request(`/certificates/${CERT_ID}`);
  assertEquals(res.status, 500);
  const body = await res.json() as { error?: string; certificate?: unknown };
  assertEquals(body.certificate, undefined, "no certificate is served from an unread gate");
  assertEquals(body.error, "Internal error");
});
