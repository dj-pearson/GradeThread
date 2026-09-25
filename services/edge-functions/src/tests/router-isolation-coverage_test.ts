// A router cannot be mounted without a cross-tenant case, or a written reason.
//
// mcp-tenant-coverage_test.ts does this for MCP tools. HTTP routers had no such
// check, and the gap it left was real: nine user-facing FlipDesk mounts were
// never named in tenant-isolation_test.ts, depop's POST /orders/:saleId/ship
// among them, and nothing went red. The skill says every route gets a case; a
// rule nobody enforces is a rule the next router skips.
//
// So every app.route() prefix in main.ts must be one of:
//   1. named by a Deno.test block in the isolation suite (a URL under it),
//   2. behind adminAuthMiddleware in main.ts (operator routes cross tenant
//      lines on purpose; admin-scope-coverage_test.ts owns their RBAC, and the
//      isolation suite's header explains why it covers them thinly),
//   3. in EXEMPT, with the reason tenant isolation does not apply, or
//   4. in OWED, a known gap that can only shrink.
//
// It reads files and needs no fixture, so it runs on every `deno test`. The
// cases it requires DO need the stack and skip without it, which is why their
// existence has to be checked somewhere that does not.

import { assert, assertEquals } from "@std/assert";

const MAIN_SRC = await Deno.readTextFile(
  new URL("../main.ts", import.meta.url),
);
const ISOLATION_SUITE = await Deno.readTextFile(
  new URL("./tenant-isolation_test.ts", import.meta.url),
);

/** Every distinct prefix main.ts mounts a router at. */
export function mountPrefixes(mainSrc: string): string[] {
  return [
    ...new Set(
      [...mainSrc.matchAll(/app\.route\(\s*"([^"]+)"/g)].map((m) => m[1]!),
    ),
  ];
}

/** Mounts sitting under an `app.use(<path>, adminAuthMiddleware)` line. */
export function adminGatedMounts(
  mainSrc: string,
  mounts: string[],
): Set<string> {
  const gates = [
    ...mainSrc.matchAll(
      /app\.use\(\s*"([^"]+)"\s*,\s*adminAuthMiddleware\s*\)/g,
    ),
  ]
    .map((m) => m[1]!);
  const out = new Set<string>();
  for (const mount of mounts) {
    for (const gate of gates) {
      const wildcard = gate.endsWith("/*");
      const base = gate.replace(/\/\*$/, "");
      // A bare path gates only itself; a wildcard gates itself and everything
      // below it. A gate on a CHILD path never gates the parent mount.
      if (base === mount && wildcard) out.add(mount);
      else if (wildcard && mount.startsWith(base + "/")) out.add(mount);
    }
  }
  return out;
}

/**
 * The mounts the isolation suite exercises. Each URL is credited to its
 * LONGEST matching mount, so a case against /api/flipdesk/google/photos/poll
 * does not also count as coverage of /api/flipdesk/google.
 */
