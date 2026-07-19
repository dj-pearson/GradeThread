---
title: Retrieval benchmark — 2026-07-19
type: reference
status: current
source_of_truth: vault
code_refs:
  - scripts/vault-benchmark.mjs
reviewed: 2026-07-19
tags: [meta, benchmark, evidence]
summary: Navigating the vault costs 89% less than the pre-vault corpus; grepping it blindly costs 16% MORE. The protocol is the product.
---

# Retrieval benchmark — 2026-07-19

The epic was sold on "fewer tokens, better answers". That is an empirical claim,
so US-2064 measured it, and the story's criteria explicitly permitted a negative
result. Re-run with `node scripts/vault-benchmark.mjs`.

## Headline

| Workflow | KB opened across 12 tasks | vs pre-vault |
|---|--:|--:|
| **pre-vault**, blind grep | 1,995.5 | — |
| **post-vault**, blind grep | 2,307.7 | **+16%** |
| **post-vault**, navigated (index → note) | **216.7** | **−89%** |

Both numbers are real and both matter.

> **The vault is ~9× cheaper if you navigate it and 16% *worse* if you grep it.**

That second number is not a footnote. The vault **added** 86 files to a corpus
that already had 200, and every note cross-links to others, so a blind keyword
search now hits *more* documents than before. An agent that ignores the index and
greps gets a worse outcome than it would have had pre-vault.

This is the strongest argument for the `vault` skill existing at all. The
structure is not self-enforcing; the protocol is the product.

## Method, and what it does not measure

We cannot replay an agent session, so the proxy is **bytes of documentation a
reader must open to answer with confidence**:

- **pre / post grep** — every `.md` matching the question's search terms.
  *All* matches count, because when two files match you must read enough of both
  to learn which is current. That disambiguation is the duplicate tax.
- **navigated** — `INDEX.md` (the entry cost, paid once per question) plus the
  note the index points at.

Identical search terms on both sides. The proxy overstates both — a real agent
greps and reads excerpts — but it overstates them the same way, so the ratio
holds even though the absolute numbers do not.

**It does not measure correctness.** See below; that is where the real value sat.

## Where the vault LOSES

Two of twelve tasks got *more* expensive even when navigated:

| Task | pre | navigated | |
|---|--:|--:|---|
| `ebay-aspect-limit` | 5.5 KB | 11.9 KB | **+117%** |
| `incident-first-60` | 11.0 KB | 24.4 KB | **+121%** |

The cause is the same in both: **`INDEX.md` is an 8.8 KB fixed tax**, and these
questions were already cheap pre-vault (2 matching files each). Paying 8.8 KB of
navigation to find a 3 KB answer is a loss.

So the honest shape of the result is:

> The vault wins big on questions that were **expensive** — many candidate files,
> duplicates to disambiguate — and loses on questions that were **already cheap**.

The four biggest wins were all questions with 8–22 pre-vault candidate files
(`flipdesk-pro-price` −96%, `poshmark-why-extension` −96%, `operator-table-rls`
−96%, `deploy-order` −95%). The two losses had two candidates each.

That suggests the index cap (400 lines, currently at 123) matters more than it
looked: every line added to `INDEX.md` is charged to *every* question, including
the ones that did not need it.

## The part the numbers miss

No task **failed** — the answer was findable in both trees. But the byte count
cannot see that several pre-vault answers would have been **confidently wrong**:

- **`rotate-encryption-key`** — the pre-vault tree held two contradictory
  procedures, *both wrong*. One demanded an unnecessary maintenance window; the
  other named `EDGE_ENCRYPTION_KEY_OLD`, which does not exist, and following it
  would have **broken every marketplace connection** mid-rotation. Cost: 84 KB to
  reach a wrong answer.
- **`email-provider`** — the pre-vault docs described a Resend integration. There
  is no Resend code in the repo; mail is SMTP/SES. A reader would have
  provisioned an unused vendor and configured no working mail path.
- **`rounding-lockstep`** — the pre-vault map listed four rounding sites and
  described a world that US-2034 had already consolidated. A reader would have
  hunted for copies that no longer exist and missed the shared helper.

A cheaper wrong answer is not an improvement. **The correctness findings, not the
token ratio, are what this epic actually bought** — and they are the part a
benchmark of this shape structurally cannot score.

## Related

- [[adr-0001-knowledge-vault]] — the premise this tested
- [[key-rotation]] · [[env-reference]] · [[weighted-overall-lockstep]] — the three corrected answers
- [[INDEX]]
