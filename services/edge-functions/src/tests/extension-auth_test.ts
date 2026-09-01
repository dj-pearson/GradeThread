// US-2723: the extension's own token must be accepted on the routes it calls.
//
// The defect these guard against was silent for months and cost two shipped
// features. `authMiddleware` verifies with `supabaseAdmin.auth.getUser()`, which
// takes a Supabase JWT only. The extension holds `userId.expires.hmac` from
// lib/extension-token.ts — three dot-separated parts, so it looks enough like a
// JWT to pass every shape check and then fail verification. Production logged a
// clean 401 on POST /api/flipdesk/extension-queue/claim every five minutes and
// nothing anywhere said the desktop queue could not work.
//
// These are source-level guards. The behavioural half (a real token against a
// live stack returning 200) belongs to the integration lanes, which need the
// full stack; what must never regress is the WIRING, and that is checkable here.

import { assert, assertEquals } from "@std/assert";
import { mintExtensionToken } from "../lib/extension-token.ts";
import { verifyExtensionToken } from "../lib/extension-token.ts";

const mainSrc = Deno.readTextFileSync(new URL("../main.ts", import.meta.url));
const mwSrc = Deno.readTextFileSync(
  new URL("../middleware/extension-or-user-auth.ts", import.meta.url),
);

// Every route group the extension sends an Authorization header to. Keeping the
// list here rather than in prose is the point: the two that were broken were
// broken precisely because nobody had the whole list in one place.
const EXTENSION_CALLED_PREFIXES = [
  "/api/flipdesk/extension-queue",
  "/api/flipdesk/sync",
  // US-9201: the closet read is posted by the extension with its own token.
  "/api/flipdesk/closet-import",
];

Deno.test("every route group the extension calls accepts an extension token", () => {
  for (const prefix of EXTENSION_CALLED_PREFIXES) {
    for (const path of [prefix, `${prefix}/*`]) {
      const line = `app.use("${path}", extensionOrUserAuthMiddleware);`;
      assert(
        mainSrc.includes(line),
        `${path} must use extensionOrUserAuthMiddleware. Under plain ` +
          `authMiddleware the extension's token is rejected and every call 401s.`,
      );
    }
  }
});

Deno.test("plain authMiddleware is NOT left on those groups", () => {
  // Hono runs both if both are registered, and the stricter one would 401 first.
  for (const prefix of EXTENSION_CALLED_PREFIXES) {
    for (const path of [prefix, `${prefix}/*`]) {
      assert(
        !mainSrc.includes(`app.use("${path}", authMiddleware);`),
        `${path} still has plain authMiddleware registered alongside the ` +
          `wrapper; the extension token would be rejected before it is tried.`,
      );
    }
  }
});

Deno.test("the wrapper is not applied anywhere else", () => {
  // It is deliberately narrow. Widening extension-token acceptance to the rest
  // of the authed surface must be a decision someone makes on purpose.
  const uses = [...mainSrc.matchAll(
    /app\.use\(\s*"([^"]+)"\s*,\s*extensionOrUserAuthMiddleware\s*\)/g,
  )].map((m) => m[1]);
  for (const path of uses) {
    const base = path.replace(/\/\*$/, "");
    assert(
      EXTENSION_CALLED_PREFIXES.includes(base),
      `extensionOrUserAuthMiddleware is mounted on ${path}, which is not a ` +
        `route group the extension calls. Add it to EXTENSION_CALLED_PREFIXES ` +
        `deliberately, or use authMiddleware.`,
    );
  }
});

Deno.test("an extension token carries no assurance claims", () => {
  // A step-up / AAL2 gate must never be satisfiable by a 30-day extension
  // token. The middleware states empty claims rather than decoding them.
  assert(mwSrc.includes("NO_ASSURANCE"));
  assert(mwSrc.includes('c.set("authClaims", NO_ASSURANCE)'));
});

Deno.test("the extension branch still enforces the account checks", () => {
  // Same posture as authMiddleware: a deleted account and an unverified email
  // are both refused. A 30-day token must not outlive the account it names.
  assert(mwSrc.includes("getUserById"));
  assert(mwSrc.includes("email_confirmed_at"));
});

Deno.test("a valid extension token round-trips, and a tampered one does not", async () => {
  Deno.env.set("EXTENSION_TOKEN_SECRET", "test-secret-for-extension-auth");
  const userId = "11111111-2222-3333-4444-555555555555";
  const { token } = await mintExtensionToken(userId, 600);

  const ok = await verifyExtensionToken(token);
  assertEquals(ok?.userId, userId);

  // The shape that fooled authMiddleware: three dot-separated parts. Flipping
  // one signature character must fail, not fall through to some other branch.
  const parts = token.split(".");
  const flipped = parts[2][0] === "a" ? "b" : "a";
  const tampered = `${parts[0]}.${parts[1]}.${flipped}${parts[2].slice(1)}`;
  assertEquals(await verifyExtensionToken(tampered), null);

  // And an expired one, so the 30-day TTL is a real bound.
  const { token: dead } = await mintExtensionToken(userId, 60);
  const [u, , sig] = dead.split(".");
  assertEquals(await verifyExtensionToken(`${u}.1.${sig}`), null);
});

// ── US-2725: the extension path must never answer with a silent 500 ─────────
//
// Twice in one session an extension failure reached production as a status code
// with no cause: a 401 from the queue that named no reason, and a 500 from the
// writeback that discarded the Postgres error. The repo already has failSafe,
// which logs the redacted cause under a tag and returns a safe body.

Deno.test("extension-writeback logs every failure instead of swallowing it", () => {
  const src = Deno.readTextFileSync(
    new URL("../routes/flipdesk-listings.ts", import.meta.url),
  );
  const start = src.indexOf('flipdeskListingsRoutes.post("/extension-writeback"');
  assert(start > -1, "extension-writeback route not found");
  // To the next route declaration, so this reads only the handler.
  const after = src.indexOf("flipdeskListingsRoutes.", start + 40);
  const route = src.slice(start, after > -1 ? after : undefined);

  const bare = [...route.matchAll(/c\.json\(\s*\{\s*error:[^}]*\}\s*,\s*500\s*\)/g)];
  assertEquals(
    bare.length,
    0,
    "extension-writeback still has a bare 500 that throws its cause away; " +
      "use failSafe(c, 500, message, cause, tag, code) so the log says what broke.",
  );

  // And each branch is separately identifiable in the log.
  for (const tag of ["item", "update", "insert"]) {
    assert(
      route.includes(`"flipdesk.extension-writeback.${tag}"`),
      `missing a distinct logTag for the ${tag} failure branch`,
    );
  }
});