export function coveredMounts(suiteSrc: string, mounts: string[]): Set<string> {
  const covered = new Set<string>();
  for (const block of suiteSrc.split("Deno.test(").slice(1)) {
    for (
      const m of block.matchAll(/\/(?:api|mcp|oauth|health)(?:\/[^\s"'`?)]*)?/g)
    ) {
      const url = m[0];
      let best: string | null = null;
      for (const mount of mounts) {
        if (
          (url === mount || url.startsWith(mount + "/")) &&
          (!best || mount.length > best.length)
        ) {
          best = mount;
        }
      }
      if (best) covered.add(best);
    }
  }
  return covered;
}

// Tenant isolation does not apply: no user JWT (signed webhook, job secret,
// public read), or the route takes no resource id and keys only on the JWT.
const EXEMPT = new Map<string, string>([
  ["/health", "liveness and metrics; reads no tenant rows"],
  ["/api/maintenance", "public maintenance banner"],
  ["/api/client-version", "public minimum-client-version gate"],
  ["/api/changelog", "public changelog entries"],
  [
    "/api/content/public/help",
    "anonymous help articles, visibility 'public' only",
  ],
  ["/api/help", "help articles for signed-in users; content, not tenant rows"],
  ["/api/newsletter", "public double opt-in subscribe/confirm, no user JWT"],
  [
    "/api/drip-track",
    "unauthenticated email pixel; token is the send id, sets open/click time only",
  ],
  [
    "/api/campaign-track",
    "unauthenticated email pixel; token is the send id, sets open/click time only",
  ],
  [
    "/api/webhooks",
    "Stripe/SES webhooks; signature-verified, tenant comes from the signed event",
  ],
  [
    "/api/webhooks/appstore",
    "Apple server notifications; signed JWS, tenant from the transaction",
  ],
  [
    "/api/webhooks/google-play",
    "Play RTDN push; job-secret gated, tenant from the purchase token",
  ],
  [
    "/api/auth/hooks",
    "GoTrue send-email hook; signature-verified, no user JWT",
  ],
  [
    "/api/email",
    "SES/SNS notifications (signed) and engagement pixels (signed tokens)",
  ],
  [
    "/api/flipdesk/webhooks",
    "marketplace webhooks; signature/verification-token gated, tenant from the connection",
  ],
  ["/api/content/scheduler", "content cron; job secret or admin JWT"],
  ["/api/newsletter/scheduler", "newsletter cron; job secret or admin JWT"],
  ["/api/drip", "drip cron; job secret or admin JWT"],
  [
    "/api/guarantee",
    "public buyer claim against a public certificate id; no seller JWT",
  ],
  [
    "/api/payments/appstore",
    "receipt verify; the grant is written to the caller's own JWT user",
  ],
  [
    "/api/payments/google",
    "receipt verify; the grant is written to the caller's own JWT user",
  ],
  [
    "/api/waitlist",
    "self-scoped: reads/writes only the JWT user's row, takes no resource id",
  ],
  [
    "/api/legal",
    "self-scoped: acceptances keyed on the JWT user, takes no resource id",
  ],
  [
    "/api/announcements",
    "announcements are global; a dismissal row is keyed on the JWT user",
  ],
  ["/api/flipdesk/demand", "reads only buyer_wants with visibility 'public'"],
  [
    "/api/flipdesk/photo-profiles",
    "static photo-profile config by category; no tenant rows",
  ],
  [
    "/api/flipdesk/sheets",
    "fetches a public Google Sheet CSV by URL; no tenant rows",
  ],
  [
    "/api/flipdesk/product",
    "barcode/style-code lookup; takes no GradeThread resource id",
  ],
]);

// Known gaps. Each route takes something tenant-shaped and has no case. The
// scoping looked right when this list was written; a case is what proves it.
// Shrink this list; never grow it without a story.
const OWED = new Map<string, string>([
  [
    "/api/flipdesk/google/photos",
    "GET /poll and POST /import take ?session=<id>; scoped by .eq(user_id), needs a seeded session id",
  ],
  [
    "/api/flipdesk/google",
    "sheet map/use/disconnect write the owner's connection; no viewer or foreign-owner case",
  ],
  [
    "/api/flipdesk/return-shield",
    "POST /preview takes a return_id resolved under ownerId; needs a seeded return for A",
  ],
  [
    "/oauth",
    "MCP OAuth token/revoke exchange codes and refresh tokens; no case that B cannot use A's",
  ],
]);

const mounts = mountPrefixes(MAIN_SRC);
const admin = adminGatedMounts(MAIN_SRC, mounts);
const covered = coveredMounts(ISOLATION_SUITE, mounts);

Deno.test("every router mount has a cross-tenant case, an admin gate, or a written reason", () => {
  assert(
    mounts.length >= 150,
    `only ${mounts.length} mounts parsed out of main.ts`,
  );
  const unclassified = mounts
    .filter((m) =>
      !covered.has(m) && !admin.has(m) && !EXEMPT.has(m) && !OWED.has(m)
    )
    .sort();
  assertEquals(
    unclassified,
    [],
    "These app.route() mounts have no case in src/tests/tenant-isolation_test.ts. The edge " +
      "bypasses RLS, so an unscoped handler leaks another seller's data and nothing else " +
      "catches it. Add a case driving the route as tenant B against tenant A's id, or add the " +
      "mount to EXEMPT with the reason isolation does not apply.",
  );
});

Deno.test("the allowlists only name live, still-uncovered mounts (the list can only shrink)", () => {
  const live = new Set(mounts);
  for (const [name, list] of [["EXEMPT", EXEMPT], ["OWED", OWED]] as const) {
    const gone = [...list.keys()].filter((m) => !live.has(m)).sort();
    assertEquals(gone, [], `${name} names mounts main.ts no longer has`);
    const nowCovered = [...list.keys()].filter((m) =>
      covered.has(m) || admin.has(m)
    ).sort();
    assertEquals(
      nowCovered,
      [],
      `${name} names mounts that are now covered; remove them`,
    );
    for (const [m, reason] of list) {
      assert(reason.trim().length > 10, `${name} ${m}: no reason`);
    }
  }
  const both = [...EXEMPT.keys()].filter((m) => OWED.has(m));
  assertEquals(both, [], "a mount is either exempt or owed, not both");
});

Deno.test("the guard can fail: parsing is real, and a nested mount is not credited to its parent", () => {
  assert(
    covered.size >= 50,
    `only ${covered.size} mounts read as covered; the suite path or regex broke`,
  );
  assert(
    admin.has("/api/admin/users"),
    "adminAuthMiddleware gating was not detected",
  );
  assert(
    !admin.has("/api/content/public"),
    "a public mount read as admin-gated",
  );

  const ms = ["/api/flipdesk/google", "/api/flipdesk/google/photos", "/api/x"];
  const suite =
    `Deno.test({ fn: () => fetch(\`\${BASE}/api/flipdesk/google/photos/poll?session=1\`) });`;
  const c = coveredMounts(suite, ms);
  assertEquals(
    [...c],
    ["/api/flipdesk/google/photos"],
    "longest-prefix crediting broke",
  );
  assert(
    !coveredMounts(suite, ["/api/nope"]).has("/api/nope"),
    "a fabricated mount read as covered",
  );

  const gated = adminGatedMounts(
    `app.use("/api/content/help", adminAuthMiddleware);\napp.use("/api/a/*", adminAuthMiddleware);`,
    ["/api/content/help", "/api/content", "/api/a", "/api/a/b", "/api/ab"],
  );
  assertEquals(
    [...gated].sort(),
    ["/api/a", "/api/a/b"],
    "a bare path must not gate its mount prefix",
  );
});
