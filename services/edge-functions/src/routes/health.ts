import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { isErrorTrackingConfigured, releaseSha } from "../lib/observability.ts";
import { computeFeatureReadiness } from "../lib/env-validation.ts";
import {
  pagesOriginEvidenceLine,
  pagesOriginObservation,
} from "../lib/pages-origin-evidence.ts";
import { edgeEnv, isProduction, isProductionEnv } from "../lib/env.ts";
import { isPlaceholderRelease, RELEASE_ENV_KEYS } from "../lib/release-identity.ts";
import {
  checkSchemaCompleteness,
  compareSchemaVersion,
  EXPECTED_SCHEMA_VERSION,
  type SchemaCompleteness,
} from "../lib/schema-version.ts";
import {
  gradingBufferConcurrency,
  summarizeMemory,
} from "../lib/grading-capacity.ts";
import { getSetting } from "../lib/system-settings.ts";
import { isFeatureEnabled } from "../lib/feature-flags.ts";
import { isMcpEnabled } from "./mcp.ts";
import { WATCHDOG_HEARTBEAT_KEY } from "./jobs-watchdog-heartbeat.ts";
import { OTP_EXPIRY_KEY } from "./auth-hooks.ts";

export const healthRoutes = new Hono();

// US-492: TWO probes with distinct jobs.
//
//  - GET /health        — LIVENESS. Cheap, dependency-free "is the process up?"
//    This is the RESTART probe: the Dockerfile HEALTHCHECK + Coolify
//    (coolify.healthcheckPath=/health) hit it. It must NOT touch the DB —
//    restarting the container can't fix a DB outage, and flapping a hard
//    dependency into the restart probe would crash-loop a healthy app.
//
//  - GET /health/ready  — READINESS. Probes hard dependencies (DB reachable,
//    critical env present) and returns 503 when one is down, so a load balancer
//    / orchestrator can stop routing traffic to a container that's up but can't
//    serve. Safe to call frequently; does one tiny indexed HEAD query.

// Hard dependencies whose absence means the service can't function. The
// Anthropic key is checked via either accepted name (see getAnthropicApiKey).
const REQUIRED_ENV = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;

function missingCriticalEnv(): string[] {
  const missing: string[] = REQUIRED_ENV.filter((k) => !Deno.env.get(k)?.trim());
  const hasAnthropic =
    Deno.env.get("ANTHROPIC_API_KEY")?.trim() ||
    Deno.env.get("CLAUDE_API_KEY")?.trim();
  if (!hasAnthropic) missing.push("ANTHROPIC_API_KEY");
  return missing;
}

export interface ReadinessSummary {
  ready: boolean;
  httpStatus: 200 | 503;
  body: {
    status: "ready" | "not_ready";
    checks: { database: "ok" | "fail"; env: "ok" | "missing" };
    missing_env?: string[];
    // US-777: per-feature config status (e.g. { ebay: "missing: EBAY_…" }). A
    // degraded feature does NOT flip `ready` — the orchestrator keeps routing —
    // it's surfaced so ops can see WHICH integration is unconfigured.
    features?: Record<string, string>;
    // US-1566: applied vs expected migration version — see summarizeSchema.
    schema?: SchemaSummary;
  };
}

