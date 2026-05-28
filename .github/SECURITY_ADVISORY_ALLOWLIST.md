# Security advisory allowlist

Tracks dependency advisories that the `npm audit` CI gate
(`.github/workflows/security.yml`) reports but that we have **consciously
accepted** for now, with the reasoning.

`npm audit` has no native ignore file, so this list is a **human process**, not
an automated suppression:

1. Prefer to **fix** — upgrade the dependency or its parent. That's almost
   always the right answer.
2. If a fix isn't yet available and the advisory is **not exploitable in our
   usage** (e.g. a dev-only tool, or a code path we don't hit), record it below
   so reviewers know the red `npm audit` was triaged, not ignored.
3. Re-review every accepted entry at the quarterly security review
   (`docs/INCIDENT_RESPONSE.md`).

Do **not** lower `--audit-level` to make the build pass.

## Accepted advisories

_None currently._

| Advisory (GHSA / CVE) | Package | Severity | Why accepted | Re-check by |
|---|---|---|---|---|
| – | – | – | – | – |
