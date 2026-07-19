---
title: "ADR-0003: The vault has two consumers, and neither may be optimised away"
aliases: [dual consumer, why keep the generator]
type: decision
status: accepted
source_of_truth: vault
code_refs:
  - scripts/vault-index.mjs
reviewed: 2026-07-19
revisit_by: 2027-07-19
tags: [meta, obsidian, retrieval, decision]
summary: Live Dataview queries serve humans, the generated INDEX serves agents; both are kept because each is inert to the other's reader.
---

# ADR-0003: The vault has two consumers

**Date:** 2026-07-19 · **Status:** accepted · **Story:** US-2091

## Context

The user asked whether the vault used Obsidian's principles or was "just
markdown in a folder Obsidian can open". The audit said the latter: 281
wikilinks and full frontmatter, but zero embeds, zero aliases, zero callouts,
zero Dataview, and one heading link out of 281. Roughly 40% native.

The gap was not accidental — but it **was undocumented**, which is the part that
mattered. A real architectural decision looked like ignorance.

## The two consumers

| | Reads | Gets from a Dataview block | Gets from `![[note#section]]` |
|---|---|---|---|
| **Human in Obsidian** | rendered notes | computed results | the transcluded content |
| **Agent** | raw markdown via `Grep`/`Read` | **the query text** | **the link text** |

An agent cannot execute a query and does not see embedded content. So every
Obsidian-native feature that *computes* is invisible to the primary reader —
and the primary reader is the one this epic was built for.

That is why `INDEX.md` is **materialised by a generator** rather than expressed
as a Dataview query, and why `scripts/vault-index.mjs` and its `--check`
staleness guard exist at all.

## Decision

**Add the native layer. Keep the generated layer. Neither replaces the other.**

- Live Dataview views live in [[live-views]] and serve humans.
- The generated [[INDEX]] serves agents, and `vault-index.mjs --check` keeps it
  honest in CI.
- Both derive from the **same frontmatter**, so they cannot disagree about facts
   — only about presentation.

**Callouts, aliases and heading links are adopted freely.** They render natively
*and* read as plain text, so they cost the agent nothing. That is the test for
any future Obsidian feature: does it degrade gracefully to plain text?

**Transclusion is used sparingly and never for a fact an agent must find.**
`![[pricing#Credit packs]]` means a `Grep` for `$24.99` in the consuming note
finds nothing. Where a number matters, link to the note that owns it and let the
agent take the second hop.

## Consequences

**The generator is not redundant and must not be deleted.** This ADR exists
mainly to say so. Once Bases or Dataview can produce an index, removing
`vault-index.mjs` looks like obvious cleanup — it is not; it would blind every
agent to the corpus.

**We carry two things that must agree.** Mitigated by both reading the same
frontmatter, and by `vault-lint` failing when the generated index goes stale.

**Measured cost of getting this wrong.** The US-2064 benchmark found navigation
89% cheaper than the pre-vault corpus — and blind grep **16% more expensive**,
because the vault added 87 cross-linked notes to a corpus of 200. If the
generated index disappeared, every agent would fall back to exactly that worse
path. See [[benchmark-2026-07-19]].

**Revisit 2027-07-19.** If agent tooling gains the ability to evaluate Dataview
(or an MCP surface serves the vault directly), the generated layer may become
redundant. Until then it is load-bearing.

## Related

- [[live-views]] — the human layer
- [[INDEX]] — the agent layer
- [[benchmark-2026-07-19]] — the measurement behind the cost argument
- [[adr-0001-knowledge-vault]] — the original navigate-don't-embed decision