// US-1566: SCHEMA DRIFT WAS UNOBSERVABLE FROM OUTSIDE THE CONTAINER.
//
// The boot guard already refuses to start a production edge whose DB is behind,
// but that verdict was only ever visible in container logs. Nothing served it,
// so answering "is prod actually migrated?" meant reading logs you may not have
// access to — which is precisely how US-1566's premise ("00339–00342 not
// applied") went ~130 migrations stale without anyone noticing it had been
// fixed. Reporting it here makes the answer a curl away, for humans and for the
// post-deploy smoke check.
//
// DRIFT DOES NOT FLIP `ready`, deliberately. "behind" is already fatal at boot,
// so a running container cannot be behind unless the version read failed open —
// and "ahead" is the NORMAL state in the migrate-then-deploy window this repo
// mandates. Gating readiness on it would pull healthy containers out of rotation
// during every correct deploy.
export interface SchemaSummary {
  expected: string;
  applied: string | null;
  /**
   * The version relation, EXCEPT that a hole beneath the maximum outranks it.
   *
   * US-2620: `match` was computed purely from expected-vs-applied, and both are
   * maxima. So production reported `{"applied":"00606","status":"match",
   * "missing":["00594"]}` — a migration that never ran, next to a field saying
   * the schema matched. vault/10-ops/launch-checklist.md's "All migrations
   * applied" row tells an operator to look for `status:"match"` and then
   * caveats the maximum in prose, which is not where anyone looks mid-incident.
   *
   * `incomplete` exists so the field named "status" cannot say the schema is
   * fine while naming a migration that is missing from it. It is deliberately
   * ranked above `match` and below nothing else: `behind` is already fatal at
   * boot, and `ahead` is the normal migrate-then-deploy window.
   */
  status: "match" | "ahead" | "behind" | "unknown" | "incomplete";
  /**
   * US-2603: versions in this build's manifest that the database has NOT
   * recorded — i.e. migrations that never ran, sitting UNDER the maximum.
   *
   * `applied` above is a MAX, and a max cannot see a hole beneath it. That is
   * not theoretical here: on 2026-08-15 production reported applied 00606 while
   * the owner confirmed only some of 00604–00606 had actually been run, and the
   * only way to find out which was a psql session. `checkSchemaCompleteness`
   * has computed exactly this since US-2009 — it just logged the answer into a
   * container nobody reads.
   *
   * Absent when the set is complete or could not be read; `complete: false`
   * distinguishes the second case, because "we do not know" must never render
   * as "clean".
   */
  missing?: string[];
  /** Recorded by the database with no such migration in this build (phantoms). */
  unexpected?: string[];
  /** False when the applied SET could not be read — not a claim of health. */
  complete?: boolean;
}

// US-2603: /health/ready is polled by the uptime monitor, and the completeness
// check reads every recorded version. Cache it for a minute so a monitor pays
// for one read per minute while an operator curling twice in a row still gets a
// fresh answer within the next tick. NOT a boot-time snapshot: the case this
// exists for is a migration applied (or skipped) while the container is up, and
// a snapshot taken at boot is stale exactly then.
export const SCHEMA_COMPLETENESS_TTL_MS = 60_000;
let completenessCache: { at: number; value: SchemaCompleteness } | null = null;

/** Test seam — drops the cache so a case does not inherit the previous one. */
export function resetSchemaCompletenessCache(): void {
  completenessCache = null;
}

export async function cachedSchemaCompleteness(
  now: number = Date.now(),
  read: () => Promise<SchemaCompleteness> = () => checkSchemaCompleteness(),
): Promise<SchemaCompleteness> {
  if (completenessCache && now - completenessCache.at < SCHEMA_COMPLETENESS_TTL_MS) {
    return completenessCache.value;
  }
  const value = await read();
  // A failed read is NOT cached. Caching `checked:false` would hold the "we do
  // not know" answer for a minute past a transient blip, and this endpoint's
  // whole job is to answer the question rather than defer it.
  if (value.checked) completenessCache = { at: now, value };
  return value;
}

export function summarizeSchema(
  expected: string,
  applied: string | null,
  completeness?: { missing: string[]; unexpected: string[]; checked: boolean },
): SchemaSummary {
  const base: SchemaSummary = {
    expected,
    applied,
    status: compareSchemaVersion(expected, applied),
  };
  if (!completeness) return base;
  if (!completeness.checked) return { ...base, complete: false };
  const missing = completeness.missing;
  return {
    ...base,
    // A gap under the maximum outranks the version relation. Only `match` is
    // overridden: `behind` and `unknown` are already worse, and quietly
    // relabelling either would hide a more severe finding behind a less severe
    // word — the exact failure this line exists to fix, inverted.
    ...(missing.length > 0 && base.status === "match"
      ? { status: "incomplete" as const }
      : {}),
    ...(missing.length > 0 ? { missing } : {}),
    ...(completeness.unexpected.length > 0 ? { unexpected: completeness.unexpected } : {}),
  };
}

