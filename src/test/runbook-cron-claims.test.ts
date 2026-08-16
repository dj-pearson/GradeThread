// The shipped `cron-jobs` runbook names jobs and schedules by hand, and nothing
// checked them.
//
// HOW IT WENT WRONG. On 2026-08-15 US-2617 deleted the `ebay-orders-sync`
// registry entry (ebay-order-backstop was already the same half-hourly sweep,
// working). The admin console's own runbook went on telling an operator that
// job existed and ran every thirty minutes. The cron-registry drift guard covers
// COOLIFY.md and vault/10-ops/launch-checklist.md — both generated from
// CRON_REGISTRY — and this runbook is neither: it is hand-written prose inside
// a TypeScript array, and `runbook-sync` skips it because it has no vault
// counterpart to distil from.
//
// WHY A MAP AND NOT FUZZY MATCHING. My first version matched a runbook label
// against registry labels by shared words. It flagged "Repricing scan / rules"
// as a missing job — one runbook bullet deliberately covers TWO registry entries
// (reprice-scan and reprice-rules), which no word-matcher can know. A guard that
// invents a finding is worse than none, because the person who checks the first
// name deletes the rest. So the mapping is written down, and adding a claim to
// the runbook forces a line here.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RUNBOOKS = join(process.cwd(), "src/lib/admin/runbooks.ts");
const REGISTRY = join(
  process.cwd(),
  "services/edge-functions/src/lib/cron-runs.ts",
);

/**
 * Runbook label → the CRON_REGISTRY name(s) it describes.
 *
 * A bullet may legitimately cover several jobs that share a schedule; that is
 * why the value is a list. Every name here must exist in the registry, and
 * every scheduled claim in the runbook must appear as a key.
 */
const CLAIMS: Record<string, string[]> = {
  "Email outbox retry": ["email-retry"],
  "DB integrity scan": ["integrity-scan"],
  "Data-retention purge": ["data-retention"],
  "Push-token prune": ["push-token-prune"],
  "Stuck-submission recovery": ["stuck-submissions"],
  "Grading regression monitor": ["grading-monitor"],
  "eBay sync reaper": ["sync-reaper"],
  "eBay order-sync backstop": ["ebay-order-backstop"],
  "Repricing scan / rules": ["reprice-scan", "reprice-rules"],
  "AutoLister reclaim": ["autolister-reclaim"],
  "Publish-batch reclaim": ["publish-batch-reclaim"],
  "A/B finalize": ["newsletter-ab-finalize"],
  // The registry key is `growth-dispatch`; the runbook and the registry LABEL
  // both call it "Scheduled-campaign dispatch". I wrote `campaign-dispatch`
  // from the label and the guard caught it on its first run, which is the case
  // for mapping names explicitly rather than deriving them from prose.
  "Scheduled-campaign dispatch": ["growth-dispatch"],
  "Abuse-signal scan": ["abuse-scan"],
};

interface CronEntry {
  name: string;
  schedule: string;
}

function registry(): CronEntry[] {
  const src = readFileSync(REGISTRY, "utf8");
  return [
    ...src.matchAll(/\{\s*name:\s*"([^"]+)",\s*label:\s*"[^"]+",\s*schedule:\s*"([^"]+)"/g),
  ].map((m) => ({ name: m[1]!, schedule: m[2]! }));
}

/** The `**Label** (`schedule`)` claims inside the cron-jobs runbook body. */
function runbookClaims(): Array<{ label: string; schedule: string }> {
  const src = readFileSync(RUNBOOKS, "utf8");
  const start = src.indexOf('slug: "cron-jobs"');
  expect(start, "the cron-jobs runbook was renamed or removed").toBeGreaterThan(-1);
  const next = src.indexOf("slug:", start + 10);
  const body = src.slice(start, next === -1 ? src.length : next);
  return [...body.matchAll(/\*\*([^*]+)\*\*\s*\(`([^`]+)`\)/g)].map((m) => ({
    label: m[1]!.trim(),
    schedule: m[2]!.trim(),
  }));
}

describe("US-2617: the cron-jobs runbook describes jobs that exist", () => {
  it("every job the runbook names is still in CRON_REGISTRY", () => {
    const names = new Set(registry().map((e) => e.name));
    const gone: string[] = [];
    for (const [label, keys] of Object.entries(CLAIMS)) {
      for (const k of keys) if (!names.has(k)) gone.push(`${label} → ${k}`);
    }
    expect(
      gone,
      "the admin runbook tells an operator these jobs exist and the registry " +
        "does not have them. Either the job was deleted (fix the runbook prose " +
        "and this map) or it was renamed.",
    ).toEqual([]);
  });

  it("every schedule the runbook states matches the registry", () => {
    const bySchedule = new Map(registry().map((e) => [e.name, e.schedule]));
    const wrong: string[] = [];
    for (const { label, schedule } of runbookClaims()) {
      const keys = CLAIMS[label];
      if (!keys) continue; // covered by the next case
      for (const k of keys) {
        const actual = bySchedule.get(k);
        if (actual && actual !== schedule) {
          wrong.push(`${label} (${k}): runbook says ${schedule}, registry says ${actual}`);
        }
      }
    }
    expect(wrong, "an operator reading a wrong cadence waits for a run that is not due")
      .toEqual([]);
  });

  it("a new scheduled claim in the runbook forces a line in the map", () => {
    // Without this the guard covers only what it already knew about, and the
    // next hand-written bullet is invisible to it — the same way this runbook
    // was invisible to the drift guard that covers the generated tables.
    const unmapped = runbookClaims()
      .map((c) => c.label)
      .filter((l) => !(l in CLAIMS));
    expect(
      unmapped,
      "these are stated with a schedule in the runbook and are not mapped to a " +
        "registry name. Add them to CLAIMS so they are checked.",
    ).toEqual([]);
  });
});
