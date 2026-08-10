// US-2447 AC5: the external uptime probe is the only thing that notices an edge
// hang independently of the host watchdog — and the property that makes it work
// is easy to "tidy" away.
//
// The 2026-08-09 occurrence (vault/10-ops/edge-hang-vs-crash-loop.md) opened
// with `http=000` — requests hanging to the full timeout — and only later
// settled into the clean fast 503 that note describes. So a probe that treats a
// timeout as anything other than a failure misses the opening minutes of the
// exact outage it exists to catch.
//
// Source-scanned rather than executed: running it means probing the real
// production hostnames, which a unit test must not do.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PROBE = readFileSync(resolve(ROOT, "scripts/ops/uptime-check.mjs"), "utf8");
const WORKFLOW = readFileSync(resolve(ROOT, ".github/workflows/uptime.yml"), "utf8");

describe("US-2447 AC5: the uptime probe stays watchdog-independent", () => {
  it("treats a hang as a failure, not as a skip", () => {
    // The AbortError branch is the whole point. If a timeout ever became
    // "inconclusive, try again next run", the first minutes of a hang would
    // read as silence rather than as an outage.
    expect(PROBE).toMatch(/AbortError/);
    expect(PROBE).toMatch(/timeout after \$\{TIMEOUT_MS\}ms/);
    // …and it must be produced as an ERROR value, inside the catch that feeds
    // the failure path — not logged and swallowed.
    const catchBlock = PROBE.slice(PROBE.indexOf("} catch (err) {"));
    expect(catchBlock.slice(0, 600)).toMatch(/error:/);
  });

  it("probes the readiness endpoint, which is what a wedged process fails", () => {
    // /health alone can answer while the process is spinning. /health/ready is
    // the one that goes down with a dependency or a hang.
    //
    // Pinned to the URL EXPRESSION, not to the file: the path also appears in a
    // comment above it, so a file-wide match stayed green when the target was
    // changed. Same use-versus-mention miss the structural guards catalogue.
    expect(PROBE).toMatch(/url:\s*`\$\{EDGE_URL\}\/health\/ready`/);
  });

  it("runs outside prod infrastructure, on a schedule, with somewhere to shout", () => {
    // Independence is the property: a host that is wedged entirely still gets
    // caught, because nothing about this runs on that host.
    expect(WORKFLOW).toMatch(/runs-on:\s*ubuntu/);
    expect(WORKFLOW).toMatch(/cron:\s*"\*\/\d+ \* \* \* \*"/);
    // The ENV WIRING, not the name — the secret is also named in a comment at
    // the top of the workflow, so matching the bare identifier passed while the
    // step no longer received it and every alert went nowhere.
    expect(WORKFLOW).toMatch(/UPTIME_ALERT_WEBHOOK:\s*\$\{\{\s*secrets\.UPTIME_ALERT_WEBHOOK\s*\}\}/);
  });

  it("its cadence cannot validate the watchdog's ~60s cap, and that is recorded", () => {
    // Not a defect — GitHub cron cannot go below five minutes and is
    // best-effort. It is a limit that has to stay written down, because the
    // tempting reading of "we have uptime monitoring" is that the cap is
    // covered. An outage shorter than the poll interval is invisible here by
    // construction.
    const cron = /cron:\s*"\*\/(\d+) \* \* \* \*"/.exec(WORKFLOW);
    expect(cron, "the schedule changed shape — re-read the note").not.toBeNull();
    expect(Number(cron[1])).toBeGreaterThanOrEqual(5);

    const note = readFileSync(
      resolve(ROOT, "vault/10-ops/edge-hang-vs-crash-loop.md"),
      "utf8",
    );
    expect(
      note,
      "the ~60s cap must not be stated as fact — it is unverified, and the one " +
        "measurement we have contradicts it by about eight minutes",
    ).toMatch(/UNVERIFIED/);
    expect(note).toMatch(/cannot validate a ~60s cap/);
  });
});