// US-2001: "carries no build identity" is defined ONCE, in release-identity.ts,
// and this file now asks that module rather than keeping its own set. It used to
// hold `["dev", "unknown", ""]` — a strict subset that would have reported "ok"
// for a release of `local`, `none` or `latest` while env-validation's own list
// called those placeholders. Two lists meant /health/ready could contradict
// itself between two adjacent keys.
//
// Either way the meaning is the same: every Sentry event, log line and trace
// from this container is tagged with a value that cannot be traced to a commit,
// so "did the fix ship?" is unanswerable for the half of the system handling
// grading, payments, eBay writes and webhooks.

/**
 * US-2001 AC4. Reports the release as a DEGRADED FEATURE rather than failing
 * readiness.
 *
 * The AC offered either option ("REFUSE to report healthy-and-production ... or
 * at minimum surface it as a degraded feature"). Degraded is the right one, and
 * this file already argues why a few lines down: a probe that can fail a
 * container over a diagnostic is a worse bug than the blind spot it fixes.
 * Refusing readiness on an untagged build would take the whole edge out of
 * rotation — including grading and payments — to protect observability. That
 * trade is backwards.
 *
 * Pure so it is unit-testable without env manipulation.
 */
export function releaseReadiness(release: string, env: string): string {
  if (!isPlaceholderRelease(release)) return "ok";
  // ⚠ The wording used to assert a CAUSE — "the image was built without a
  // GIT_SHA build arg". On 2026-08-09 prod was measured still reporting this on
  // an image built AFTER all three compose files declared that arg, so the
  // message was confidently naming the wrong thing and sending each reader back
  // to the build args. State the symptom and list what was actually checked.
  const detail =
    `unattributable: release="${release}" — none of ` +
    `${RELEASE_ENV_KEYS.join(", ")} held a real commit, so errors cannot be ` +
    `tied to a build. Either the image was built without a GIT_SHA build arg ` +
    `or none of those vars is set at runtime (see COOLIFY.md, US-2001)`;
  // Outside production an untagged local/dev build is expected, not a defect.
  return isProductionEnv(env) ? detail : `${detail} [non-production]`;
}

// US-2447: how long a watchdog heartbeat stays credible. The script runs every
// minute, so 15 makes a genuine gap unmistakable while absorbing a slow cron, a
// container restart (which the watchdog itself causes) and the 30s
// system-settings cache.
export const WATCHDOG_STALE_AFTER_MS = 15 * 60_000;

/**
 * US-2447 AC3. Is the host hang-watchdog still checking in?
 *
 * THE BLIND SPOT THIS FILLS. `/opt/gradethread/edge-watchdog.sh` is the only
 * thing that ends an edge hang — `restart: unless-stopped` fires on process
 * EXIT and a hang never exits. It has always lived only on the host, so nothing
 * in a checkout could tell whether it was still installed, and the sole way to
 * find out was the next outage. On 2026-08-09 an outage ran at least ~8 minutes
 * against a documented ~60s cap and there was no way to say why.
 *
 * "unconfigured" is the honest answer for a null, and it is what prod will
 * report until an operator installs the script from `scripts/ops/`. That is the
 * point rather than a rollout wart: today the true state IS unknown, and a
 * feature entry saying so is strictly better than the silence it replaces.
 *
 * Informational only, for the same reason `release` is: taking the edge out of
 * rotation — grading, payments, webhooks — to protest a missing safety net
 * would cause the outage the safety net exists to shorten.
 *
 * Pure so it is unit-testable without a clock or a database.
 */
export function watchdogReadiness(
  lastSeenMs: number | null,
  nowMs: number,
  staleAfterMs: number = WATCHDOG_STALE_AFTER_MS,
): string {
  if (lastSeenMs === null || !Number.isFinite(lastSeenMs) || lastSeenMs <= 0) {
    return "unconfigured: no host watchdog has ever checked in — an edge hang " +
      "would not be capped (install scripts/ops/edge-watchdog.sh, US-2447)";
  }
  const ageMs = nowMs - lastSeenMs;
  // A heartbeat from the future means a clock skew, not health. Treat it as
  // present rather than inventing a third verdict: the check is "did something
  // report in recently", and it did.
  if (ageMs <= staleAfterMs) return "ok";
  const mins = Math.floor(ageMs / 60_000);
  return `stale: last host-watchdog heartbeat ${mins}m ago (expected every ` +
    `minute) — assume an edge hang would NOT be capped`;
}

