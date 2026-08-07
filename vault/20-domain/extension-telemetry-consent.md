---
title: Browser-extension telemetry consent
type: contract
status: current
source_of_truth: vault
code_refs:
  - extension-unified/usage-telemetry.js
  - extension-unified/popup.html
  - services/edge-functions/src/routes/public-grading.ts
  - src/pages/legal/privacy.tsx
reviewed: 2026-08-07
tags: [extension, privacy, consent, telemetry, contract]
summary: The extension ships two independent opt-in telemetry toggles; a consent may never be widened in place, and the server — not the client — enforces what a ping may contain.
---

# Browser-extension telemetry consent

The extension sends the user's own data to us in exactly three ways. Two of them
are **telemetry**, both **off by default**, both **revocable**, and — the part
that is a rule rather than a description — **separate from each other**.

| Toggle (popup) | storage key | What it sends | Endpoint | Table |
|---|---|---|---|---|
| Report when a site's layout breaks the read | `selectorTelemetry` | marketplace name, which selector list came up empty, config + extension version | `POST /api/grading/public/selector-health` | `selector_health_pings` (00475) |
| Share anonymous usage counts | `usageTelemetry` | totals only: reads, click-throughs by surface, extension version | `POST /api/grading/public/usage` | `extension_usage_pings` (00531) |

(The third way is the condition read itself, which is not telemetry: it is the
feature the user clicked, and it is disclosed as "website content on user
action".)

## Rule 1 — never widen a consent in place

A new kind of data gets a **new toggle**, not a new meaning for an existing one.

This is not fastidiousness. Each toggle's copy states what it sends, in words:
the selector-health one promises "only the marketplace name and which part
failed". Sending usage counts under that switch would make a sentence someone
read before agreeing become false, retroactively, with nothing in the UI to
signal it. The person would have consented to something they were never shown.

US-1757's notes proposed reusing the existing toggle, and that is exactly the
shape this rule refuses. The cost of the rule is one more checkbox. The cost of
breaking it is a consent record that cannot be defended.

Corollary: **revoking deletes the pending batch too.** Usage counts accumulate on
the device between sends, so an off switch that leaves the half-finished tally on
disk lets a later opt-in ship activity from the very period the user said no to.
Both the popup (`storage.local.remove([CONSENT_KEY, BATCH_KEY])`) and the worker
(`recordUsage` clears the batch when consent reads false) implement this half.

## Rule 2 — the server enforces the promise, not the client

The extension is client code. A user, or anyone who has modified the build, fully
controls what it POSTs. So every claim of the form "the ping cannot contain X"
must be enforced by the **endpoint**, not by reviewing the extension:

- **Closed vocabularies.** Both endpoints accept an enumerated set and drop
  everything else — unknown adapters, unknown selector lists, unknown events,
  unknown surfaces. Not sanitized: dropped.
- **No free-text column exists.** There is nowhere to write a URL. The one
  free-ish field is the version string, capped at 32 chars and `[\w.\-]+`.
- **The IP rate-limits and is never persisted.** No owner column, no instance id
  header — the per-install `instanceId` is a grading quota key and deliberately
  stays off both of these requests.
- **A malformed body returns the same flat 204 as a good one**, so an anonymous
  caller cannot probe which values the server knows.

## Rule 3 — usage telemetry is TOTALS, never an event stream

Events are tallied on the device and flushed as a bag of counters after hours
(`FLUSH_AFTER_MS`, or early at `FLUSH_AT_COUNT`). The wire body is
`{ counts, extVersion }` and nothing else — no client timestamp, no window
length, no ordering.

That shape is the whole privacy argument. A timestamped stream of
`read, read, click` from one install is a browsing trail; the same events as
`{ read: 2, "click_through:overlay": 1 }` are not. Counters also saturate at 999,
because an unbounded tally restores the resolution the batching removed.

Adding any field that narrows a ping toward one person, one session or one
listing turns an anonymous counter into tracking — which is the thing the toggle
copy, the privacy policy's extension section, and the store disclosures all
promise it is not.

## Rule 4 — a disclosure change travels with the code

Four artefacts state what these toggles do, and they must agree in the same
commit:

1. the toggle copy in `extension-unified/popup.html`;
2. `src/pages/legal/privacy.tsx` § "The GradeThread browser extension" — this is
   the URL submitted to both stores as the privacy policy, so a policy silent
   about a data flow is a failed review (see [[seo-public-route-registry]] for
   how that page is registered and prerendered);
3. `extension-unified/SUBMISSION.md` — the Chrome data-usage certification and
   the AMO summary text;
4. `scripts/package-extensions.mjs` — the Firefox
   `data_collection_permissions`. Both toggles fall under the same optional
   `technicalAndInteraction` category, so *that* declaration does not change when
   a second one is added; the prose disclosures do.

Guards: `extension-unified/test/usage-telemetry.test.cjs` (vocabulary, payload
shape, separate consent, revoke-deletes-batch),
`src/pages/legal/__tests__/privacy-extension.test.tsx` (the policy states it),
`services/edge-functions/src/tests/extension-usage_test.ts` (hostile bodies, and
the client ⇄ server vocabulary lockstep read out of the shipped module).

## Related

- [[service-role-tables]] — both tables are deny-all operator tables and must be
  registered in `SERVICE_ROLE_ONLY`
- [[ralph-learnings]] — the working log that pointed here
- [[INDEX]]
