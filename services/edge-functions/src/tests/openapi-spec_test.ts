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

Deno.test("openapi: documents every published /api/v1 route", () => {
  const paths = Object.keys(OPENAPI_SPEC.paths);
  for (
    const p of [
      "/api/v1/grades",
      "/api/v1/grades/{id}",
      "/api/v1/grades/batch",
      "/api/v1/grades/batch/{id}",
      "/api/v1/usage",
      "/api/v1/webhook",
      "/api/v1/price-guide",
      "/api/v1/price-guide/{slug}",
    ]
  ) {
    assert(paths.includes(p), `missing path in spec: ${p}`);
  }
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
