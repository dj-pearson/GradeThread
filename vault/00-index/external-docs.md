---
title: External docs register
type: reference
status: current
source_of_truth: vault
code_refs:
  - services/edge-functions/COOLIFY.md
  - services/edge-functions/CRON_SETUP.md
  - services/edge-functions/EBAY_SETUP.md
  - services/edge-functions/GOOGLE_SETUP.md
  - services/edge-functions/OBSERVABILITY.md
  - services/edge-functions/NEWSLETTER_KICKOFF.md
  - services/edge-functions/BRAND_KB.md
  - ios/RELEASE.md
  - ios/APP_STORE_SUBMISSION.md
  - ios/CERT_PINNING_DECISION.md
  - ios/README.md
  - extension-unified/README.md
  - extension-unified/SUBMISSION.md
  - extension-unified/TESTING.md
reviewed: 2026-07-19
tags: [meta, index, external]
summary: Documentation that deliberately stays next to the code it configures, registered here so it is findable from the index.
---

# External docs register

Not every document belongs in the vault. **Deploy and setup docs belong next to
the service they configure** — someone editing `docker-compose.coolify.yml`
should find `COOLIFY.md` in the same directory, not two folders away in a
knowledge base.

But a document the index cannot see is a document an agent will not find, and
that gap is invisible: nothing distinguishes "deliberately colocated" from
"forgotten". So colocated docs are **registered here without being moved**.

## How the registration is checked

Each registered path is a `code_refs` entry in this note's frontmatter, so
`vault-lint` fails if any of them is deleted or renamed. That reuses the existing
existence check rather than inventing a new note type.

`source_of_truth` is `vault`, not `code`, deliberately: these paths are pointers,
not descriptions of the files' contents. Marking them `code` would make the drift
guard fire every time any registered doc was edited — a warning nobody could act
on, because this note makes no claim about what those files say.

## Edge service — `services/edge-functions/`

| Doc | Covers |
|---|---|
| `COOLIFY.md` | Deploying the Deno/Hono container on Coolify; hosts the generated cron table |
| `CRON_SETUP.md` | Scheduled-task setup, generated from `cron-runs.ts` |
| `EBAY_SETUP.md` | eBay app registration, OAuth keyset and policy configuration |
| `GOOGLE_SETUP.md` | Google OAuth, Photos, Sheets and Ads credential setup |
| `OBSERVABILITY.md` | Logs, metrics and the health endpoints |
| `NEWSLETTER_KICKOFF.md` | Newsletter launch procedure |
| `BRAND_KB.md` | Brand knowledge-base operational notes |

Two of these — `COOLIFY.md` and the launch checklist — embed a **generated**
cron table between `cron-registry` markers, drift-guarded by
`cron-registry-drift_test.ts`. Do not hand-edit between those markers.

## iOS — `ios/`

| Doc | Covers |
|---|---|
| `RELEASE.md` | Release and TestFlight process |
| `APP_STORE_SUBMISSION.md` | Submission requirements and review responses |
| `CERT_PINNING_DECISION.md` | Why certificate pinning was or was not adopted |
| `README.md` | iOS project orientation |

## Browser extension — `extension-unified/`

| Doc | Covers |
|---|---|
| `README.md` | Extension architecture and the bundled/hosted config split |
| `SUBMISSION.md` | Store submission process |
| `TESTING.md` | Manual and automated test procedure |

## Adding to this register

Register a doc here when it must stay colocated. Move it into the vault instead
when it is durable knowledge rather than setup instructions for a specific
directory. The test: **would someone look for this while editing files in that
folder?** If yes, colocate and register. If they would look for it while
answering a question, it belongs in the vault.

## Related

- [[INDEX]]
- [[CONTRACT]] — why `source_of_truth` is `vault` here
- [[moc-ops]] — the runbooks that DID move
