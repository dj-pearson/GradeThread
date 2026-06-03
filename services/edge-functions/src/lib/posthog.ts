// Server-side PostHog capture (US-216 / US-219).
//
// The frontend has its own consent-gated PostHog SDK (src/lib/analytics.ts),
// but several billing/trial lifecycle events only happen server-side with no
// browser in the loop — Stripe webhooks (subscription.ended) and scheduled
// crons (trial.expiring_3d, trial.expired_to_free). Those fire through here.
//
// This is a thin, fire-and-forget wrapper over PostHog's HTTP capture API. It
// no-ops when POSTHOG_KEY is unset (e.g. local/dev) and NEVER throws into the
// caller — analytics must never fail a webhook or cron. We don't await network
// here; callers may `void captureServer(...)` or await it (it always resolves).
//
// Env:
//   POSTHOG_KEY   — PostHog project API key (same public key the SPA uses)
//   POSTHOG_HOST  — defaults to https://us.i.posthog.com

export async function captureServer(
  distinctId: string,
  event: string,
  properties: Record<string, unknown> = {},
): Promise<void> {
  try {
    const key = Deno.env.get("POSTHOG_KEY")?.trim();
    if (!key || !distinctId) return; // not configured — silent no-op

    const host =
      Deno.env.get("POSTHOG_HOST")?.trim() || "https://us.i.posthog.com";

    const res = await fetch(`${host.replace(/\/$/, "")}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        event,
        distinct_id: distinctId,
        properties: { ...properties, $lib: "gradethread-edge" },
        timestamp: new Date().toISOString(),
      }),
    });
    // Drain the body so the connection can be reused; ignore the result.
    await res.body?.cancel();
  } catch (err) {
    console.error(`[posthog] capture '${event}' failed:`, err);
  }
}
