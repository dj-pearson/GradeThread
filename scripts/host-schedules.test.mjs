// US-2447 AC3: the hang watchdog's existence is checkable WITHOUT SSH.
//
// The script was believed to run every minute at /opt/gradethread/edge-watchdog.sh
// and had never been in version control. So when the edge hung for at least ~8
// minutes on 2026-08-09 against a documented ~60s cap, nothing in a checkout
// could distinguish "the watchdog fired late" from "it failed" from "it was
// uninstalled months ago". The only thing that ever reported the answer was an
// outage, which is the worst possible time to go and look.
//
// Two halves have to hold together or the check is theatre:
//   1. the script and its exact crontab line live here, as the source of truth;
//   2. something the script does is OBSERVABLE from outside the host, so its
//      absence shows up during normal operation.
//
// This file pins the wiring between them. It cannot prove the script is
// installed on the box — nothing in a checkout can, which is precisely why the
// heartbeat exists.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

const MANIFEST = JSON.parse(read("scripts/ops/host-schedules.json"));
const SCRIPT = read("scripts/ops/edge-watchdog.sh");
const HEALTH = read("services/edge-functions/src/routes/health.ts");
const HEARTBEAT = read("services/edge-functions/src/routes/jobs-watchdog-heartbeat.ts");
const MAIN = read("services/edge-functions/src/main.ts");
const PROBE = read("scripts/ops/uptime-check.mjs");

const watchdog = MANIFEST.schedules.find((s) => s.id === "edge-watchdog");

