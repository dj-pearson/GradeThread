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
