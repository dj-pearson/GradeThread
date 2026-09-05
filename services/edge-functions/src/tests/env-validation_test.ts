// US-777: boot-time env validation + feature-aware readiness.
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  assertRequiredEnv,
  computeFeatureReadiness,
  FEATURE_GROUPS,
  isIapEnabled,
  isRealReleaseSha,
  missingRequiredEnv,
  warnMissingFeatureGroups,
} from "../lib/env-validation.ts";

// A fake env getter from a plain map.
function envOf(map: Record<string, string>): (k: string) => string | undefined {
  return (k) => map[k];
}

// The full set a healthy production deploy must have.
const PROD_OK: Record<string, string> = {
  SUPABASE_URL: "https://api.example.com",
  SUPABASE_SERVICE_ROLE_KEY: "svc",
  ANTHROPIC_API_KEY: "sk-ant",
  STRIPE_SECRET_KEY: "sk_live",
  STRIPE_WEBHOOK_SECRET: "whsec",
  FLIPDESK_INTERNAL_JOB_SECRET: "job",
  EDGE_ENCRYPTION_KEY: "enc",
  CERT_SIGNING_KEY: "cert",
  API_KEY_PEPPER: "pepper",
};

Deno.test("prod: a complete required set passes (no throw)", () => {
  assertRequiredEnv(envOf(PROD_OK), "production");
  assertEquals(missingRequiredEnv(envOf(PROD_OK), "production"), []);
});

Deno.test("prod: a missing CORE var crashes boot", () => {
  const env = { ...PROD_OK };
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  assertThrows(
    () => assertRequiredEnv(envOf(env), "production"),
    Error,
    "SUPABASE_SERVICE_ROLE_KEY",
  );
});

Deno.test("prod: a missing prod-only var (CERT_SIGNING_KEY) crashes boot", () => {
  const env = { ...PROD_OK };
  delete env.CERT_SIGNING_KEY;
  assertThrows(() => assertRequiredEnv(envOf(env), "production"), Error, "CERT_SIGNING_KEY");
});

Deno.test("Anthropic accepts either name (CLAUDE_API_KEY satisfies it)", () => {
  const env = { ...PROD_OK };
  delete env.ANTHROPIC_API_KEY;
  env.CLAUDE_API_KEY = "sk-ant";
  assertEquals(missingRequiredEnv(envOf(env), "production"), []);
});

Deno.test("dev: permissive — minimal vars boot without throwing", () => {
  const env = { SUPABASE_URL: "x", SUPABASE_SERVICE_ROLE_KEY: "y" };
  // Missing Anthropic + all prod-required, but dev mode must NOT throw.
  assertRequiredEnv(envOf(env), "development");
  // prod-required vars are NOT demanded outside production.
  assertEquals(missingRequiredEnv(envOf(env), "development"), ["ANTHROPIC_API_KEY"]);
});

Deno.test("feature readiness: a fully-configured feature is 'ok', a gap names the missing var", () => {
  const env = {
    SMTP_HOST: "h", SMTP_USER: "u", SMTP_PASS: "p", SMTP_ADMIN_EMAIL: "a@b.c",
    EBAY_APP_ID: "1", EBAY_CERT_ID: "2", EBAY_DEV_ID: "3", // EBAY_VERIFICATION_TOKEN missing
  };
  const r = computeFeatureReadiness(envOf(env));
  // `startsWith` rather than `===`: smtp is satisfied here, and a satisfied
  // two-sided group now says which half it verified (US-2597). The assertion
  // this case is making is "configured reads as ok", which still holds.
  assert(r.smtp.startsWith("ok"), r.smtp);
  assert(r.ebay.includes("missing"));
  assert(r.ebay.includes("EBAY_VERIFICATION_TOKEN"));
  // A wholly-unconfigured group still reports cleanly (not "ok").
  assert(r.google_photos.startsWith("missing:"));
});

