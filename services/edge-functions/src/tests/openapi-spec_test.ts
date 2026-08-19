// US-1793: guard the published OpenAPI spec stays valid + covers the API. It's
// served verbatim at GET /api/v1/openapi.json, so a structural regression here
// would ship a broken spec to partners.
import { assert, assertEquals } from "@std/assert";
import { OPENAPI_SPEC } from "../lib/openapi-spec.ts";

Deno.test("openapi: version + top-level shape", () => {
  assertEquals(OPENAPI_SPEC.openapi, "3.1.0");
  assert(OPENAPI_SPEC.info.title.length > 0);
  assert(OPENAPI_SPEC.servers.length >= 1);
});

// US-9107: DERIVED from the route source, not a hardcoded list.
//
// This test used to enumerate eight path strings by hand. A route added without
// a spec entry passed it, which is the failure the test exists to prevent - the
// two /api/v1/items routes were added and it stayed green until this rewrite.
// Both directions are checked now: an undocumented route AND a spec entry that
// no longer matches a real route.
const ROUTE_SOURCE = await Deno.readTextFile(
  new URL("../routes/api-v1.ts", import.meta.url),
);

/** `get("/items/:id"` -> `{ method: "get", path: "/api/v1/items/{id}" }` */
function declaredRoutes(): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  const pattern = /apiV1Routes\.(get|post|patch|put|delete)\(\s*"([^"]+)"/g;
  for (const match of ROUTE_SOURCE.matchAll(pattern)) {
    const method = match[1];
    const path = "/api/v1" + match[2].replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    out.push({ method, path });
  }
  return out;
}

Deno.test("openapi: documents every published /api/v1 route, and no route it does not have", () => {
  const routes = declaredRoutes();
  assert(routes.length > 0, "no routes parsed from api-v1.ts; the pattern has drifted");

  const spec = OPENAPI_SPEC.paths as Record<string, Record<string, unknown>>;

  const undocumented = routes.filter(({ method, path }) => {
    const entry = spec[path];
    return !entry || entry[method] === undefined;
  });
  assertEquals(
    undocumented.map((r) => `${r.method.toUpperCase()} ${r.path}`),
    [],
    "these /api/v1 routes are not in the published OpenAPI spec; the spec is hand-authored, " +
      "so it must change in the same commit as the route",
  );

  const declared = new Set(routes.map((r) => `${r.method} ${r.path}`));
  const stale: string[] = [];
  for (const [path, entry] of Object.entries(spec)) {
    if (!path.startsWith("/api/v1")) continue;
    for (const method of Object.keys(entry)) {
      if (!declared.has(`${method} ${path}`)) stale.push(`${method.toUpperCase()} ${path}`);
    }
  }
  assertEquals(
    stale,
    [],
    "these spec entries no longer match a route in api-v1.ts, so they document nothing",
  );
});

Deno.test("openapi: X-API-Key security scheme is declared", () => {
  const scheme = OPENAPI_SPEC.components.securitySchemes.ApiKeyAuth;
  assertEquals(scheme.type, "apiKey");
  assertEquals(scheme.in, "header");
  assertEquals(scheme.name, "X-API-Key");
});

Deno.test("openapi: batch + webhook schemas present and serializable", () => {
  const schemas = OPENAPI_SPEC.components.schemas;
  assert("BatchStatus" in schemas);
  assert("GradeCompletedEvent" in schemas);
  assert("PriceGuideEntry" in schemas);
  // The route serves it via c.json — it must round-trip through JSON cleanly.
  const round = JSON.parse(JSON.stringify(OPENAPI_SPEC));
  assertEquals(round.openapi, "3.1.0");
});
