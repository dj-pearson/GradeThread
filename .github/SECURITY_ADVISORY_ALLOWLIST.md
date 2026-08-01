# Security advisory allowlist

Tracks dependency advisories that the `npm audit` CI gate
(`.github/workflows/security.yml`) reports but that we have **consciously
accepted** for now, with the reasoning.

`npm audit` has no native ignore file. The accepted-advisories table below is
therefore also the **machine-readable** allowlist: `scripts/audit-gate.mjs`
parses it and blocks on every high/critical production advisory whose id is not
a row here — and on any row whose **Re-check by** date has passed. An acceptance
that nobody renews expires into a failing build, which is the property that
stops "accepted" drifting into "forgotten".

The judgement is still human:

1. Prefer to **fix** — upgrade the dependency or its parent. That's almost
   always the right answer.
2. If a fix isn't yet available and the advisory is **not exploitable in our
   usage** (e.g. a dev-only tool, or a code path we don't hit), record it below
   so reviewers know the red `npm audit` was triaged, not ignored.
3. Re-review every accepted entry at the quarterly security review
   (`vault/10-ops/incident-response.md`).

Do **not** lower `--audit-level` to make the build pass.

## How the gate enforces this

`security.yml` runs **two** audit steps:

1. **Blocking** — `node scripts/audit-gate.mjs`, which wraps
   `npm audit --omit=dev --audit-level=high` — production (shipped)
   dependencies. A high/critical here fails CI **unless** it is an unexpired row
   in the table below. This is the real security surface for a deployed app and
   must stay green. The threshold is NOT lowered; acceptances are per-advisory
   and dated, so one accepted finding never blinds the gate to the next one.
2. **Informational** — `npm audit --audit-level=high || true` — full tree incl.
   devDependencies. Never blocks; it exists so build-tool advisories stay visible
   for triage. Anything it reports that is NOT a shipped-runtime dep belongs in
   the table below with a rationale.

The `--audit-level` is **not** lowered (still `high`). Scoping the blocking gate
to runtime deps is the accepted way to avoid being held hostage by a dev-only
CVE whose only fix is a breaking build-tooling major.

## Accepted advisories

| Advisory (GHSA / CVE) | Package | Severity | Why accepted | Re-check by |
|---|---|---|---|---|
| GHSA-gv7w-rqvm-qjhr | esbuild (via vite/@vitejs/plugin-react/@tailwindcss/vite) | high | **Dev/build tooling only — not shipped to users.** Binary-integrity gap exploitable only at install time against a malicious `NPM_CONFIG_REGISTRY`; our installs use the public registry + committed lockfile. Only fix is `vite@8` (breaking major). Runtime audit (`--omit=dev`) is clean. | 2026-09-01 |
| GHSA-g7r4-m6w7-qqqr | esbuild (via vite/@vitejs/plugin-react/@tailwindcss/vite) | high | **Dev/build tooling only — not shipped to users.** Arbitrary file read via the esbuild **dev server** on Windows; we never expose `vite dev` to an untrusted network, and CI builds are first-party. Only fix is `vite@8` (breaking major). Revisit when plugins ship a vite-8-compatible line. | 2026-09-01 |
| GHSA-qwww-vcr4-c8h2 | react-router / react-router-dom (7.12.0 – 8.2.0) | high | **The vulnerable code path does not exist in this app.** The bypass is in React Router's **RSC mode** — server actions executed before a 400 response. GradeThread is a client-only SPA: `createBrowserRouter` + `RouterProvider`, no React Router server, no RSC, no server actions (`src/routes/index.tsx`). There is no fix inside 7.x — the advisory range ends at 8.2.0, so the only upgrade is `react-router@8`, which **deletes the `react-router-dom` package** (221 import sites), is ESM-only and requires Node 22 while CI runs Node 20. That migration is tracked as its own story rather than smuggled into a security patch. | 2026-11-01 |
