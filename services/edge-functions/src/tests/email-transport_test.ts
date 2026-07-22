// US-915: email transport selection + sender-identity routing is pure (env is
// injected), so this runs with no DB/env. The critical guarantee under test is
// AC6: a known-transactional category can NEVER be routed onto the marketing
// identity, even if a caller flags it marketing.

import { assert, assertEquals } from "@std/assert";
import {
  buildListUnsubscribeHeaders,
  deliverabilityWarnings,
  isTransactionalCategory,
  marketingIdentity,
  resolveConfigurationSet,
  resolveIdentity,
  resolveIsMarketing,
  resolveTransportKind,
  sesApiConfigured,
  TRANSACTIONAL_CATEGORIES,
  transactionalIdentity,
} from "../lib/email-transport.ts";

/** Build an env getter from a plain record. */
const env = (rec: Record<string, string>) => (k: string): string | undefined => rec[k];

const SES_ENV = {
  SES_AWS_REGION: "us-east-1",
  SES_AWS_ACCESS_KEY_ID: "AKIA_TEST",
  SES_AWS_SECRET_ACCESS_KEY: "secret",
  SMTP_ADMIN_EMAIL: "support@gradethread.com",
  SES_MARKETING_FROM_EMAIL: "news@news.gradethread.com",
  SES_CONFIGURATION_SET: "gt-shared",
  SES_MARKETING_CONFIGURATION_SET: "gt-marketing",
};

// ── AC6: transactional categories never route to the marketing identity ──────

Deno.test("AC6: every transactional category force-classifies as transactional", () => {
  const get = env(SES_ENV);
  for (const category of TRANSACTIONAL_CATEGORIES) {
    // Even when a caller mistakenly flags it marketing, the guard wins.
    const isMarketing = resolveIsMarketing({ marketing: true, category });
    assertEquals(isMarketing, false, `${category} must stay transactional`);
    const identity = resolveIdentity(isMarketing, get);
    // Resolves to the transactional From, NOT the marketing identity.
    assertEquals(identity.fromEmail, "support@gradethread.com");
    assert(identity.fromEmail !== "news@news.gradethread.com");
  }
});

// US-2119 / US-2120 / US-2128: the completeness half. The test above proves
// every MEMBER of the set force-classifies transactional — but it would still
// pass if someone REMOVED a required billing notice from the set, silently
// making it marketing-suppressible. Each of these is the ONLY warning a
// subscriber gets of a billing event (trial ending, upcoming renewal, an SCA
// challenge, a failed charge), so a marketing opt-out must never suppress it.
// This asserts membership, so that regression fails HERE rather than in prod as
// an unexplained loss of service.
Deno.test("required billing notices are all transactional (cannot be marketing-suppressed)", () => {
  const REQUIRED_BILLING_NOTICES = [
    "trial_expiring", // US-2120
    "subscription_renewal_reminder", // US-2119
    "payment_action_required", // US-2128 (SCA/3DS challenge)
    "payment_failed", // dunning
  ];
  for (const category of REQUIRED_BILLING_NOTICES) {
    assert(
      TRANSACTIONAL_CATEGORIES.has(category),
      `${category} must be in TRANSACTIONAL_CATEGORIES — it is the only warning of a billing event`,
    );
    assertEquals(
      resolveIsMarketing({ category, marketing: true }),
      false,
      `${category} must never be classified marketing`,
    );
  }
});

Deno.test("AC6: a known transactional category is detected", () => {
  assert(isTransactionalCategory("grade_ready"));
  assert(isTransactionalCategory("payment_failed"));
  assert(!isTransactionalCategory("north_star_weekly"));
  assert(!isTransactionalCategory(undefined));
});

Deno.test("a non-transactional category honours the marketing flag", () => {
  assertEquals(resolveIsMarketing({ marketing: true, category: "north_star_weekly" }), true);
  assertEquals(resolveIsMarketing({ marketing: false, category: "north_star_weekly" }), false);
  // No category + marketing flag → marketing.
  assertEquals(resolveIsMarketing({ marketing: true }), true);
});

// ── Identity resolution ──────────────────────────────────────────────────────