/**
 * US-2351 AC7: GoTrue's OTP expiry, which is the REAL ceiling on an
 * impersonation token and was an operator lookup until now.
 *
 * Why it matters, stated so the number is not read as trivia: impersonation
 * mints a magiclink through adminGenerateLink, and supabase/auth applies
 * `config.Mailer.OtpExp` to signup, invite, recovery and magiclink alike
 * through one `isOtpExpired()` call. So the 30-minute cap this codebase
 * enforces is only the shorter of two limits, and this is the other one.
 *
 * "never observed" is a real answer with two causes, and they are worth
 * telling apart: either no auth email has been sent since this shipped, or
 * GoTrue is not calling the send-email hook at all — which the auth_email_hook
 * line above cannot distinguish either, because it only proves OUR secret is
 * set.
 */
export function otpExpiryReadiness(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
    return "never observed: no auth email has reached the send-email hook yet, " +
      "so GoTrue's OTP expiry is unknown — it is the real ceiling on an " +
      "impersonation token (US-2351)";
  }
  const mins = Math.round(seconds / 60);
  const capMins = 30;
  const binding = mins <= capMins
    ? `GoTrue's ${mins}m is the binding limit`
    : `the 30m code cap is the binding limit`;
  return `ok — GoTrue OTP expiry ${seconds}s (~${mins}m); ${binding}`;
}

/**
 * US-2687: does the `claude_connector` flag say on, say off, or say nothing?
 *
 * isFeatureEnabled fails OPEN, so a missing row and an unreachable flag store
 * BOTH return the caller's default and a single read cannot tell either of them
 * from a rule that genuinely says on. Read it twice with opposite defaults:
 * agreement means a real rule was read, disagreement means both calls fell back.
 *
 * Both reads hit the same flag cache, so this is one query, not two.
 *
 * EXPORTED so its test drives THIS function rather than a copy of it. The copy
 * is the failure US-2789 spent itself measuring: a guard that re-implements the
 * thing it checks stays green through any change to the original.
 */
export async function connectorFlagState(): Promise<"on" | "off" | "unreadable"> {
  const [open, closed] = await Promise.all([
    isFeatureEnabled("claude_connector", { defaultEnabled: true }),
    isFeatureEnabled("claude_connector", { defaultEnabled: false }),
  ]);
  return open === closed ? (open ? "on" : "off") : "unreadable";
}

/**
 * US-2687: is the Claude connector actually serving, and which switch stopped it?
 *
 * WHY THIS EXISTS. The connector has two independent kill switches — the
 * MCP_ENABLED env var (deploy-time) and the `claude_connector` feature flag
 * (runtime) — and NEITHER was observable from outside. main.ts mounts
 * mcpAuthMiddleware before app.route("/mcp"), while the kill switch's 404 lives
 * inside the route handler, so production answers 401 to an unauthenticated
 * probe whether the connector is live or dark. The two states are
 * indistinguishable, which is a bad property for a stop button: during an
 * incident you flip the flag and have no way to confirm it took, short of
 * holding credentials for the thing you are trying to stop.
 *
 * `flagState` distinguishes three cases, not two, because isFeatureEnabled()
 * fails OPEN — a missing row and an unreachable flag store both return the
 * caller's default. Reporting that as "live" would be the same blind spot in a
 * new place. Resolve it by reading the flag twice with opposite defaults: agree
 * means a real row was read, disagree means there was nothing to read.
 *
 * Informational only, like `release` and `hostWatchdog`. A dark connector must
 * never take grading and payments out of rotation.
 *
 * Pure so it is unit-testable without an environment or a database.
 */
export function connectorReadiness(
  envEnabled: boolean,
  flagState: "on" | "off" | "unreadable",
): string {
  if (!envEnabled) {
    return "off: MCP_ENABLED is not enabled for this deploy — /mcp returns 404 " +
      "inside the handler, but the auth middleware in front of it answers 401 " +
      "first, so this state is invisible from outside (US-2687)";
  }
  if (flagState === "off") {
    return "off: the claude_connector kill switch is set — MCP_ENABLED is on, " +
      "so this is the runtime stop button rather than the deploy default";
  }
  if (flagState === "unreadable") {
    // The fail-open default is what SERVES, so the connector really is live.
    // Saying only "live" would hide that nothing was actually read.
    return "live: MCP_ENABLED on, and claude_connector has no readable rule — " +
      "the flag fails OPEN, so the connector is serving on a default, not on a " +
      "decision. The kill switch cannot stop it until a rule row exists";
  }
  return "live";
}