Deno.test("Google connectors: shared GOOGLE_CLIENT_* satisfies google_photos/sheets (fallback)", () => {
  // No per-service override vars set — only the shared client. The connectors
  // fall back to it at runtime, so the boot validator must report 'ok' too.
  const env = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" };
  const r = computeFeatureReadiness(envOf(env));
  assertEquals(r.google_photos, "ok");
  assertEquals(r.google_sheets, "ok");

  // And it stays SILENT at boot about these groups.
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    warnMissingFeatureGroups(envOf(env));
  } finally {
    console.warn = orig;
  }
  assert(!warnings.some((w) => w.includes("google_photos")));
  assert(!warnings.some((w) => w.includes("google_sheets")));
});

Deno.test("Google connectors: neither override nor shared creds → still degraded", () => {
  const r = computeFeatureReadiness(envOf({}));
  assert(r.google_photos.startsWith("missing:"));
  assert(r.google_photos.includes("GOOGLE_PHOTOS_CLIENT_ID"));
  assert(r.google_sheets.startsWith("missing:"));
});

Deno.test("a degraded feature group never makes the env REQUIRED check fail", () => {
  // PROD_OK has zero feature-group vars, yet required env is complete.
  assertEquals(missingRequiredEnv(envOf(PROD_OK), "production"), []);
  const r = computeFeatureReadiness(envOf(PROD_OK));
  assert(r.ebay.startsWith("missing:")); // degraded…
  // …but assertRequiredEnv still passes (boot proceeds).
  assertRequiredEnv(envOf(PROD_OK), "production");
});

Deno.test("US-788: IAP off (no appstore vars) → appstore is 'disabled', never required", () => {
  // PROD_OK has zero appstore vars and no IAP_ENABLED flag → IAP isn't in use.
  const env = { ...PROD_OK };
  assertEquals(isIapEnabled(envOf(env)), false);
  assertEquals(computeFeatureReadiness(envOf(env)).appstore, "disabled");
  // And the boot check never demands appstore vars.
  assertEquals(missingRequiredEnv(envOf(env), "production"), []);
});

Deno.test("US-788: IAP enabled (explicit flag) but unset → reports the missing vars", () => {
  const env = { ...PROD_OK, IAP_ENABLED: "true" };
  assertEquals(isIapEnabled(envOf(env)), true);
  const r = computeFeatureReadiness(envOf(env));
  assert(r.appstore.startsWith("missing:"), "enabled-but-unconfigured IAP should report missing");
  assert(r.appstore.includes("APPLE_APP_APPLE_ID"));
});

Deno.test("US-788: a half-configured IAP (one var set) counts as enabled → degraded", () => {
  // Setting only APPSTORE_ENVIRONMENT signals intent to run IAP.
  const env = { ...PROD_OK, APPSTORE_ENVIRONMENT: "Sandbox" };
  assertEquals(isIapEnabled(envOf(env)), true);
  const r = computeFeatureReadiness(envOf(env));
  assert(r.appstore.startsWith("missing:"));
  assert(r.appstore.includes("APPLE_BUNDLE_ID"));
});

Deno.test("US-788: a fully-configured IAP reports 'ok'", () => {
  const ok = {
    ...PROD_OK,
    APPLE_APP_APPLE_ID: "123456789",
    APPLE_BUNDLE_ID: "com.gradethread.app",
    APPLE_ROOT_CA_G3_B64: "base64==",
    APPSTORE_ENVIRONMENT: "Production",
  };
  assertEquals(computeFeatureReadiness(envOf(ok)).appstore, "ok");
});

Deno.test("US-788: warnMissingFeatureGroups stays SILENT about appstore when IAP is off", () => {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    warnMissingFeatureGroups(envOf(PROD_OK)); // IAP off
  } finally {
    console.warn = orig;
  }
  assert(!warnings.some((w) => w.includes("appstore")), "should not nag about appstore when IAP off");
  // But it still warns about always-on optional groups (e.g. ebay) that are unset.
  assert(warnings.some((w) => w.includes("ebay")), "non-gated groups still warn");
});

