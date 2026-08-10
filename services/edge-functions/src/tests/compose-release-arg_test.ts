// US-2001 AC4, the static half: every compose file that BUILDS the image must
// pass GIT_SHA, or the running container cannot say which commit it is.
//
// The runtime guard already exists — /health/ready reports features.release as
// degraded when RELEASE_SHA is a placeholder — and it worked: it announced the
// problem, in plain language, to a caller who did nothing but curl a public
// endpoint. But it only speaks AFTER a bad image is already serving traffic.
//
// The reason that mattered: docker-compose.coolify.yml declared the arg on
// 2026-07-19 and production was STILL measured serving release:"dev" on
// 2026-08-02, because docker-compose.yml (whose own first line calls itself
// "Production compose used by Coolify") never got the same block. A per-file
// declaration that only one file carries is a per-file bug, and nothing was
// looking across the files. This test looks across the files.
//
// Scope note: an override file with no `build:` section (docker-compose.dev.yml)
// is deliberately exempt — it inherits the base file's build, so requiring the
// arg there would demand a duplicate of a value it already has.

import { assert } from "@std/assert";

const COMPOSE_DIR = new URL("../../", import.meta.url);

async function composeFiles(): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(COMPOSE_DIR)) {
    if (entry.isFile && /^docker-compose.*\.ya?ml$/.test(entry.name)) {
      names.push(entry.name);
    }
  }
  return names.sort();
}

Deno.test("every compose file that builds the Dockerfile passes GIT_SHA", async () => {
  const files = await composeFiles();
  // Guard the guard: a glob that silently matches nothing would pass forever.
  assert(
    files.length >= 3,
    `expected to find the compose files, got ${JSON.stringify(files)}`,
  );

  const offenders: string[] = [];
  let builders = 0;

  for (const name of files) {
    const text = await Deno.readTextFile(new URL(name, COMPOSE_DIR));
    // A file that never builds (pure override / image: pull) has nothing to
    // pass the arg to.
    if (!/^\s*build:\s*$/m.test(text)) continue;
    builders++;
    if (!/GIT_SHA:\s*\$\{SOURCE_COMMIT/.test(text)) offenders.push(name);
  }

  assert(
    builders >= 3,
    `expected at least 3 building compose files, found ${builders}`,
  );
  assert(
    offenders.length === 0,
    `these compose files build the image without a GIT_SHA build arg, so the ` +
      `Dockerfile's \`ARG GIT_SHA=dev\` default survives into the image and ` +
      `every error it reports is tagged "dev": ${offenders.join(", ")}. ` +
      `Add \`args: { GIT_SHA: \${SOURCE_COMMIT:-dev} }\` under build. (US-2001)`,
  );
});

Deno.test("every compose file also passes the release vars at RUNTIME", async () => {
  // 2026-08-09: production was measured serving release:"dev" on an image built
  // AFTER all three files carried the build arg. So the build-time half is not
  // sufficient on its own — either the builder still drops the arg, or Coolify
  // does not populate SOURCE_COMMIT at build time. The runtime pass-through is
  // the independent second route, and it is what makes "just set the env var"
  // work without a rebuild.
  //
  // The BARE form (`- SOURCE_COMMIT`, no `=`) is required, not incidental: the
  // `- SOURCE_COMMIT=${SOURCE_COMMIT:-dev}` form would set the variable to "dev"
  // whenever the host lacks it, and a runtime env var OVERRIDES the Dockerfile
  // ENV — so the "safe-looking" default would clobber a correctly stamped image.
  // Same exemption as the build test, for the same reason: docker-compose.dev.yml
  // has an `environment:` block but is an OVERRIDE, merged onto the base file, so
  // it inherits these entries. Requiring them there would demand a duplicate of a
  // value it already has. A file with a `build:` section is the one that stands
  // alone as a deployment definition.
  const files = await composeFiles();
  const offenders: string[] = [];
  let runtimes = 0;

  for (const name of files) {
    const text = await Deno.readTextFile(new URL(name, COMPOSE_DIR));
    if (!/^\s*build:\s*$/m.test(text)) continue;
    if (!/^\s*environment:\s*$/m.test(text)) {
      offenders.push(`${name} (no environment block at all)`);
      continue;
    }
    runtimes++;
    // BOTH YAML shapes, because the files moved to the mapping form on
    // 2026-08-10 and the pass-through semantics are what matters, not the
    // punctuation. Coolify round-trips every compose file through its own YAML
    // parser before deploying, and it rejected the sequence form outright:
    // `Error: non-string key in services.edge-functions.environment: 0`. In the
    // mapping form the pass-through is a key with NO value (`SOURCE_COMMIT:`),
    // which Compose treats identically to the bare `- SOURCE_COMMIT` entry.
    //
    // The rule this guard exists for is unchanged: a VALUE must never be
    // assigned here. `SOURCE_COMMIT=${SOURCE_COMMIT:-dev}` (or its mapping
    // twin) sets the variable to "dev" whenever the host lacks it, and a
    // runtime env var overrides the Dockerfile ENV — so the safe-looking
    // default silently clobbers a correctly stamped image.
    //
    // `[ \t]` rather than `\s`, deliberately: `\s` matches a NEWLINE, so
    // `SOURCE_COMMIT:\s+\S` reads straight past the end of the (correct,
    // valueless) line and matches the first character of the NEXT one. Every
    // file then reports "assigns a value" — a guard that fails on the thing it
    // is supposed to pass.
    const bare = /^[ \t]*-[ \t]*SOURCE_COMMIT[ \t]*$/m.test(text) ||
      /^[ \t]*SOURCE_COMMIT:[ \t]*$/m.test(text);
    const assigned = /^[ \t]*-[ \t]*SOURCE_COMMIT=/m.test(text) ||
      /^[ \t]*SOURCE_COMMIT:[ \t]+\S/m.test(text);
    if (assigned) offenders.push(`${name} (assigns a value — must be bare)`);
    else if (!bare) offenders.push(`${name} (missing)`);
  }

  assert(runtimes >= 3, `expected at least 3 compose files with an environment block, found ${runtimes}`);
  assert(
    offenders.length === 0,
    `these compose files do not pass SOURCE_COMMIT through at runtime as a bare ` +
      `entry: ${offenders.join(", ")}. Add \`- SOURCE_COMMIT\` under environment ` +
      `— with no \`=\`, so an unset host var cannot overwrite the build stamp. (US-2001)`,
  );
});

Deno.test("the Dockerfile still consumes GIT_SHA into RELEASE_SHA", async () => {
  // The build arg is only useful because of this pair. If the Dockerfile ever
  // stops wiring ARG → ENV, the test above would keep passing while every
  // release went back to being unattributable — a green guard over a dead
  // mechanism, which is worse than no guard.
  const dockerfile = await Deno.readTextFile(new URL("Dockerfile", COMPOSE_DIR));
  assert(/^ARG GIT_SHA=/m.test(dockerfile), "Dockerfile must declare ARG GIT_SHA");
  assert(
    /^ENV RELEASE_SHA=\$\{GIT_SHA\}/m.test(dockerfile),
    "Dockerfile must set ENV RELEASE_SHA from GIT_SHA — observability.ts reads RELEASE_SHA",
  );
});
