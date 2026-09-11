import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2665. `services/edge-functions/docker-compose.coolify.yml` looks like a
// deployment and is not one. Coolify does not read it, so a setting added there
// is never shipped - measured three times from public endpoints: /health/metrics
// reports memory.limit_mb null while the file sets EDGE_MEMORY_LIMIT_MB 2048,
// reports buffer_pipeline_cap 10 while the file declares 6, and an OPTIONS
// preflight returns the Hono app's allow-headers list rather than the shorter
// one the file's Traefik edge-cors middleware declares.
//
// Several stories were closed on the strength of a value being present in that
// file. The fix chosen (AC2/AC3) was to keep it as a labelled reference rather
// than delete it - deleting is blocked by
// services/edge-functions/src/tests/compose-release-arg_test.ts, which requires
// at least three building compose files. A label that is only prose decays; this
// test is what stops it decaying.
//
// WHAT THIS TEST IS AND IS NOT. It pins the REPO's honesty about production, not
// production's state. It cannot tell whether Coolify's configuration changed
// this morning. The endpoints that report deployed state are public:
//   GET /health          -> release, env
//   GET /health/ready    -> features, schema
//   GET /health/metrics  -> memory.limit_mb, grading.buffer_pipeline_cap
// and `node scripts/probe-prod-readonly.mjs` runs the last of those on every
// invocation. If you need to know what production has, curl one. If you need to
// know that the repo is not lying about it, this is the right tool.

const COMPOSE = "services/edge-functions/docker-compose.coolify.yml";
const NOTE = "vault/10-ops/edge-container-settings.md";

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("docker-compose.coolify.yml is labelled as not-deployed", () => {
  it("says so in the first ten lines (AC3)", () => {
    // "In the first ten lines" is AC3's wording and it is the point: a warning
    // forty lines down is a warning after the reader has already found the
    // setting they came for.
    const head = read(COMPOSE).split(/\r?\n/).slice(0, 10).join("\n");
    expect(head).toMatch(/NOT WHAT DEPLOYS PRODUCTION/);
    expect(head).toMatch(/NOT SHIPPED/);
    expect(head).toMatch(/edge-container-settings\.md/);
  });

  it("does not print steps for pointing Coolify at it", () => {
    // The old header carried "To make this file the deployed one: New Resource
    // -> Docker Compose -> point at this file". Following it would apply the
    // hand-written traefik.* router and CORS labels below, which have never run,
    // in place of the routing that currently works on the production API.
    const text = read(COMPOSE);
    expect(text).not.toMatch(/To make this file the deployed one/);
    expect(text).toMatch(/DO NOT "make this file the deployed one"/);
  });

  it("annotates every block that only it declares with a LIVE? verdict", () => {
    const text = read(COMPOSE);
    const lines = text.split(/\r?\n/);
    // Each of these is a setting whose ONLY declaration in the repo is this
    // file, so each is a place a reader could believe something is in effect.
    const blocks = [
      /^\s*logging:/,
      /^\s*EDGE_MEMORY_LIMIT_MB:/,
      /^\s*EDGE_TRACE_SAMPLE_RATE:/,
      /^\s*GRADING_MAX_CONCURRENT_PIPELINES:/,
      /^\s*healthcheck:/,
      /^\s*resources:/,
    ];
    const missing: string[] = [];
    for (const re of blocks) {
      const at = lines.findIndex((l) => re.test(l));
      expect(at, `no line matching ${re} in ${COMPOSE}`).toBeGreaterThan(-1);
      // Walk back over the comment block immediately above the declaration.
      let found = false;
      for (let i = at - 1; i >= 0 && /^\s*#/.test(lines[i] ?? ""); i--) {
        if (/LIVE\?/.test(lines[i] ?? "")) {
          found = true;
          break;
        }
      }
      if (!found) missing.push(String(re));
    }
    expect(
      missing,
      `these declarations have no "LIVE?" verdict in the comment directly above ` +
        `them, so a reader cannot tell intent from deployed state: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});

describe("every setting the compose file declares is owned by a vault note", () => {
  it("names each environment variable in vault/10-ops/edge-container-settings.md", () => {
    // The failure this guards against is the original bug recurring in a new
    // variable: somebody adds one here, believes it is live, and nothing in the
    // repo points them at the Coolify field that would make it true.
    const text = read(COMPOSE);
    const note = read(NOTE);
    const env = text
      .split(/\r?\n/)
      .filter((l) => /^ {6}[A-Z][A-Z0-9_]*:/.test(l))
      .map((l) => l.trim().split(":")[0]!);
    expect(env.length).toBeGreaterThanOrEqual(6);
    const missing = env.filter((k) => !note.includes(k));
    expect(
      missing,
      `declared in ${COMPOSE} but not recorded in ${NOTE}, so nobody can find ` +
        `out where to actually set it: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("the note carries the one command that settles the unreadable settings", () => {
    // Log rotation and the container memory limit cannot be answered from this
    // repo or from any public endpoint (AC4/AC6). The note must hand the
    // operator the exact command rather than describing the question.
    const note = read(NOTE);
    expect(note).toMatch(/docker inspect/);
    expect(note).toMatch(/HostConfig\.LogConfig/);
    expect(note).toMatch(/HostConfig\.Memory/);
    expect(note).toMatch(/com\.docker\.compose\.project\.config_files/);
  });
});

describe("the documents that tell an operator where the edge config lives", () => {
  it("CLAUDE.md does not name the compose file as what deploys the edge", () => {
    // CLAUDE.md's deploy line said "Deploy: COOLIFY.md + docker-compose.coolify.yml"
    // for months. Every agent reading it started from a false premise, which is
    // how settings kept being added to a file nothing runs.
    const claude = read("CLAUDE.md");
    const deployLines = claude
      .split(/\r?\n/)
      .filter((l) => /docker-compose\.coolify\.yml/.test(l));
    for (const line of deployLines) {
      expect(
        /not read|NOT read|reference|not deployed/.test(line),
        `CLAUDE.md mentions docker-compose.coolify.yml without saying it is not ` +
          `read: ${line.trim().slice(0, 160)}`,
      ).toBe(true);
    }
  });

  it("the deploy runbook records what configures the edge (AC1)", () => {
    const deploy = read("vault/10-ops/deploy.md");
    expect(deploy).toMatch(/NOT the deployed configuration/);
    expect(deploy).toMatch(/edge-container-settings/);
    // AC1 asks for the resource type to be RECORDED. It is not settled from
    // here, so what is recorded is both candidates plus the command that
    // decides between them - which is a record, and a guess is not.
    expect(deploy).toMatch(/com\.docker\.compose\.project\.config_files/);
  });
});
