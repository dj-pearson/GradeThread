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
  hasEnvAlertChannel,
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

// ── US-2003 AC2: a deploy that cannot page anyone says so ───────────────────
//
// Every alert channel is optional and every one degrades to silence. The only
// record of "nothing can reach a human" was an `ops_event.alert_undelivered`
// metric, which itself has no alert - so the one message guaranteed not to
// arrive was the news that no message arrives.

Deno.test("US-2003: any single env channel counts as having one", () => {
  for (const key of ["MONITOR_ALERT_WEBHOOK", "MONITOR_ALERT_EMAIL", "SMTP_ADMIN_EMAIL"]) {
    assert(
      hasEnvAlertChannel((k) => (k === key ? "set" : undefined)),
      `${key} alone did not count as a channel`,
    );
  }
});

Deno.test("US-2003: nothing set means no channel", () => {
  assert(!hasEnvAlertChannel(() => undefined));
});

Deno.test("US-2003: a blank variable is not a channel", () => {
  // A dashboard variable set to "" or " " is SET as far as the shell is
  // concerned, and it pages nobody. Treating it as configured is exactly the
  // false confidence this story is about.
  for (const blank of ["", " ", "   ", "\t"]) {
    assert(
      !hasEnvAlertChannel((k) => (k === "MONITOR_ALERT_WEBHOOK" ? blank : undefined)),
      `a whitespace value (${JSON.stringify(blank)}) counted as a channel`,
    );
  }
});

Deno.test("US-2003: SMTP_ADMIN_EMAIL alone still counts, and that is deliberate", () => {
  // It is the weakest of the three - it rides the same mail path whose DELIVERY
  // is unproven (US-2597) - but it IS a channel, and this check answers
  // "is anything configured", not "does anything arrive". The drill answers the
  // second, and nothing in the repo can.
  assert(hasEnvAlertChannel((k) => (k === "SMTP_ADMIN_EMAIL" ? "ops@example.com" : undefined)));
});

Deno.test("US-2003: the boot check is wired, in production only, and is NOT fatal", () => {
  // A SOURCE SCAN, and the right instrument here: what has to hold is a
  // property of the call site. AC2 offers "fail at boot (or emit at critical)",
  // and refusing to start would trade a blind monitor for a dead service - the
  // edge handles grading, payments and eBay writes, none of which get safer by
  // being off.
  const src = Deno.readTextFileSync(new URL("../main.ts", import.meta.url));
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

  assert(
    code.includes("edge.boot.no_alert_channel"),
    "the no-alert-channel boot check was removed",
  );

  // SLICED FROM THE GUARD, not from the log line. The first version of this
  // started at "edge.boot.no_alert_channel" and scanned forward, so a
  // `Deno.exit(1)` inserted one line ABOVE the logEvent call sat outside the
  // window and the sabotage run passed green with a fatal boot check. Read the
  // whole `if` body or the check only covers half of it.
  const guardStart = code.indexOf("if (isProduction() && !hasEnvAlertChannel()) {");
  assert(
    guardStart > -1,
    "the boot check no longer guards on production plus a missing channel",
  );
  // The `if` body ends at the first `}` in column 0 after it — this block is at
  // top level in main.ts, so nothing nested can close it early.
  const block = code.slice(guardStart, code.indexOf("\n}", guardStart));
  assert(
    block.includes("edge.boot.no_alert_channel"),
    "the guard no longer wraps the boot log",
  );
  assert(
    !/Deno\.exit|throw |process\.exit/.test(block),
    "the boot check became fatal - a deploy that cannot page is a serious " +
      "problem and is not a reason to stop taking payments",
  );
});

Deno.test("US-2003: an alert that reached nobody is captured, not just counted", () => {
  // The gap this closes is the SECOND one, which the story did not name: two
  // channels configured and BOTH failing was recorded nowhere at all. The
  // condition has to be "did this land anywhere", not "was anything set up".
  const src = Deno.readTextFileSync(new URL("../lib/ops-events.ts", import.meta.url));
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

  const start = code.indexOf("if (!emailOk && !webhookOk)");
  assert(
    start > -1,
    "dispatchOpsAlert no longer keys on delivery - it is back to keying on " +
      "configuration, so configured-but-failing channels are silent again",
  );
  const block = code.slice(start, start + 1400);
  assert(block.includes("captureException("), "a fully undelivered alert is only counted, not raised");
  assert(
    block.includes('recordMetric("ops_event.alert_undelivered"'),
    "the narrower unconfigured metric was dropped - it is what tells an " +
      "operator to set a variable rather than to go and fix an endpoint",
  );
});