Deno.test("US-788: warnMissingFeatureGroups WARNS about appstore once IAP is enabled but unset", () => {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    warnMissingFeatureGroups(envOf({ ...PROD_OK, IAP_ENABLED: "1" }));
  } finally {
    console.warn = orig;
  }
  assert(warnings.some((w) => w.includes("appstore")), "should warn about appstore when IAP enabled but unset");
});

// ── US-2001 / US-2003: observability and alerting must not report "ok"
//    while they are, respectively, unattributable and silent ────────────

Deno.test("US-2001: a placeholder RELEASE_SHA is not a real release", () => {
  for (const raw of ["", "dev", "DEV", " unknown ", "local", "none", "latest"]) {
    assertEquals(
      isRealReleaseSha(() => raw),
      false,
      `${JSON.stringify(raw)} must not count as a release`,
    );
  }
});

Deno.test("US-2001: a real SHA counts, and so does a short SHA or tag", () => {
  // Deliberately permissive on FORM. The failure measured in prod was the
  // literal ARG default surviving the build, not a malformed SHA — requiring
  // 40 hex chars would break short-SHA and tag deploys for no benefit.
  for (const raw of ["c9631342084bfd9e96883321a07a390d3be1e814", "c963134", "v1.4.2"]) {
    assertEquals(isRealReleaseSha(() => raw), true, `${raw} should count`);
  }
});

Deno.test("US-2001: isRealReleaseSha judges the RESOLVED release, not RELEASE_SHA alone", () => {
  // ⚠ This case was MISSING and a mutation found it: reverting isRealReleaseSha
  // to read RELEASE_SHA on its own left the whole suite green. It must not, and
  // here is why the disagreement is worse than either half being wrong.
  //
  // The image ALWAYS bakes RELEASE_SHA (to "dev" without a build arg), so on the
  // real production container the only way a commit ever arrives is under
  // another name. observability.ts tags every log line and Sentry event with the
  // resolved value. If this predicate read RELEASE_SHA alone, /health/ready would
  // announce the release as unattributable while the errors sitting in Sentry
  // were correctly tagged — sending whoever is debugging at 3am to fix a build
  // arg that is already working, which is exactly the wild goose chase US-2001
  // has been running since July.
  const get = (k: string) =>
    ({ RELEASE_SHA: "dev", SOURCE_COMMIT: "c9631342084bfd9e96883321a07a390d3be1e814" })[k];
  assertEquals(
    isRealReleaseSha(get),
    true,
    "a real SOURCE_COMMIT must count even though RELEASE_SHA is the baked-in placeholder",
  );

  // And the converse still holds — placeholders everywhere is still degraded.
  const allPlaceholder = (k: string) =>
    ({ RELEASE_SHA: "dev", SOURCE_COMMIT: "dev", GIT_SHA: "unknown" })[k];
  assertEquals(isRealReleaseSha(allPlaceholder), false);
});

Deno.test("US-2001: observability is DEGRADED when the DSN is set but release is 'dev'", () => {
  // This is the exact prod state that was measured: errorTracking enabled,
  // release "dev", and the readiness line saying observability was fine.
  const env: Record<string, string> = {
    SENTRY_DSN: "https://example.ingest.sentry.io/1",
    RELEASE_SHA: "dev",
  };
  const readiness = computeFeatureReadiness((k) => env[k]);
  assertEquals(readiness.observability !== "ok", true, "observability must not be ok");
});

Deno.test("US-2001: observability is ok once a real SHA is present", () => {
  const env: Record<string, string> = {
    SENTRY_DSN: "https://example.ingest.sentry.io/1",
    RELEASE_SHA: "c9631342084bfd9e96883321a07a390d3be1e814",
  };
  assertEquals(computeFeatureReadiness((k) => env[k]).observability, "ok");
});

