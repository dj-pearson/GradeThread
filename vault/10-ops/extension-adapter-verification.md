---
title: Verifying a marketplace adapter against the live site
type: runbook
status: current
source_of_truth: vault
code_refs:
  - scripts/adapter-verify.mjs
  - scripts/lib/adapter-verification.mjs
  - extension-unified/research/selectors.js
  - public/extension/marketplace-selectors.json
reviewed: 2026-08-07
tags: [extension, marketplace, adapters, qa]
summary: How to prove a research adapter reads a real listing correctly, and how to record the result in both config files without drifting them.
---

# Verifying a marketplace adapter against the live site

The research extension reads listings through per-marketplace **adapters** — pure
config (host list, gallery/title/brand selectors, an image-URL upgrade rule) in
`extension-unified/research/selectors.js`, mirrored to the hosted copy at
`public/extension/marketplace-selectors.json`. Each carries a `verified` flag.

`verified: true` means one thing and only one thing: **a human opened a real
listing on that marketplace and watched the shipped selectors produce full-size
photos, a title and a brand.** It is not a code review, and no test can grant it.
An adapter is written by reading the marketplace's HTML, and reading is exactly
where selectors go wrong.

Only eBay was ever verified this way. The other five are best-effort starting
points — which is why the extension degrades to an honest "couldn't read the
photos" state rather than guessing.

## Why the flag has to be earned, not asserted

The failure this procedure exists to catch is silent. Poshmark's URL-upgrade rule
shipped as `/s_[a-z0-9]+/` — a path-segment form real CloudFront URLs never use.
It matched nothing, so every image handed to the grader was a **thumbnail**, and
nothing anywhere went red: the selectors resolved, images were found, a grade came
back. The read was simply worse than it looked, for months.

A config cannot be checked by reading it. Only pixels off the live site say
whether it works.

## The procedure

Budget about ten minutes per marketplace.

**1. Generate the check for one adapter.**

```bash
node scripts/adapter-verify.mjs status              # who still needs doing
node scripts/adapter-verify.mjs snippet poshmark    # prints the script
```

The snippet inlines `extension-unified/research/image-utils.js` verbatim, so what
it measures is what the extension does — the same `applyUrlUpgrade`,
`pickImageUrl`, `srcsetLargest` and `dedupeUrls`. It is generated, never checked
in: a stored copy would describe a config it no longer matches.

**2. Open a real listing** on that marketplace — an ordinary garment listing with
several photos, not a promoted or edge-case page. Open DevTools, paste the whole
snippet into the Console, press Enter.

**3. Read the table.** It reports host match, listing-page detection, which
gallery selector matched, how many URLs survived dedupe, whether the URL-upgrade
rule actually rewrote anything, the **measured pixel size** of every image before
and after the upgrade, and each text field with the selector that found it.

The two rows that matter most:

- *urlUpgrade rewrote URLs* — a rule that is configured but rewrote **nothing** is
  the Poshmark bug. FAIL.
- *images are full-res* — the upgraded URLs must actually deliver ≥ 800px.
  This is the only check that cannot be satisfied by editing the config.

A missing `title` fails. A missing brand, seller, condition or price warns: those
degrade to empty by design.

**4. If it fails,** fix the adapter in BOTH config files, reload, re-run. Do not
record a partial pass.

**5. Record the pass.**

```bash
node scripts/adapter-verify.mjs mark poshmark --dry   # preview
node scripts/adapter-verify.mjs mark poshmark
node scripts/test-extensions.mjs                      # config-sync guard
```

Then commit both files together.

## Why `mark` is a command and not a hand edit

One verification is three edits (`verified`, `lastVerified`, `version`) applied to
two files that hold the same data in different formats. Doing that by hand drifts
them, and the config-sync guard exists because it already has.

The version bump also has an ordering rule that is easy to get wrong and
impossible to notice: the extension **ignores** a hosted config whose version
sorts below the bundled one, so that a stale or rolled-back hosted file can never
downgrade the shipped adapters (`chooseConfig` in
`extension-unified/research/image-utils.js`). A bump that goes backwards — a stale clock, a month typo — publishes a file every install silently
refuses, and the fix you just verified never reaches anyone. `mark` guarantees the
new version sorts strictly above the current one, and refuses to write anything if
the two files come out disagreeing.

## What this does not cover

The snippet checks one listing at one moment. A marketplace can serve a different
DOM to logged-in users, to another country, or to an A/B cohort. Verification is a
snapshot with a date on it, not a warranty — which is what the opt-in
selector-failure ping is for: it reports *which selector list came up empty*, with
no listing URL and no user data, so a break that happens after verification is
discovered rather than waited for. See [[extension-telemetry-consent]].

Re-verify when a marketplace visibly redesigns, or when the ping starts reporting
misses for an adapter that was passing.

## Related

- [[extension-telemetry-consent]] — the opt-in rules for the selector-failure ping
- [[moc-ops]]
