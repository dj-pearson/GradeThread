// US-361: open-redirect safety of the OAuth relative-path sanitizer.
//
// oauth-redirect.ts is side-effect-free (no supabase/eBay imports), so this
// imports it directly. Each bypass vector gets its own assertion.
//
//   deno test src/tests/oauth-redirect_test.ts
import { assert, assertEquals } from "@std/assert";
import { sanitizeRelativePath } from "../lib/oauth-redirect.ts";

// Control chars built via fromCharCode so the source carries no literal
// tab/newline/CR bytes.
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const NUL = String.fromCharCode(0);

// -- Accepted: same-origin paths under the allowlisted prefix ----------------

Deno.test("accepts an allowlisted dashboard path", () => {
  assertEquals(
    sanitizeRelativePath("/dashboard/flipdesk/marketplaces"),
    "/dashboard/flipdesk/marketplaces",
  );
});

Deno.test("accepts the default callback destination (with query)", () => {
  const dest = "/dashboard/flipdesk/marketplaces?ebay=connected";
  assertEquals(sanitizeRelativePath(dest), dest);
});

Deno.test("accepts the bare allowlisted prefix", () => {
  assertEquals(sanitizeRelativePath("/dashboard"), "/dashboard");
});

// US-661: the iOS app bounces the eBay OAuth callback through an https
// Universal Link under /app/* so ASWebAuthenticationSession.Callback.https can
// complete the in-app session. The client_state nonce rides along in the query.
Deno.test("accepts the iOS Universal Link callback path", () => {
  assertEquals(sanitizeRelativePath("/app/oauth/ebay"), "/app/oauth/ebay");
});

Deno.test("accepts the iOS callback path with a client_state query", () => {
  const dest = "/app/oauth/ebay?client_state=abc123";
  assertEquals(sanitizeRelativePath(dest), dest);
});

Deno.test("accepts the iOS Supabase auth-callback path", () => {
  assertEquals(sanitizeRelativePath("/app/auth-callback"), "/app/auth-callback");
});

Deno.test("rejects a path that only prefix-matches /app", () => {
  // Same guard as /dashboardx — a different segment must not slip through.
  assertEquals(sanitizeRelativePath("/application"), null);
});

// -- Rejected: open-redirect / off-site vectors ------------------------------

Deno.test("rejects null/empty/undefined", () => {
  assertEquals(sanitizeRelativePath(null), null);
  assertEquals(sanitizeRelativePath(undefined), null);
  assertEquals(sanitizeRelativePath(""), null);
});

Deno.test("rejects absolute / scheme URLs", () => {
  assertEquals(sanitizeRelativePath("https://evil.com"), null);
  assertEquals(sanitizeRelativePath("http://evil.com/dashboard"), null);
  assertEquals(sanitizeRelativePath("javascript:alert(1)"), null);
  assertEquals(sanitizeRelativePath("data:text/html,x"), null);
});

Deno.test("rejects protocol-relative //host", () => {
  assertEquals(sanitizeRelativePath("//evil.com"), null);
  assertEquals(sanitizeRelativePath("//evil.com/dashboard"), null);
});

Deno.test("rejects backslash tricks (browsers treat backslash as slash)", () => {
  assertEquals(sanitizeRelativePath("/\\evil.com"), null);
  assertEquals(sanitizeRelativePath("/\\/evil.com"), null);
  assertEquals(sanitizeRelativePath("/dashboard\\@evil.com"), null);
});

Deno.test("rejects tab/newline/CR/control chars (browsers strip them)", () => {
  // "/<tab>/evil.com" would collapse to "//evil.com" once the tab is stripped.
  assertEquals(sanitizeRelativePath("/" + TAB + "/evil.com"), null);
  assertEquals(sanitizeRelativePath("/" + LF + "/evil.com"), null);
  assertEquals(sanitizeRelativePath("/" + CR + "/evil.com"), null);
  assertEquals(sanitizeRelativePath("/" + NUL + "evil.com"), null);
  // Even an otherwise-allowlisted path is rejected if it carries a control char.
  assertEquals(sanitizeRelativePath("/dashboard" + TAB + "/x"), null);
});

Deno.test("rejects same-origin paths outside the allowlist", () => {
  assertEquals(sanitizeRelativePath("/login"), null);
  assertEquals(sanitizeRelativePath("/"), null);
  // A path that merely starts with the prefix string but is a different segment.
  assertEquals(sanitizeRelativePath("/dashboardx"), null);
});

Deno.test("checks the allowlist on the path only, not the query string", () => {
  // Allowlisted route + a query that contains '//' is fine — only the path
  // portion is matched against the allowlist, and '//' there is not a host.
  assert(sanitizeRelativePath("/dashboard?next=//x") !== null);
});