// Measured against production on 2026-08-02: /health/ready reported the literal
// string "missing: " for the observability group — nothing after the colon.
//
// The cause is a group whose satisfiedWhen fails while every var it lists is
// PRESENT. observability requires SENTRY_DSN plus a real RELEASE_SHA; the DSN is
// set, so `miss` is empty, and the message named nothing. An operator reading
// that at 3am is told something is missing and refused the name of it — which is
// worse than no line at all, because it costs them the time to go looking.
Deno.test("US-2003: a group that fails with every var SET says so, not 'missing: '", () => {
  const get = (k: string) =>
    ({ SENTRY_DSN: "https://x@y.ingest.sentry.io/1", RELEASE_SHA: "dev" })[k];
  const status = computeFeatureReadiness(get);
  assertEquals(
    status.observability?.startsWith("missing: ") && status.observability.trim().endsWith(":"),
    false,
    "reported 'missing:' with an empty list",
  );
  assertEquals(status.observability?.includes("every var is present"), true);
});

Deno.test("US-2003: a genuinely absent var is still NAMED", () => {
  // The regression the fix must not cause. Naming the missing var is the whole
  // value of the line for every other group.
  const get = (k: string) => ({ RELEASE_SHA: "abc1234" })[k];
  const status = computeFeatureReadiness(get);
  assertEquals(status.observability?.includes("SENTRY_DSN"), true);
});

// ── GT-001: the branded auth-email hook has to be visible from outside ──
//
// The state this catches is silent by construction. With the hook unset, GoTrue
// sends its own template, whose confirm link carries a PKCE code that only
// exchanges in the browser that started the signup — so a person who opens the
// mail on their phone cannot verify, and the deploy looks identical from every
// endpoint we serve. /health/ready is where that becomes one GET.

Deno.test("GT-001: prod without AUTH_EMAIL_HOOK_SECRET is degraded, and names the var", () => {
  const r = computeFeatureReadiness(envOf(PROD_OK));
  assertEquals(r.auth_email_hook?.startsWith("missing: AUTH_EMAIL_HOOK_SECRET"), true);
});

Deno.test("GT-001: the line states the CONSEQUENCE, not just the variable", () => {
  // "missing: AUTH_EMAIL_HOOK_SECRET" tells an operator what to set and nothing
  // about what is broken meanwhile. release="dev" sat in prod for three weeks
  // behind exactly that kind of line (US-2001).
  const r = computeFeatureReadiness(envOf(PROD_OK));
  const line = r.auth_email_hook ?? "";
  assertEquals(line.includes("different device"), true, line);
  assertEquals(line.includes("GT-001"), true, line);
});

Deno.test("GT-001: configured → ok, and it says WHICH HALF it verified", () => {
  // This case used to assert a bare "ok", and that was right about `whenMissing`
  // and wrong about this feature. Two-sided is the point: the secret being set
  // HERE proves nothing about GOTRUE_HOOK_SEND_EMAIL_* on the auth container,
  // and with those unset GoTrue quietly uses its built-in templates while this
  // line says ok. Observed in production on 2026-08-15, reading ok, with the
  // cross-device signup still unproven (US-2597).
  //
  // The rule the old assertion protected is unchanged and still pinned below:
  // `whenMissing` never trails a satisfied group. This is a different field
  // whose whole purpose is to trail one.
  const r = computeFeatureReadiness(envOf({ ...PROD_OK, AUTH_EMAIL_HOOK_SECRET: "v1,whsec_x" }));
  const line = String(r.auth_email_hook ?? "");
  assert(line.startsWith("ok"), `expected a satisfied line, got: ${line}`);
  assertStringIncludes(line, "GOTRUE_HOOK_SEND_EMAIL");
  assertStringIncludes(line, "cannot read");
  // And NOT the missing-branch consequence, which would read as an alarm on a
  // feature whose configured half is fine.
  //
  // Anchored to "falling back", which is unique to whenMissing. My first
  // version used "different device" and failed against my own text — the
  // satisfied line legitimately ends with the same advice (sign up, open the
  // mail elsewhere), because that is how you check the half this cannot see.
  // A negative assertion has to name something only the WRONG branch says.
  assertEquals(line.includes("falling back"), false, line);
});

