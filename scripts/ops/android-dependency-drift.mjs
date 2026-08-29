#!/usr/bin/env node
// US-2906 AC5 — the recurring check that stops the Android dependency set
// drifting for another year.
//
// WHY THIS REPORTS AND DOES NOT FAIL, which is the one design decision here.
// The outdated COUNT changes when Google publishes, not when we change code. A
// gate on it goes red on a Tuesday because androidx shipped, nobody did anything
// wrong, and within a month it is the check everyone force-merges past. This
// repo has the scar: US-2902 found a screenshot step that had been red for four
// days behind `continue-on-error` and a job that had been red for months.
//
// So the output is a labelled GitHub ISSUE instead. An issue is a thing in a
// list a person already looks at; a job summary is a thing nobody opens. It is
// updated in place rather than re-opened monthly, and it CLOSES itself when the
// set is current, so its existence means something.
//
// Reads `android/build/dependencyUpdates/report.json`, which the workflow
// produces by running `./gradlew dependencyUpdates` (the json formatter is set
// in android/build.gradle.kts).
//
// Run locally:  npm run android:updates && node scripts/ops/android-dependency-drift.mjs
// (without GITHUB_TOKEN it just prints, like scripts/ops/uptime-check.mjs)

import { readFileSync, existsSync } from "node:fs";

const REPORT = "android/build/dependencyUpdates/report.json";
const ISSUE_LABEL = "android-deps";
const GH_TOKEN = process.env.GITHUB_TOKEN?.trim() || "";
const GH_REPO = process.env.GITHUB_REPOSITORY?.trim() || "";

/** The leading integer of a version string, or null when it has none. */
function major(version) {
  const m = /^(\d+)/.exec(String(version ?? ""));
  return m ? Number(m[1]) : null;
}

/** The version the plugin would move us to, preferring the stablest channel. */
function target(dep) {
  const a = dep.available ?? {};
  return a.release ?? a.milestone ?? a.integration ?? null;
}

function classify(report) {
  const outdated = report.outdated?.dependencies ?? [];
  const rows = outdated.map((d) => {
    const to = target(d);
    const from = d.version;
    const fromMajor = major(from);
    const toMajor = major(to);
    const majorsBehind =
      fromMajor !== null && toMajor !== null ? Math.max(0, toMajor - fromMajor) : null;
    return { id: `${d.group}:${d.name}`, from, to, majorsBehind, reason: d.userReason };
  });
  // A major jump is the one that carries breaking changes and the one Play's
  // SDK Index tends to care about, so it leads. Ties sorted by name so the
  // issue body is stable between runs and its diff means something.
  rows.sort(
    (a, b) => (b.majorsBehind ?? 0) - (a.majorsBehind ?? 0) || a.id.localeCompare(b.id),
  );
  return {
    total: report.count ?? 0,
    current: report.current?.count ?? 0,
    outdated: rows.length,
    majorBehind: rows.filter((r) => (r.majorsBehind ?? 0) > 0),
    rows,
    gradle: report.gradle ?? null,
  };
}

function body(summary) {
  const lines = [];
  lines.push(
    `**${summary.outdated} of ${summary.total}** Android dependencies are behind ` +
      `(${summary.current} current), and **${summary.majorBehind.length}** are at least a ` +
      "major version behind.",
    "",
  );

  const g = summary.gradle;
  if (g?.current?.isUpdateAvailable) {
    lines.push(
      `Gradle: **${g.running?.version} → ${g.current?.version}**. US-2906 records that the ` +
        "toolchain jump and the dependency jump are the same piece of work, not two.",
      "",
    );
  }

  if (summary.majorBehind.length > 0) {
    lines.push("### At least one major behind", "");
    lines.push("| dependency | from | to | majors |", "|---|---|---|---|");
    for (const r of summary.majorBehind) {
      lines.push(`| \`${r.id}\` | ${r.from} | ${r.to} | ${r.majorsBehind} |`);
    }
    lines.push("");
  }

  const minor = summary.rows.filter((r) => (r.majorsBehind ?? 0) === 0);
  if (minor.length > 0) {
    lines.push(
      `<details><summary>${minor.length} minor/patch behind</summary>`,
      "",
      "| dependency | from | to |",
      "|---|---|---|",
      ...minor.map((r) => `| \`${r.id}\` | ${r.from} | ${r.to} |`),
      "",
      "</details>",
      "",
    );
  }

  lines.push(
    "---",
    "",
    "This issue is updated in place each month and CLOSES ITSELF when nothing is " +
      "behind, so its presence is the signal. It does not fail a build on purpose: " +
      "the count moves when upstream publishes rather than when we change code, and " +
      "a gate that goes red for reasons nobody controls is one people learn to " +
      "force-merge past.",
    "",
    "Owned by **US-2906**. AC2 wants each of these upgraded or given a written " +
      "reason next to its pin in `libs.versions.toml`; AC4 wants the full suite, the " +
      "screenshot lane and a real-device smoke pass before committing.",
  );
  return lines.join("\n");
}

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${GH_TOKEN}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path} → ${res.status}`);
  return res.status === 204 ? null : await res.json();
}

async function main() {
  if (!existsSync(REPORT)) {
    console.error(
      `android-dependency-drift: no ${REPORT}. Run \`npm run android:updates\` first ` +
        "(the workflow does this in the step before).",
    );
    return 1;
  }

  const summary = classify(JSON.parse(readFileSync(REPORT, "utf8")));
  console.log(
    `android-dependency-drift: ${summary.outdated}/${summary.total} behind, ` +
      `${summary.majorBehind.length} by a major`,
  );

  if (!GH_TOKEN || !GH_REPO) {
    console.log("No GITHUB_TOKEN/GITHUB_REPOSITORY — printing instead of filing.\n");
    console.log(body(summary));
    return 0;
  }

  const open = await gh(
    `/repos/${GH_REPO}/issues?labels=${ISSUE_LABEL}&state=open&per_page=1`,
  );
  const existing = open[0] ?? null;

  if (summary.outdated === 0) {
    if (existing) {
      await gh(`/repos/${GH_REPO}/issues/${existing.number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "Every Android dependency is current. Closing." }),
      });
      await gh(`/repos/${GH_REPO}/issues/${existing.number}`, {
        method: "PATCH",
        body: JSON.stringify({ state: "closed" }),
      });
      console.log(`Closed #${existing.number} — nothing behind.`);
    }
    return 0;
  }

  const title = `Android dependencies: ${summary.outdated} behind, ${summary.majorBehind.length} by a major`;
  if (existing) {
    // Rewrite the body rather than commenting: a monthly comment thread buries
    // the current state under its own history.
    await gh(`/repos/${GH_REPO}/issues/${existing.number}`, {
      method: "PATCH",
      body: JSON.stringify({ title, body: body(summary) }),
    });
    console.log(`Updated #${existing.number}.`);
  } else {
    const issue = await gh(`/repos/${GH_REPO}/issues`, {
      method: "POST",
      body: JSON.stringify({ title, body: body(summary), labels: [ISSUE_LABEL] }),
    });
    console.log(`Opened #${issue.number}.`);
  }
  return 0;
}

process.exit(await main());