// Pure decision (unit-tested) so the route's I/O stays trivial. `features` is
// informational: overall readiness is still just DB + core env so a missing
// optional integration can't take the container out of rotation.
export function summarizeReadiness(
  dbOk: boolean,
  missingEnv: string[],
  features: Record<string, string> = {},
  schema?: SchemaSummary,
): ReadinessSummary {
  const ready = dbOk && missingEnv.length === 0;
  return {
    ready,
    httpStatus: ready ? 200 : 503,
    body: {
      status: ready ? "ready" : "not_ready",
      checks: {
        database: dbOk ? "ok" : "fail",
        env: missingEnv.length === 0 ? "ok" : "missing",
      },
      ...(missingEnv.length > 0 ? { missing_env: missingEnv } : {}),
      ...(Object.keys(features).length > 0 ? { features } : {}),
      // Informational, like `features` — never part of the ready decision.
      ...(schema ? { schema } : {}),
    },
  };
}

// Liveness — restart probe. Never touches a dependency.
// US-491/513: also reports the deployed commit SHA and whether the exception
// tracker is wired up, so a deploy's running version and observability posture
// are visible without leaking the DSN.
// US-520: `env` (production/staging/development) lets the staging smoke test
// assert it is talking to a staging deploy — and, inversely, that the prod
// host never reports anything but "production". Reveals no secret.
healthRoutes.get("/", (c) => {
  return c.json({
    status: "ok",
    service: "gradethread-edge-functions",
    env: edgeEnv(),
    release: releaseSha(),
    errorTracking: isErrorTrackingConfigured() ? "enabled" : "disabled",
    timestamp: new Date().toISOString(),
  });
});

// US-491 verification hook: a forced exception path so an operator can confirm
// the tracker receives events end-to-end. Gated to NON-production (returns 404
// in prod so it can't be used as a noise/abuse vector). Throws into app.onError,
// which captures to the tracker with the release SHA + correlation id.
healthRoutes.get("/_throw", (c) => {
  // Through isProduction(), NOT a third copy of the env chain. This carried its
  // own `EDGE_ENV ?? DENO_ENV ?? "production"`, and `??` never falls through on
  // an empty string — so a BLANK EDGE_ENV made this endpoint reachable in
  // production, which is exactly the abuse vector the 404 above exists to close:
  // an unauthenticated URL that throws on every call. Same defect as lib/env.ts
  // and lib/release-identity.ts; this was the third copy.
  if (isProduction()) {
    return c.json({ error: "Not found" }, 404);
  }
  throw new Error("Forced test exception from /health/_throw (US-491 verification)");
});

// US-573: memory + capacity snapshot. Dependency-free (like liveness) so it can
// be sampled at high frequency during a load test without touching the DB. It
// exposes only process memory figures (RSS/heap vs. the configured container
// limit) and the grading buffer-pipeline cap — no secrets — so it's safe to
// leave unauthenticated, consistent with `/health` already exposing the release.
// `scripts/ops/loadtest-grading.mjs` samples this to gate "no OOM at target
// concurrency"; ops watches `memory.pressure` for the scale-out rule (vault/10-ops/capacity.md).
healthRoutes.get("/metrics", (c) => {
  const rawLimit = Number(Deno.env.get("EDGE_MEMORY_LIMIT_MB"));
  const limitMb = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : null;
  const memory = summarizeMemory(Deno.memoryUsage(), limitMb);
  return c.json({
    service: "gradethread-edge-functions",
    env: edgeEnv(),
    release: releaseSha(),
    memory,
    grading: { buffer_pipeline_cap: gradingBufferConcurrency() },
    timestamp: new Date().toISOString(),
  });
});