Deno.test("GT-001: whenMissing never fires for a satisfied group", () => {
  // The append happens on the failure branch only. If it leaked onto "ok" the
  // health page would tell an operator to go fix a working feature.
  //
  // The control used to be `smtp`, and smtp stopped qualifying: four variables
  // being set is not the same as mail arriving, so it now carries an
  // alsoUnverifiable of its own. Moved to `ebay`, which is genuinely one-sided —
  // the four credentials being present IS the whole condition for the connector
  // to work. If that ever stops being true, move the control again rather than
  // deleting it: this case is what proves a bare "ok" is still reachable.
  const r = computeFeatureReadiness(envOf({
    EBAY_APP_ID: "a",
    EBAY_CERT_ID: "c",
    EBAY_DEV_ID: "d",
    EBAY_VERIFICATION_TOKEN: "t",
  }));
  assertEquals(r.ebay, "ok");
});

Deno.test("US-2003: alerting says a channel is configured, not that anyone is paged", () => {
  // The group's own comment says a deploy with no channel must not report a
  // healthy monitoring posture it does not have. A bare "ok" did exactly that
  // from the other side: a webhook URL pointing at a dead endpoint reads as
  // configured forever, and SMTP_ADMIN_EMAIL alone satisfies this group while
  // depending on the same mail path whose delivery is unproven.
  const prevEnv = Deno.env.get("EDGE_ENV");
  const prevHook = Deno.env.get("MONITOR_ALERT_WEBHOOK");
  Deno.env.set("EDGE_ENV", "production");
  Deno.env.set("MONITOR_ALERT_WEBHOOK", "https://example.invalid/hook");
  try {
    const line = String(computeFeatureReadiness().alerting ?? "");
    assert(line.startsWith("ok"), `expected a satisfied line, got: ${line}`);
    assertStringIncludes(line, "ARRIVES");
    assertStringIncludes(line, "dead endpoint");
  } finally {
    if (prevEnv === undefined) Deno.env.delete("EDGE_ENV");
    else Deno.env.set("EDGE_ENV", prevEnv);
    if (prevHook === undefined) Deno.env.delete("MONITOR_ALERT_WEBHOOK");
    else Deno.env.set("MONITOR_ALERT_WEBHOOK", prevHook);
  }
});

const GOOGLE_ADS_ENV = {
  GOOGLE_ADS_DEVELOPER_TOKEN: "dev",
  GOOGLE_ADS_CLIENT_ID: "id",
  GOOGLE_ADS_CLIENT_SECRET: "secret",
  GOOGLE_ADS_REFRESH_TOKEN: "refresh",
  GOOGLE_ADS_CUSTOMER_ID: "1234567890",
};

Deno.test("US-2668: google_ads reports missing, and says what a green ledger means", () => {
  const r = computeFeatureReadiness(envOf({}));
  assert(r.google_ads.startsWith("missing:"), r.google_ads);
  // The CONSEQUENCE, not just the variable list. Unconfigured is a clean skip
  // in both jobs (they return 200), so the cron ledger reads green while
  // nothing syncs - which is the one thing an operator would get wrong here.
  assertStringIncludes(r.google_ads, "green");
});

Deno.test("US-2668: all five variables satisfy google_ads", () => {
  assertEquals(computeFeatureReadiness(envOf(GOOGLE_ADS_ENV)).google_ads, "ok");
});