describe("US-2447 AC3: the host watchdog is in the repo and its absence is detectable", () => {
  it("the manifest names the script that actually exists here", () => {
    expect(watchdog, "no edge-watchdog entry in host-schedules.json").toBeTruthy();
    expect(() => read(watchdog.script)).not.toThrow();
  });

  it("the documented crontab line runs the documented install path on the documented schedule", () => {
    // Three fields that must agree or an operator installs one thing and the
    // manifest describes another. The crontab line is what gets pasted, so it
    // is the one that has to be right.
    expect(watchdog.crontabLine).toContain(watchdog.cron);
    expect(watchdog.crontabLine).toContain(watchdog.installedAt);
    // And the script itself carries the same line in its install instructions,
    // because that is the copy the person installing it is looking at.
    expect(SCRIPT).toContain(watchdog.crontabLine);
  });

  it("the script is a POSIX shell script with an LF shebang", () => {
    // .gitattributes pins *.sh to LF. A CRLF shebang makes the host's sh fail
    // with "bad interpreter: ...^M", which on a cron job is a silent no-op —
    // i.e. the exact invisible-absence this story exists to end, reintroduced
    // by a line ending.
    expect(SCRIPT.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(SCRIPT).not.toMatch(/\r/);
  });

  it("the script does nothing unless Docker itself says unhealthy", () => {
    // A watchdog that restarts on its own opinion of health is a reboot loop.
    // It must defer to the same verdict Traefik acts on.
    expect(SCRIPT).toMatch(/docker inspect/);
    expect(SCRIPT).toMatch(/State\.Health/);
    expect(SCRIPT).toMatch(/= "unhealthy"/);
    // An empty health status means NO healthcheck configured, which is a
    // config problem rather than a hang — restarting on it loops forever.
    expect(SCRIPT).toMatch(/-z "\$health"/);
  });

  it("the heartbeat has a receiver, a store and a mount", () => {
    expect(watchdog.heartbeat.endpoint).toBe("POST /api/jobs/watchdog-heartbeat");
    expect(SCRIPT).toContain("/api/jobs/watchdog-heartbeat");
    expect(HEARTBEAT).toContain(`"${watchdog.heartbeat.settingKey}"`);
    expect(MAIN).toMatch(/app\.post\("\/api\/jobs\/watchdog-heartbeat"/);
  });

  it("the heartbeat endpoint's secret gate is WIRED, not merely mentioned", () => {
    // It writes a row that a health surface reports on. An unauthenticated
    // writer could forge a heartbeat and make an absent watchdog read as
    // present — turning the detector into a source of false confidence, which
    // is worse than the blind spot it fills.
    //
    // ⚠ THIS ASSERTION USED TO BE `toMatch(/requireJobSecret/)` PLUS
    // `toMatch(/401/)`, AND IT PROVED NOTHING. Sabotaging the gate to
    // `if (false)` left both strings in the file and the test stayed green — a
    // dead gate and a live one are indistinguishable to a token search. Pin the
    // whole branch, and note that the real proof is behavioural: the deno case
    // "US-2447: an unauthenticated heartbeat is refused before any write" in
    // watchdog-heartbeat_test.ts actually calls the handler.
    expect(HEARTBEAT).toMatch(
      /if\s*\(!\(await requireJobSecret\(c\)\)\)\s*\{\s*\n\s*return c\.json\(\{ error: "Unauthorized" \}, 401\);/,
    );
    // …and the gate must come before the write, not beside it.
    expect(HEARTBEAT.indexOf("requireJobSecret")).toBeLessThan(
      HEARTBEAT.indexOf("supabaseAdmin.from"),
    );
  });

  it("health/ready reports the state, and a missing watchdog cannot fail the probe", () => {
    expect(HEALTH).toMatch(/hostWatchdog:/);
    expect(HEALTH).toMatch(/export function watchdogReadiness/);
    // The feature map is informational by construction: summarizeReadiness
    // computes `ready` from dbOk + missingEnv only. Pin that, because the
    // tempting "improvement" is to gate readiness on it — which would pull the
    // edge out of rotation to protest a missing safety net, causing the outage
    // the net exists to shorten.
    expect(HEALTH).toMatch(/const ready = dbOk && missingEnv\.length === 0;/);
  });

  it("the external probe surfaces the state without paging on it", () => {
    // It will read "unconfigured" until an operator installs the script. An
    // alert that fires every ten minutes forever gets muted, and a muted
    // monitor is worse than none.
    expect(PROBE).toMatch(/hostWatchdog/);
    expect(PROBE).toMatch(/bodyNote/);

    // `up` must never be computed from a NOTE. That is the property; the exact
    // set of hard checks is not.
    //
    // This asserted the literal string "up: statusOk && bodyOk" and broke the
    // day US-2619 added a real third condition (bytesOk — a zero-byte OG image
    // is a genuine failure, not a note). Pinning the spelling made a correct
    // change look like a regression, which is the mode-0 trap: a scan that
    // pins how a line is WRITTEN rather than what it MEANS. So: the expression
    // must still start from statusOk, and must not mention note/Note at all.
    const upLine = PROBE.match(/up:\s*statusOk[^,\n]*/)?.[0] ?? "";
    expect(upLine, "up: must be derived from statusOk").toMatch(/^up:\s*statusOk/);
    expect(
      /\bnote\b/i.test(upLine),
      `\`${upLine}\` folds the note into up. A note is informational by ` +
        `construction — the watchdog reads "unconfigured" until an operator ` +
        `installs the script, and an alert that fires every ten minutes ` +
        `forever gets muted.`,
    ).toBe(false);
  });

  it("the staleness window in the manifest matches the one the code enforces", () => {
    // Two places state "how long is a heartbeat good for". They drift the
    // moment one is tuned, and the manifest is what a human reads.
    const mins = watchdog.heartbeat.staleAfterMinutes;
    expect(HEALTH).toMatch(
      new RegExp(`WATCHDOG_STALE_AFTER_MS\\s*=\\s*${mins}\\s*\\*\\s*60_000`),
    );
  });

  it("does not claim to cover the edge cron fleet, which has its own registry", () => {
    // Two half-registries that disagree is the shape this repo keeps relearning.
    // US-2313 owns making the ~74 /api/jobs/* schedules verifiable; this file is
    // host-level only, and the scope note has to survive so nobody folds them
    // together or reads this as US-2313 being done.
    const scope = JSON.stringify(MANIFEST.$comment);
    expect(scope).toMatch(/CRON_REGISTRY/);
    expect(scope).toMatch(/US-2313/);
    for (const s of MANIFEST.schedules) {
      expect(
        s.installedAt,
        `${s.id} has no host install path — is it really a host schedule?`,
      ).toMatch(/^\//);
    }
  });
});
