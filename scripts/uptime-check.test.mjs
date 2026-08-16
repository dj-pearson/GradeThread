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

// US-2618 AC4: "a page that serves 200 with no content is the failure mode
// nothing currently notices". The Help Center hub is that page today — 83
// articles written, none in the database, and `renderCategoryGrid` returns ""
// when every category is empty, so the hub renders its heading and search box
// and stops. It looks finished.
describe("US-2618 AC4: an empty Help Center is noticed", () => {
  const target = () => {
    const at = PROBE.indexOf('id: "help_hub"');
    if (at === -1) return "";
    return PROBE.slice(at, PROBE.indexOf("\n  },", at));
  };

  it("the hub is probed at all", () => {
    expect(target(), "no help_hub target in the uptime probe").not.toBe("");
    expect(target()).toMatch(/\$\{SITE_URL\}\/help/);
  });

  it("it asserts on the BODY, not only the status", () => {
    // The whole point: /help returns 200 whether or not it has any content.
    // A status-only target would report the outage as healthy.
    expect(target()).toMatch(/bodyNote:/);
    expect(target()).toMatch(/related-grid/);
  });

  it("an empty hub produces a note rather than a silent pass", () => {
    // Exercise the predicate itself rather than trusting the regex above —
    // an assertion that the string `related-grid` appears would also pass on
    // a function that ignores its argument.
    const src = target().match(/bodyNote:\s*(\(bodyText\)\s*=>\s*\{[\s\S]*?\n {4}\})/);
    expect(src, "could not extract the bodyNote predicate").not.toBeNull();
    const fn = new Function(`return ${src[1]}`)();
    expect(fn('<main><h1>Help</h1><form></form></main>')).toMatch(/empty/i);
    expect(fn('<main><div class="related-grid"><a>x</a></div></main>')).toBeNull();
  });

  it("it is a NOTE, so a known-empty hub cannot mute the monitor", () => {
    // It is empty right now. Failing would open an incident issue immediately
    // and keep the monitor red until someone runs the seed — and a monitor
    // that is red for a known reason is one nobody reads during a real
    // outage. Same call, and the same reasoning, as hostWatchdog above.
    expect(target()).not.toMatch(/bodyOk:/);
    expect(PROBE).toMatch(/A note never contributes to `up`/);
  });
});