// Readiness — dependency probe. 503 when a hard dependency is unreachable.
healthRoutes.get("/ready", async (c) => {
  const missingEnv = missingCriticalEnv();

  let dbOk = false;
  try {
    // Tiny HEAD count on the PK index — cheapest "can we reach Postgres?" query.
    const { error } = await supabaseAdmin
      .from("users")
      .select("id", { head: true, count: "exact" })
      .limit(1);
    dbOk = !error;
  } catch {
    dbOk = false;
  }

  // Applied schema version. Best-effort: a failure here reports status
  // "unknown" and must never affect readiness — this is a visibility feature,
  // and a probe that can fail a container over a diagnostic is a worse bug than
  // the blind spot it fixes.
  let applied: string | null = null;
  if (dbOk) {
    try {
      const { data, error } = await supabaseAdmin.rpc("latest_schema_migration");
      applied = !error && typeof data === "string" ? data : null;
    } catch {
      applied = null;
    }
  }

  // US-2603: the SET, not just the max. Cached, because /health/ready is polled
  // by the uptime monitor and this reads every recorded version — an operator
  // curling twice gets a fresh answer, a monitor polling every minute does not
  // pay for one. Best-effort in the same way as the version read above: a
  // failure reports `complete: false` rather than an empty (clean-looking) set.
  let completeness: SchemaCompleteness | undefined;
  if (dbOk) {
    try {
      completeness = await cachedSchemaCompleteness();
    } catch {
      completeness = { missing: [], unexpected: [], checked: false };
    }
  }

  // US-2447: last host-watchdog heartbeat. Best-effort like the schema read
  // above, and for the same reason — a diagnostic must not be able to fail the
  // probe. A read failure reports "unconfigured", which overstates the problem
  // rather than understating it; that is the correct direction for a safety-net
  // check.
  let watchdogLastSeen: number | null = null;
  if (dbOk) {
    try {
      watchdogLastSeen = await getSetting<number | null>(WATCHDOG_HEARTBEAT_KEY, null);
    } catch {
      watchdogLastSeen = null;
    }
  }

  // US-2351 AC7: the same shape, and the same reason — a fact that only
  // something reporting in can tell us, cached where a probe can read it.
  let otpExpirySeconds: number | null = null;
  if (dbOk) {
    try {
      otpExpirySeconds = await getSetting<number | null>(OTP_EXPIRY_KEY, null);
    } catch {
      otpExpirySeconds = null;
    }
  }

  // US-2687: the connector's two kill switches, neither of which could be
  // observed from outside. Best-effort like every other diagnostic here — the
  // env half needs no I/O, and a flag-store failure reports "unreadable"
  // (which is the truth) rather than failing the probe.
  let connectorFlag: "on" | "off" | "unreadable" = "unreadable";
  if (dbOk && isMcpEnabled()) {
    try {
      connectorFlag = await connectorFlagState();
    } catch {
      connectorFlag = "unreadable";
    }
  }

  const summary = summarizeReadiness(
    dbOk,
    missingEnv,
    {
      ...computeFeatureReadiness(undefined, {
        // US-2612: the one thing about this feature that cannot be read out of
        // our own environment, and can be observed.
        pages_origin_bypass: pagesOriginEvidenceLine(
          pagesOriginObservation(),
          Date.now(),
        ),
      }),
      // US-2001: sits alongside the existing `observability` entry, which
      // reports "ok" purely because the Sentry DSN is present — true, and
      // misleading, while every event it ships is tagged "dev".
      release: releaseReadiness(releaseSha(), edgeEnv()),
      // US-2447: the only thing that ends an edge hang lives on the host and
      // was invisible from here until now.
      hostWatchdog: watchdogReadiness(
        typeof watchdogLastSeen === "number" ? watchdogLastSeen : null,
        Date.now(),
      ),
      // US-2351: the token lifetime that bounds an impersonation, which was
      // an operator lookup because nobody recorded what GoTrue already tells us.
      gotrueOtpExpiry: otpExpiryReadiness(
        typeof otpExpirySeconds === "number" ? otpExpirySeconds : null,
      ),
      // US-2687: two kill switches that were invisible from outside.
      connector: connectorReadiness(isMcpEnabled(), connectorFlag),
    },
    summarizeSchema(EXPECTED_SCHEMA_VERSION, applied, completeness),
  );
  return c.json(
    { ...summary.body, timestamp: new Date().toISOString() },
    summary.httpStatus,
  );
});
