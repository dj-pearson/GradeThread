// Google Photos Picker import: the OAuth consent URL must request the Photos
// Picker scope with per-import (online) access, and config gating must reflect
// the env. flipdesk-google-photos.ts imports the service-role supabase client
// at load, so set dummy env BEFORE the dynamic import.
//   deno test --allow-env src/tests/google-photos_test.ts
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { buildGoogleConsentUrl, isGooglePhotosConfigured } = await import(
  "../routes/flipdesk-google-photos.ts"
);

Deno.test("consent URL targets Google with the Picker scope + online access", () => {
  const url = new URL(buildGoogleConsentUrl("state8", "cid123", "https://edge/cb"));
  assertEquals(
    url.origin + url.pathname,
    "https://accounts.google.com/o/oauth2/v2/auth",
  );
  const p = url.searchParams;
  assertEquals(p.get("client_id"), "cid123");
  assertEquals(p.get("redirect_uri"), "https://edge/cb");
  assertEquals(p.get("state"), "state8");
  assertEquals(p.get("response_type"), "code");
  // Per-import: online access (no refresh token requested/stored).
  assertEquals(p.get("access_type"), "online");
  assert(
    p.get("scope")!.includes("photospicker.mediaitems.readonly"),
    "scope must be the Photos Picker readonly scope",
  );
});

Deno.test("isGooglePhotosConfigured reflects the client env vars", () => {
  Deno.env.delete("GOOGLE_PHOTOS_CLIENT_ID");
  Deno.env.delete("GOOGLE_PHOTOS_CLIENT_SECRET");
  assertEquals(isGooglePhotosConfigured(), false);
  Deno.env.set("GOOGLE_PHOTOS_CLIENT_ID", "id");
  assertEquals(isGooglePhotosConfigured(), false); // needs both
  Deno.env.set("GOOGLE_PHOTOS_CLIENT_SECRET", "secret");
  assertEquals(isGooglePhotosConfigured(), true);
  Deno.env.delete("GOOGLE_PHOTOS_CLIENT_ID");
  Deno.env.delete("GOOGLE_PHOTOS_CLIENT_SECRET");
});
