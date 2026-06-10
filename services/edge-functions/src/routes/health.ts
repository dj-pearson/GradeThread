import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { isErrorTrackingConfigured, releaseSha } from "../lib/observability.ts";
import { computeFeatureReadiness } from "../lib/env-validation.ts";

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
  };
}

// Pure decision (unit-tested) so the route's I/O stays trivial. `features` is
// informational: overall readiness is still just DB + core env so a missing
// optional integration can't take the container out of rotation.
export function summarizeReadiness(
  dbOk: boolean,
  missingEnv: string[],
  features: Record<string, string> = {},
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
    },
  };
}

// Liveness — restart probe. Never touches a dependency.
// US-491/513: also reports the deployed commit SHA and whether the exception
// tracker is wired up, so a deploy's running version and observability posture
// are visible without leaking the DSN.
healthRoutes.get("/", (c) => {
  return c.json({
    status: "ok",
    service: "gradethread-edge-functions",
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
  if ((Deno.env.get("EDGE_ENV") ?? Deno.env.get("DENO_ENV") ?? "production")
    .trim().toLowerCase() === "production") {
    return c.json({ error: "Not found" }, 404);
  }
  throw new Error("Forced test exception from /health/_throw (US-491 verification)");
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

  const summary = summarizeReadiness(dbOk, missingEnv, computeFeatureReadiness());
  return c.json(
    { ...summary.body, timestamp: new Date().toISOString() },
    summary.httpStatus,
  );
});
