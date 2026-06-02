// US-270: auth-assurance claim decoding + step-up freshness unit tests.
import { assert, assertEquals } from "@std/assert";
import {
  decodeJwtClaims,
  hasFreshStepUp,
  isAal2,
  latestMfaAuthAt,
} from "../lib/jwt-claims.ts";

// Build a JWT with the given payload (header + payload + dummy signature).
function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(
      /=+$/,
      "",
    );
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.sig`;
}

Deno.test("decodes aal + amr from a token", () => {
  const tok = makeJwt({
    aal: "aal2",
    amr: [
      { method: "password", timestamp: 1000 },
      { method: "totp", timestamp: 2000 },
    ],
  });
  const c = decodeJwtClaims(tok);
  assertEquals(c.aal, "aal2");
  assertEquals(c.amr.length, 2);
  assert(isAal2(c));
});

Deno.test("malformed / missing tokens yield safe defaults", () => {
  for (const t of ["", "garbage", "a.b", "only-one-part"]) {
    const c = decodeJwtClaims(t);
    assertEquals(c.aal, null);
    assertEquals(c.amr, []);
    assertEquals(isAal2(c), false);
  }
});

Deno.test("aal1 session is not AAL2", () => {
  const c = decodeJwtClaims(
    makeJwt({ aal: "aal1", amr: [{ method: "password", timestamp: 1 }] }),
  );
  assertEquals(isAal2(c), false);
});

Deno.test("latestMfaAuthAt ignores password, picks newest MFA factor", () => {
  const c = decodeJwtClaims(makeJwt({
    aal: "aal2",
    amr: [
      { method: "password", timestamp: 9999 },
      { method: "totp", timestamp: 100 },
      { method: "totp", timestamp: 500 },
    ],
  }));
  assertEquals(latestMfaAuthAt(c), 500);
});

Deno.test("hasFreshStepUp: recent MFA within window passes", () => {
  const now = 10_000;
  const c = decodeJwtClaims(makeJwt({
    aal: "aal2",
    amr: [{ method: "totp", timestamp: now - 60 }],
  }));
  assert(hasFreshStepUp(c, 300, now));
});

Deno.test("hasFreshStepUp: stale MFA outside window fails", () => {
  const now = 10_000;
  const c = decodeJwtClaims(makeJwt({
    aal: "aal2",
    amr: [{ method: "totp", timestamp: now - 600 }],
  }));
  assertEquals(hasFreshStepUp(c, 300, now), false);
});

Deno.test("hasFreshStepUp: aal1 never passes even with a recent factor", () => {
  const now = 10_000;
  const c = decodeJwtClaims(makeJwt({
    aal: "aal1",
    amr: [{ method: "totp", timestamp: now }],
  }));
  assertEquals(hasFreshStepUp(c, 300, now), false);
});

Deno.test("hasFreshStepUp: no MFA factor fails", () => {
  const now = 10_000;
  const c = decodeJwtClaims(makeJwt({
    aal: "aal2",
    amr: [{ method: "password", timestamp: now }],
  }));
  assertEquals(hasFreshStepUp(c, 300, now), false);
});
