// US-906: ops activity feed + alert routing — pure-logic unit tests.
//
// ops-events.ts imports the service-role supabase client (and email.ts) at init;
// set dummy env BEFORE the dynamic import so the import doesn't throw.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  severityAtLeast,
  shouldFanOut,
  isOpsSeverity,
  resolveAlertEmail,
  resolveAlertWebhook,
  OPS_SEVERITIES,
} = await import("../lib/ops-events.ts");

type Config = {
  enabled: boolean;
  minSeverity: "info" | "warning" | "critical";
  webhookUrl: string;
  email: string;
  mutedTypes: string[];
};

const baseConfig: Config = {
  enabled: true,
  minSeverity: "warning",
  webhookUrl: "",
  email: "",
  mutedTypes: [],
};

// ── severity ranking ─────────────────────────────────────────────

Deno.test("severityAtLeast: ranking is info < warning < critical", () => {
  assert(severityAtLeast("critical", "warning"));
  assert(severityAtLeast("warning", "warning"));
  assert(severityAtLeast("info", "info"));
  assert(!severityAtLeast("info", "warning"));
  assert(!severityAtLeast("warning", "critical"));
});

Deno.test("isOpsSeverity: accepts the three levels, rejects others", () => {
  for (const s of OPS_SEVERITIES) assert(isOpsSeverity(s));
  assert(!isOpsSeverity("fatal"));
  assert(!isOpsSeverity(""));
  assert(!isOpsSeverity(2));
  assert(!isOpsSeverity(undefined));
});

// ── routing decision ─────────────────────────────────────────────

Deno.test("shouldFanOut: respects the minimum severity threshold", () => {
  assertEquals(shouldFanOut("info", "job.failed", baseConfig), false);
  assertEquals(shouldFanOut("warning", "job.failed", baseConfig), true);
  assertEquals(shouldFanOut("critical", "job.failed", baseConfig), true);
});

Deno.test("shouldFanOut: master switch off suppresses everything", () => {
  const off = { ...baseConfig, enabled: false };
  assertEquals(shouldFanOut("critical", "ai_budget.kill", off), false);
});

Deno.test("shouldFanOut: a muted type is feed-only even at critical", () => {
  const muted = { ...baseConfig, mutedTypes: ["job.failed"] };
  assertEquals(shouldFanOut("critical", "job.failed", muted), false);
  // A different type still fans out.
  assertEquals(shouldFanOut("critical", "ai_budget.kill", muted), true);
});

Deno.test("shouldFanOut: a higher minimum suppresses warnings", () => {
  const critOnly = { ...baseConfig, minSeverity: "critical" as const };
  assertEquals(shouldFanOut("warning", "job.failed", critOnly), false);
  assertEquals(shouldFanOut("critical", "job.failed", critOnly), true);
});

// ── channel resolution (registry value wins, else env fallback) ───

Deno.test("resolveAlertEmail: configured value wins over env", () => {
  Deno.env.set("MONITOR_ALERT_EMAIL", "env@example.com");
  try {
    assertEquals(
      resolveAlertEmail({ ...baseConfig, email: "configured@example.com" }),
      "configured@example.com",
    );
    assertEquals(resolveAlertEmail(baseConfig), "env@example.com");
  } finally {
    Deno.env.delete("MONITOR_ALERT_EMAIL");
  }
});

Deno.test("resolveAlertWebhook: configured value wins over env, else empty", () => {
  Deno.env.delete("MONITOR_ALERT_WEBHOOK");
  assertEquals(
    resolveAlertWebhook({ ...baseConfig, webhookUrl: "https://hooks.example/x" }),
    "https://hooks.example/x",
  );
  assertEquals(resolveAlertWebhook(baseConfig), "");
  Deno.env.set("MONITOR_ALERT_WEBHOOK", "https://env.example/hook");
  try {
    assertEquals(resolveAlertWebhook(baseConfig), "https://env.example/hook");
  } finally {
    Deno.env.delete("MONITOR_ALERT_WEBHOOK");
  }
});
