// Every /api/v1 route has an SDK method, and each method hits the route it
// claims to.
//
// The SDK wrapped 6 of the 17 routes when this was written. The route list is
// DERIVED from services/edge-functions/src/routes/api-v1.ts with the same
// pattern services/edge-functions/src/tests/openapi-spec_test.ts uses, so a new
// route with no SDK method (and no entry in EXCLUDED saying why) goes red here.
// Each entry below is a real call through the SDK with a recording fetch, so a
// method pointed at the wrong path or verb fails too, not just a missing name.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GradeThread } from "../../sdk/gradethread-js/src/index";

const ROUTE_SOURCE = readFileSync(
  resolve(process.cwd(), "services/edge-functions/src/routes/api-v1.ts"),
  "utf8",
);

function declaredRoutes(): string[] {
  const pattern = /apiV1Routes\.(get|post|patch|put|delete)\(\s*"([^"]+)"/g;
  return [...ROUTE_SOURCE.matchAll(pattern)].map(
    (m) => `${m[1]!.toUpperCase()} /api/v1${m[2]!.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`,
  );
}

type Call = (gt: GradeThread) => Promise<unknown>;

const G = { title: "t", garment_type: "tops", garment_category: "shirt", images: [] };

/** Route -> an SDK call that must hit exactly that method and path. */
const SDK_COVERAGE: Record<string, Call> = {
  "POST /api/v1/grades": (gt) => gt.grades.create(G),
  "POST /api/v1/grades/batch": (gt) => gt.grades.batch([G]),
  "GET /api/v1/grades/batch/{id}": (gt) => gt.grades.getBatch("x"),
  "GET /api/v1/grades/{id}": (gt) => gt.grades.get("x"),
  "GET /api/v1/grades": (gt) => gt.grades.list(),
  "POST /api/v1/sandbox/grades": (gt) => gt.sandbox.grades.create(),
  "GET /api/v1/sandbox/grades/{id}": (gt) => gt.sandbox.grades.get("x"),
  "GET /api/v1/price-guide": (gt) => gt.priceGuide.list(),
  "GET /api/v1/price-guide/{slug}": (gt) => gt.priceGuide.get("x"),
  "GET /api/v1/sandbox/price-guide": (gt) => gt.sandbox.priceGuide.list(),
  "GET /api/v1/sandbox/price-guide/{slug}": (gt) => gt.sandbox.priceGuide.get("x"),
  "GET /api/v1/items": (gt) => gt.items.list(),
  "GET /api/v1/items/{id}": (gt) => gt.items.get("x"),
  "GET /api/v1/listings": (gt) => gt.listings.list(),
  "GET /api/v1/sales": (gt) => gt.sales.list(),
  "GET /api/v1/usage": (gt) => gt.usage.get(),
  "PATCH /api/v1/webhook": (gt) => gt.webhook.set("https://example.com/h"),
  "GET /api/v1/webhook": (gt) => gt.webhook.get(),
  "POST /api/v1/webhook/secret/rotate": (gt) => gt.webhook.rotateSecret(),
  "GET /api/v1/webhook/deliveries": (gt) => gt.webhook.deliveries(),
};

/** Routes the SDK deliberately does not wrap, with the reason. Empty today. */
const EXCLUDED: Record<string, string> = {};

describe("SDK covers /api/v1", () => {
  it("has a method or a stated exclusion for every route, and no entry for a route that is gone", () => {
    const routes = declaredRoutes();
    expect(routes.length).toBeGreaterThan(15);
    const covered = new Set([...Object.keys(SDK_COVERAGE), ...Object.keys(EXCLUDED)]);
    expect(routes.filter((r) => !covered.has(r)), "routes with no SDK method").toEqual([]);
    expect([...covered].filter((r) => !routes.includes(r)), "SDK entries for routes that no longer exist").toEqual([]);
  });

  for (const [route, call] of Object.entries(SDK_COVERAGE)) {
    it(`${route} is what the SDK method actually calls`, async () => {
      let seen = "";
      const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        // Map the concrete "x" segment back to the route's {param}.
        const template = route.split(" ")[1]!;
        const path = url.pathname
          .split("/")
          .map((seg, i) => (seg === "x" ? template.split("/")[i] : seg))
          .join("/");
        seen = `${init?.method ?? "GET"} ${path}`;
        return new Response(JSON.stringify({ data: { items: [], listings: [], sales: [] }, error: null, meta: {} }));
      }) as typeof fetch;
      await call(new GradeThread({ apiKey: "k", baseUrl: "https://api.test", fetch: fetchImpl }));
      expect(seen).toBe(route);
    });
  }
});
