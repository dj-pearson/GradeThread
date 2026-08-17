// The edge compose files must declare `environment:` as a MAP, not a list.
//
// THE OUTAGE THIS EXISTS FOR (US-2496). Coolify deploys the edge service by
// reading services/edge-functions/docker-compose.yml, merging its own managed
// env vars into the `environment` block, and re-serialising the file. A YAML
// SEQUENCE does not survive that round-trip: a parse-merge-dump pipeline hands
// the list back as an array with INTEGER keys, so the file Coolify then feeds
// to `docker compose build` reads
//
//     environment:
//       0: PORT=8787
//       1: SOURCE_COMMIT
//
// and compose rejects it outright:
//
//     Error: non-string key in services.edge-functions.environment: 0
//
// The deploy dies at the build step with an error that names nothing anyone
// wrote, so it reads as a Coolify or Docker bug rather than a compose-file one.
// Every edge deploy stayed broken until the block was rewritten as a mapping.
//
// A MAPPING round-trips as a mapping, which is the whole fix.
//
// WHY ONLY `environment`. Coolify only rewrites the block it merges into.
// `expose:` and `healthcheck.test:` are sequence-ONLY in the compose spec and
// could not be converted even if we wanted to — and the fact that they have
// never failed is the evidence that Coolify leaves them alone. So this guard is
// deliberately narrow: it pins the one block that is both round-tripped and
// legally expressible as a map.
//
// NOTE ON NULL VALUES. `SOURCE_COMMIT:` with no value is not an oversight — it
// is the map-form spelling of a bare `- SOURCE_COMMIT` list entry, and means
// "pass through from the host, but only if the host actually has it". That
// distinction matters: writing `SOURCE_COMMIT: ${SOURCE_COMMIT:-}` would set an
// EMPTY STRING when unset and clobber the release SHA baked in at build time
// (US-2001). The null form is asserted below so a well-meaning cleanup cannot
// "fix" it into a default.
//
// ⚠ WHICH FILE COOLIFY READS IS NOT SETTLED (US-2665), and this test does not
// establish it. The outage above proves Coolify parsed and re-serialised A
// compose file with an `edge-functions` service — that much is real, it is why
// every deploy died — but the fix touched all three files at once, so it never
// discriminated between them. What IS measured, from the public
// /health/metrics on 2026-08-17: EDGE_MEMORY_LIMIT_MB is unset in production
// while docker-compose.coolify.yml declares 2048, so that file at least is not
// the deployed one. This guard's value is unchanged either way — it keeps every
// candidate file in a shape that survives the round-trip — but do not read a
// green run as a statement about the running container.

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const COMPOSE_FILES = [
  "services/edge-functions/docker-compose.yml",
  "services/edge-functions/docker-compose.coolify.yml",
  "services/edge-functions/docker-compose.staging.yml",
];

/**
 * The raw lines of a service's `environment:` block.
 *
 * Deliberately a line scan rather than a YAML parse: a parser would normalise
 * both shapes into the same object and lose the very distinction under test.
 * What matters here is what the FILE says, because that is what Coolify reads.
 */
function environmentBlockLines(source) {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => /^\s{4}environment:\s*$/.test(l));
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    // Any key at the same indent as `environment:` ends the block.
    if (/^\s{4}\S/.test(line)) break;
    if (/^\s*#/.test(line.trim())) continue; // comment
    body.push(line);
  }
  return body;
}

describe("edge compose environment blocks (US-2496)", () => {
  for (const rel of COMPOSE_FILES) {
    const path = resolve(process.cwd(), rel);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, "utf8");

    it(`${rel} declares environment as a map, not a list`, () => {
      const body = environmentBlockLines(source);
      expect(body, `${rel} has no environment: block`).not.toBeNull();
      expect(body.length, `${rel} environment block is empty`).toBeGreaterThan(0);

      const listEntries = body.filter((l) => /^\s*-\s/.test(l));
      expect(
        listEntries,
        `${rel} declares environment as a YAML list. Coolify merges its managed ` +
          `env vars into this block and re-serialises the file; a sequence comes ` +
          `back with integer keys and compose dies with "non-string key in ` +
          `services.edge-functions.environment: 0", taking the whole deploy with ` +
          `it. Use map form — "PORT: \\"8787\\"" — and a bare "VAR:" (null) where ` +
          `you want a host pass-through.`,
      ).toEqual([]);
    });

    it(`${rel} keeps the host pass-throughs as nulls, not defaults`, () => {
      const body = environmentBlockLines(source) ?? [];
      for (const key of ["SOURCE_COMMIT", "COMMIT_SHA"]) {
        const entry = body.find((l) => l.trim().startsWith(`${key}:`));
        expect(entry, `${rel} no longer declares ${key}`).toBeTruthy();
        expect(
          entry.trim(),
          `${rel} gives ${key} a value. It must stay a bare "${key}:" (null), ` +
            `which passes the variable through ONLY when the host has it. A ` +
            `default like \${${key}:-} sets an empty string instead, clobbering ` +
            `the release SHA stamped in at build time and putting Sentry back to ` +
            `reporting release "dev" (US-2001).`,
        ).toBe(`${key}:`);
      }
    });
  }

  it("covers every compose file that Coolify might deploy", () => {
    // A new environment-carrying compose file that nobody added here would ship
    // the original bug again, in a file that looks just like the fixed ones.
    for (const rel of COMPOSE_FILES) {
      expect(existsSync(resolve(process.cwd(), rel)), `${rel} is missing`).toBe(true);
    }
  });
});