Deno.test("US-2668: the shared GOOGLE_CLIENT_* does NOT satisfy google_ads", () => {
  // The property that separates this group from google_photos / google_sheets,
  // which DO fall back to the shared client. The Ads API needs its own approved
  // developer token and a refresh token carrying the Ads scope, so treating the
  // shared pair as enough would report a broken setup as ok - and the failure
  // it hides is two daily jobs 502ing, which is the whole of US-2668.
  const r = computeFeatureReadiness(
    envOf({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" }),
  );
  assertEquals(r.google_photos, "ok");
  assertEquals(r.google_sheets, "ok");
  assert(r.google_ads.startsWith("missing:"), r.google_ads);
});

Deno.test("US-2668: the customer id is required and the manager id is not", () => {
  // GOOGLE_ADS_CUSTOMER_ID is which ACCOUNT the spend and the keyword ideas are
  // read for - without it the jobs authenticate and have nothing to point at.
  // LOGIN_CUSTOMER_ID is only needed under a manager (MCC) account, so
  // requiring it would report a correct single-account setup as broken.
  const withoutCustomer = { ...GOOGLE_ADS_ENV };
  delete (withoutCustomer as Record<string, string>).GOOGLE_ADS_CUSTOMER_ID;
  assert(computeFeatureReadiness(envOf(withoutCustomer)).google_ads.startsWith("missing:"));
  assertStringIncludes(
    computeFeatureReadiness(envOf(withoutCustomer)).google_ads,
    "GOOGLE_ADS_CUSTOMER_ID",
  );
  // Manager id absent from a complete set: still ok.
  assertEquals(computeFeatureReadiness(envOf(GOOGLE_ADS_ENV)).google_ads, "ok");
});

Deno.test("the unverifiable caveat is rationed, not sprayed on every group", () => {
  // Every group is technically unverifiable if you push hard enough, and a
  // health page where every line carries a paragraph is a page nobody reads.
  // The rule at the field's definition is: the second half must live somewhere
  // this service cannot read, AND failing it must be SILENT. A wrong eBay
  // credential fails loudly on the first API call and needs no caveat.
  //
  // Pinned as a NUMBER so adding a fifth is a deliberate act with a diff, not
  // something that happens one convenient paragraph at a time.
  const withCaveat = FEATURE_GROUPS.filter((g) => g.alsoUnverifiable).map((g) => g.name);
  assertEquals(
    withCaveat.sort(),
    ["alerting", "auth_email_hook", "pages_origin_bypass", "smtp"],
    "adding one is fine — argue it against the two-part rule at the field's " +
      "definition and update this list. Growing it silently is how the page " +
      "becomes unreadable.",
  );
});

Deno.test("US-2597: smtp says the variables are set, not that mail arrives", () => {
  // The distinction this whole field exists for, on the group where it is
  // easiest to get wrong: an SES account still in sandbox ACCEPTS the
  // connection and drops anything to an unverified recipient, and the outbox
  // retry swallows that gracefully. So every variable can be right, the health
  // line can read ok, and no customer receives anything.
  const r = computeFeatureReadiness(envOf({
    SMTP_HOST: "h",
    SMTP_USER: "u",
    SMTP_PASS: "p",
    SMTP_ADMIN_EMAIL: "a@b.c",
  }));
  const line = String(r.smtp ?? "");
  assert(line.startsWith("ok"), `expected a satisfied line, got: ${line}`);
  assertStringIncludes(line, "DELIVERED");
  assertStringIncludes(line, "sandbox");
});

// ---------------------------------------------------------------------------
// US-2612: the Pages-origin bypass has to be VISIBLE, because its failure is
// silent until it is loud.
//
// Every SSR'd public page reaches this service through one Cloudflare Pages
// worker, so without the bypass a thousand readers share one per-IP bucket.
// Nothing rendered wrong while it is unset; the pages simply start answering
// 503 to whoever is unlucky once enough traffic arrives at once — Googlebot
// included, which is the audience the SSR layer exists for.

Deno.test("US-2612: an unset Pages-origin secret names the consequence, not the variable", () => {
  const prev = Deno.env.get("CF_PAGES_ORIGIN_SECRET");
  Deno.env.delete("CF_PAGES_ORIGIN_SECRET");
  const prevEnv = Deno.env.get("EDGE_ENV");
  Deno.env.set("EDGE_ENV", "production");
  try {
    const line = String(computeFeatureReadiness().pages_origin_bypass ?? "");
    assert(line.startsWith("missing:"), `expected a missing line, got: ${line}`);
    assertStringIncludes(line, "CF_PAGES_ORIGIN_SECRET");
    // The half that matters. "missing: CF_PAGES_ORIGIN_SECRET" tells an
    // operator a name; it does not tell them the blog and the sitemap will
    // start 503ing at readers under load, which is the thing they would act on.
    assertStringIncludes(line, "rate-limit bucket");
    assertStringIncludes(line, "503");
    // And that setting it here alone is not enough — the Pages project needs
    // the same value, which is the mistake this specific bypass invites.
    assertStringIncludes(line, "Cloudflare Pages project");
  } finally {
    if (prev === undefined) Deno.env.delete("CF_PAGES_ORIGIN_SECRET");
    else Deno.env.set("CF_PAGES_ORIGIN_SECRET", prev);
    if (prevEnv === undefined) Deno.env.delete("EDGE_ENV");
    else Deno.env.set("EDGE_ENV", prevEnv);
  }
});

Deno.test("US-2612: set → ok, and it says the Pages half is still unverified", () => {
  // The unset line above already says "the same value must also be set on the
  // Cloudflare Pages project". That sentence vanishes the moment the edge half
  // is set — which is precisely the moment an operator is halfway through a
  // two-step change and most likely to stop. So the satisfied line has to carry
  // it too, including the redeploy, because a Pages env change only takes
  // effect on the next build and a Pages-side-missing secret behaves exactly
  // like no secret at all.
  const prev = Deno.env.get("CF_PAGES_ORIGIN_SECRET");
  const prevEnv = Deno.env.get("EDGE_ENV");
  Deno.env.set("CF_PAGES_ORIGIN_SECRET", "s3cret");
  Deno.env.set("EDGE_ENV", "production");
  try {
    const line = String(computeFeatureReadiness().pages_origin_bypass ?? "");
    assert(line.startsWith("ok"), `expected a satisfied line, got: ${line}`);
    assertStringIncludes(line, "Cloudflare Pages project");
    assertStringIncludes(line, "redeploy");
    // Not the alarm text: the half we can see really is fine.
    assertEquals(line.includes("503"), false, line);
  } finally {
    if (prev === undefined) Deno.env.delete("CF_PAGES_ORIGIN_SECRET");
    else Deno.env.set("CF_PAGES_ORIGIN_SECRET", prev);
    if (prevEnv === undefined) Deno.env.delete("EDGE_ENV");
    else Deno.env.set("EDGE_ENV", prevEnv);
  }
});

Deno.test("US-2718: extension_origins reports whether the extension's origin is trusted", () => {
  // Before this group, the only way to answer "did the operator set
  // EXTENSION_ALLOWED_ORIGINS" was a hand-run CORS preflight with a negative
  // control - three curls, one of which existed solely so that a missing header
  // meant "not configured" rather than "quiet endpoint". Nobody runs that, so
  // the answer lived in a story note and went stale.
  const unset = computeFeatureReadiness(envOf({}));
  assert(unset.extension_origins.startsWith("missing:"), unset.extension_origins);
  assert(unset.extension_origins.includes("EXTENSION_ALLOWED_ORIGINS"));

  const set = computeFeatureReadiness(
    envOf({ EXTENSION_ALLOWED_ORIGINS: "chrome-extension://abc" }),
  );
  assertEquals(set.extension_origins, "ok");
});

Deno.test("US-2718: the consequence says the settled half and marks the rest unsettled", () => {
  // THE POINT OF THIS CASE. The story's own AC reads as though cross-listing is
  // dead without this variable, and its later measurement found that is not
  // established: isAllowedOrigin's extension case exists for the public
  // grade-from-url endpoint, while the FlipDesk queue drain may be exempt via
  // MV3 host_permissions. A line that claimed the feature was broken would be
  // the kind of overstatement that teaches an operator to skip this page - and
  // it is exactly the "improvement" someone would make to this wording later.
  const line = computeFeatureReadiness(envOf({})).extension_origins;

  // The half that IS settled has to be stated.
  assert(/grade-from-url/.test(line), line);

  // The half that is NOT settled has to be marked as such, by name.
  assert(/NOT established|not established/.test(line), line);
  assert(/host_permissions/.test(line), line);
  assert(/unverified rather than broken/.test(line), line);

  // And it must not assert the thing the measurement could not support.
  assert(
    !/cross-listing is broken|cross-posting is broken|will not work/i.test(line),
    `overclaims what a missing EXTENSION_ALLOWED_ORIGINS breaks: ${line}`,
  );
});
