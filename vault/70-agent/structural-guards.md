---
title: Structural guards — how they fail silently, and what makes one trustworthy
type: learning
status: current
source_of_truth: vault
code_refs:
  - services/edge-functions/src/tests/_source-scan.ts
  - services/edge-functions/src/tests/source-scan_test.ts
reviewed: 2026-08-10
tags: [testing, guards, agent, quality]
summary: Seven guards in one session passed over the exact defect they existed to catch; the four failure shapes, and the primitives that remove three of them.
---

# Structural guards

Parts of this repo cannot be tested by calling them. A Stripe webhook handler
mixes SDK calls, service-role writes and email sends; an email template is a
tagged string. So the established idiom is a **structural guard**: read the
source and assert on its shape. `subscription-ack-disclosure_test.ts` was the
first, and the pattern is now used across billing, legal and migrations.

The idiom is sound. What keeps going wrong is subtler, and worse than a missing
test: **a loose guard stays green over the defect it exists to catch, and its
greenness is what stops anyone looking.** Every failure below was found by
sabotaging the code, never by reading the test.

## The four shapes

### 1. Checking the USE, not the DERIVATION

The US-2118 confirmation gate asserted that the handler contains
`if (!confirmUpgrade)`. Replacing the definition with `const confirmUpgrade =
true` left the file green while every unconfirmed click charged a prorated
amount. The assertion proved the gate *reads a variable* and said nothing about
where its value comes from.

Same shape: `const trialConverted = false` satisfying a check for the name
`trialConverted`.

**Pin the expression, not the identifier.**

### 2. Checking the FILE, not the SITE

US-2116's guard asked whether `appstore.ts` calls `recordPlatformAgreement`. It
does — once, in the seller branch. That file sells **two** products, and the
buyer branch shipped with no record at all. A file-level check over a file that
does two things is a check over neither.

Same shape: a `product: isBuyer ? …` check matching the audit payload instead of
the email argument; a `renewalNoticeCopy` check satisfied when the call was kept
for one value and the other hardcoded; a `matchesAddress` check satisfied by the
surviving import line.

**Scope the assertion to the branch and to the call.**

### 3. Prose standing in for code

A "there is no buyer pause column" assertion matched the comment saying there is
no buyer pause column. This happened **six times in one day** — a header
explaining a rule necessarily contains every identifier the rule is about.

**Strip whole-line comments before scanning.**

### 4. The slice is not what you think

Taking the first `{` after a function name lands inside an inline object
*parameter type*, so the brace match closes at the end of the annotation and the
"body" is the parameter list. That produced five failures against correct code —
and the tempting response was to weaken the assertion back into the file-level
check that had hidden the original bug.

Slicing to the first `return` has the same problem when a branch returns early
(a 409 guard above the work).

**Brace-match from after the parameter list; never slice to a terminator that
can legitimately appear early.**

## The primitives

`services/edge-functions/src/tests/_source-scan.ts` — `code()`, `fnBody()`,
`callArgs()`, `allCallArgs()`. They exist because four files had hand-rolled
copies of the same three helpers, written independently, three of them wrong.
Their own tests use the shapes that broke the copies, including the negatives:
a `//` inside a URL survives comment stripping, an object parameter type does
not swallow the body, and a call's arguments do not leak the enclosing function.

`fnBody()` and `callArgs()` **throw** when they find nothing. An empty string
would make every assertion after it pass vacuously, which is this whole page.

## The rule

**A structural guard is not trusted until it has been sabotaged.** Break the
thing it protects, in the way a careless edit would, and confirm the RIGHT named
test reddens — then restore. If nothing reddens, the guard is decoration.

Two things that make a sabotage prove nothing, both hit twice on 2026-08-10:

- **It landed in the wrong place.** `String.replace` takes the first match, and
  identical lines now exist in the seller and buyer halves of the same file.
  Anchor on something unique to the target.
- **The harness could not see the failure.** An ANSI strip written without the
  escape character left every run reading `NOTHING FAILED`. Include a control
  mutation that should change nothing; if it "fails" too, or if nothing ever
  fails, the parser is broken rather than the guards being strong.

## Related

- [[weighted-overall-lockstep]] — a contract kept by guards of exactly this kind
- [[backlog-priority-contract]] — another derived-not-declared invariant
- [[INDEX]]