Deno.test("marketing identity is dedicated; falls back to transactional From when unset", () => {
  const withMkt = marketingIdentity(env(SES_ENV));
  assertEquals(withMkt.fromEmail, "news@news.gradethread.com");

  const noMkt = marketingIdentity(env({ SMTP_ADMIN_EMAIL: "support@gradethread.com" }));
  assertEquals(noMkt.fromEmail, "support@gradethread.com"); // graceful fallback

  const tx = transactionalIdentity(env(SES_ENV));
  assertEquals(tx.fromEmail, "support@gradethread.com");
});

// ── Configuration Set ────────────────────────────────────────────────────────

Deno.test("marketing prefers the marketing config set; transactional uses the shared", () => {
  const get = env(SES_ENV);
  assertEquals(resolveConfigurationSet(true, get), "gt-marketing");
  assertEquals(resolveConfigurationSet(false, get), "gt-shared");
  // No sets configured → undefined.
  assertEquals(resolveConfigurationSet(true, env({})), undefined);
});

// ── Transport selection (AC2) ────────────────────────────────────────────────

Deno.test("AC2: marketing defaults to SES API when wired; transactional uses SMTP", () => {
  const get = env(SES_ENV);
  assert(sesApiConfigured(get));
  assertEquals(resolveTransportKind(true, get), "ses_api");
  assertEquals(resolveTransportKind(false, get), "smtp");
});

Deno.test("AC2: EMAIL_TRANSPORT forces the choice; SES forced falls back to SMTP when unwired", () => {
  assertEquals(resolveTransportKind(true, env({ ...SES_ENV, EMAIL_TRANSPORT: "smtp" })), "smtp");
  // forced ses_api but no AWS creds → smtp
  assertEquals(resolveTransportKind(true, env({ EMAIL_TRANSPORT: "ses_api" })), "smtp");
  // SES not wired at all → smtp even for marketing
  assertEquals(resolveTransportKind(true, env({})), "smtp");
});

// ── List-Unsubscribe headers (AC4) ───────────────────────────────────────────

Deno.test("AC4: one-click List-Unsubscribe + Post headers built for an https URL", () => {
  const h = buildListUnsubscribeHeaders({
    unsubscribeUrl: "https://gradethread.com/u/abc",
    mailto: "unsubscribe@gradethread.com",
  });
  assertEquals(
    h["List-Unsubscribe"],
    "<https://gradethread.com/u/abc>, <mailto:unsubscribe@gradethread.com>",
  );
  assertEquals(h["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
});

Deno.test("AC4: mailto-only sets List-Unsubscribe but NOT the one-click Post header", () => {
  const h = buildListUnsubscribeHeaders({ mailto: "unsubscribe@gradethread.com" });
  assertEquals(h["List-Unsubscribe"], "<mailto:unsubscribe@gradethread.com>");
  assert(!("List-Unsubscribe-Post" in h));
});

Deno.test("AC4: no targets → empty header object", () => {
  assertEquals(Object.keys(buildListUnsubscribeHeaders({})).length, 0);
});

// ── Deliverability pre-flight (AC5) ──────────────────────────────────────────

Deno.test("AC5: deliverability warnings flag missing config set / identity / DNS attestation", () => {
  const warnings = deliverabilityWarnings(env({ SMTP_HOST: "smtp.example.com" }));
  const keys = warnings.map((w) => w.key);
  for (const k of ["configuration_set", "marketing_identity", "dkim", "spf", "dmarc"]) {
    assert(keys.includes(k), `expected warning for ${k}`);
  }
});

Deno.test("AC5: a fully-attested deploy emits no deliverability warnings", () => {
  const warnings = deliverabilityWarnings(env({
    SMTP_HOST: "smtp.example.com",
    SES_CONFIGURATION_SET: "gt-shared",
    SES_MARKETING_FROM_EMAIL: "news@news.gradethread.com",
    SES_DKIM_VERIFIED: "true",
    SES_SPF_ALIGNED: "true",
    SES_DMARC_POLICY: "quarantine",
  }));
  assertEquals(warnings.length, 0);
});
