// Google Sheets sync (US-146): the OAuth consent URL must request the per-file
// drive.file scope + spreadsheets with OFFLINE access (we need a refresh token
// to write the sheet on a schedule), and config gating must reflect the env.
// flipdesk-google.ts imports the service-role supabase client at load, so set
// dummy env BEFORE the dynamic import.
//   deno test --allow-env src/tests/google-sheets-oauth_test.ts
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { buildGoogleConsentUrl, isGoogleSheetsConfigured } = await import(
  "../routes/flipdesk-google.ts"
);

Deno.test("consent URL targets Google with drive.file + spreadsheets + offline access", () => {
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
  // Long-lived: offline access so Google returns a refresh token.
  assertEquals(p.get("access_type"), "offline");
  assertEquals(p.get("prompt"), "consent");
  const scope = p.get("scope")!;
  // Per-file scope, NOT full drive.
  assert(
    scope.includes("auth/drive.file"),
    "scope must request the per-file drive.file scope",
  );
  assert(
    !scope.includes("auth/drive ") && !/auth\/drive$/.test(scope),
    "scope must NOT request full-drive access",
  );
  assert(
    scope.includes("auth/spreadsheets"),
    "scope must request the Sheets read/write scope",
  );
});

const CLIENT_ENV = [
  "GOOGLE_SHEETS_CLIENT_ID",
  "GOOGLE_SHEETS_CLIENT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
];

Deno.test("isGoogleSheetsConfigured reflects the client env vars", () => {
  for (const k of CLIENT_ENV) Deno.env.delete(k);
  assertEquals(isGoogleSheetsConfigured(), false);

  // Per-service override vars work and require BOTH.
  Deno.env.set("GOOGLE_SHEETS_CLIENT_ID", "id");
  assertEquals(isGoogleSheetsConfigured(), false);
  Deno.env.set("GOOGLE_SHEETS_CLIENT_SECRET", "secret");
  assertEquals(isGoogleSheetsConfigured(), true);

  // The SHARED vars satisfy it too — no per-service vars needed.
  for (const k of CLIENT_ENV) Deno.env.delete(k);
  Deno.env.set("GOOGLE_CLIENT_ID", "id");
  Deno.env.set("GOOGLE_CLIENT_SECRET", "secret");
  assertEquals(isGoogleSheetsConfigured(), true);

  for (const k of CLIENT_ENV) Deno.env.delete(k);
});
