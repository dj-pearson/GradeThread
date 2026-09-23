---
title: Publishing the SDK
aliases: [npm publish, "@gradethread/sdk", NPM_ACCESS_TOKEN, SDK_PUBLISHED, sdk-publish]
type: runbook
status: current
source_of_truth: code
code_refs:
  - .github/workflows/sdk-publish.yml
  - sdk/gradethread-js/package.json
  - src/lib/sdk-release.ts
  - scripts/sync-sdk-readme.mjs
reviewed: 2026-09-23
tags: [ops, sdk, npm, release, runbook]
summary: How @gradethread/sdk gets onto npm (org, token, secret, tag) and the one flag that switches /developers and the SDK README from "not published yet" to npm install.
---

# Publishing the SDK

`sdk/gradethread-js` is published to npm as `@gradethread/sdk` by
`.github/workflows/sdk-publish.yml`. Nothing publishes from a laptop or a cloud
session; the workflow is the only path, so every release is built and tested
from a tagged commit.

Until the first release, `registry.npmjs.org/@gradethread%2fsdk` answers 404,
and `/developers` plus the SDK README say the SDK is not published yet. Both
read that from `SDK_PUBLISHED` in `src/lib/sdk-release.ts`.

## One-time setup (owner)

1. **Create the npm org `gradethread`** at npmjs.com (free plan is fine for
   public packages). The scope in the package name must match an org or user you
   own. If `gradethread` is taken, use your personal scope and rename the
   package in three places in the same commit: `name` in
   `sdk/gradethread-js/package.json`, `SDK_PACKAGE_NAME` in
   `src/lib/sdk-release.ts`, and the `import ... from "@gradethread/sdk"` lines
   in the README and on `/developers`. `src/test/developers-sdk-install.test.tsx`
   fails if the first two disagree.
2. **Create a granular access token** (npm > Access Tokens > Generate New Token
   > Granular). Permissions: Read and write, packages and scopes limited to
   `@gradethread/sdk` (before the first publish, scope it to the `gradethread`
   org instead, then narrow it once the package exists). Set an expiry and record
   it with the other secrets in [[key-rotation]].
3. **Store it in Infisical** as `NPM_ACCESS_TOKEN` (project `grade-thread`, env
   `prod`, path `/`), the same place the iOS and Android release secrets live.
   The workflow imports it with the three `INFISICAL_*` GitHub secrets, and only
   on a real publish, after install, build and test: the import loads every
   secret at that path into the job, so it waits until no dependency script is
   left to run. A dry run never asks for it. Without it, a tag push still
   runs and ends with the notice "SDK publish skipped: NPM_ACCESS_TOKEN is not
   in Infisical" rather than a red run. There is no package to create on npm
   first: the first publish creates `@gradethread/sdk` inside the org.
4. **License: MIT** (owner, 2026-09-23). `sdk/gradethread-js/LICENSE` holds
   the text and npm packs it automatically.

## Every release

1. Rehearse: Actions > SDK publish > Run workflow, leave `dry_run` ticked. It
   builds, runs the dist smoke test and prints the exact tarball contents
   (LICENSE, README, `dist/index.js`, `dist/index.d.ts`, `package.json`).
2. Bump `version` in `sdk/gradethread-js/package.json` and commit.
3. Tag and push: `git tag sdk-v0.1.0 && git push origin sdk-v0.1.0`. The
   workflow refuses a tag whose version differs from `package.json`, and a
   version already on npm.
4. Check: `npm view @gradethread/sdk version` prints the new version.

## First release: flip the copy in the release commit

npm shows the README from the published tarball, so if the flag flips after the
first release, the npm page says "not published yet" until the second one. Flip
it in the commit you tag instead:

1. Set `SDK_PUBLISHED = true` in `src/lib/sdk-release.ts`.
2. Run `node scripts/sync-sdk-readme.mjs` (Node 22.18+). It rewrites the block
   between the `sdk-install` markers in the SDK README to `npm install
   @gradethread/sdk`. The web test suite fails if you skip this step.
3. Commit both with the version bump, then push **the tag only**
   (`git push origin sdk-v0.1.0`). That uploads the commit without moving
   `main`, so `/developers` keeps its "not published yet" copy until the package
   exists.
4. When `npm view @gradethread/sdk version` answers, push `main`. The frontend
   deploy switches `/developers` to `npm install`.

If the publish fails, fix it and re-tag; `main` never advertised a package that
was not there.

## Provenance and the private repository

`publishConfig.provenance` is `true`, and on a **public** repository the
workflow publishes with `--provenance`, which links the npm page to the exact
commit and workflow run. npm refuses provenance from a **private** repository,
and this one is private, so the workflow detects that, switches provenance off
for that run and prints a warning. The package still publishes. Making the
repository public, or moving the SDK to its own public repository, is what turns
provenance on; no workflow change is needed.

## What is and is not tested before publish

The workflow runs `npm ci`, `npm run build`, then `npm test`, which is
`sdk/gradethread-js/test/dist.test.mjs` against the built `dist/`. The same file
also runs on every PR, from `src/test/sdk-build.test.ts`. The full SDK behaviour
suite (`src/test/sdk-*.test.ts`: retries, Idempotency-Key, webhook vectors,
route parity with the edge) runs in the main CI on every push, not in this
workflow, so tag a commit that main CI has already passed.

It runs on Node 22, because `react-router-8-contract.test.ts` holds every
workflow here at 22 or later. The SDK's `engines` says Node 20+, and nothing
runs it on 20. It uses no Node API newer than `fetch`, `Headers` and Web
Crypto, all present in 20, but that is a reading of the code, not a test.
