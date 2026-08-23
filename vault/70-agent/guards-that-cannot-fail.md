---
title: Guards that cannot fail
type: learning
status: current
source_of_truth: vault
code_refs:
  - src/test/step-price.test.ts
  - src/test/numeric-or.test.ts
reviewed: 2026-08-23
tags: [testing, ci, agent, verification]
summary: This repo's most common defect is not a broken check but a check that passes for the wrong reason; here are the thirteen shapes it took, the habits that catch them, and what a systematic sweep of eight guards found (four had holes).
---

# Guards that cannot fail

Across a long audit-and-fix session on 2026-07-18, the single most common
defect class in this repo was **not** broken code and **not** a missing test. It
was a check that ran, went green, and was measuring something adjacent to the
thing it claimed to protect. A second session on 2026-07-19 added an eighth
shape and a second habit — and produced three fresh instances of the very class
this note describes, written by the agent that had just read it. Recognising the
pattern is not the same as being immune to it.

Every instance below shipped. Every one looked healthy on a dashboard. Several
had been green for months while the property they existed to defend was broken.

This note exists so the eighth instance gets recognised instead of rediscovered.

> [!note] A ninth instance, 2026-08-01 (US-2381)
> Two helpers kept full unit-test coverage after their only caller
> (`item-canvas.tsx`) was deleted. The tests passed for months while the
> behaviour they implement — a blanked column clearing its eBay specific — had
> stopped happening. A second orphan from the same deletion, an optional
> `dirtyRef` prop nobody passed, was invisible to every check we had, because an
> unpassed optional prop is not a broken anything.
>
> The guard added for it (`src/test/aspect-projection-callers.test.ts`) is
> deliberately **narrow** — one module's projection helpers — because a
> repo-wide "exported but uncalled" gate collects an allowlist entry per false
> positive until it means nothing. Its allowlist requires a **reason string**,
> fails if an allow-listed helper regains a caller, and fails if an entry names
> something the guard no longer checks. It was verified by making it fail on
> purpose before it was committed, which is the habit below.

## The thirteen shapes it took

1. **The gate that hid the other gates.** CI ran `lint` first with default step
   semantics, so three style errors meant type-check, tests, coverage, build and
   the bundle guard never ran. The run was red — for lint — while the frontend
   went unverified for a day. *(US-1998)*

2. **The regex that could not match the thing.** The RLS guard tested
   `/\buser_id\b/`, which cannot match `seller_user_id` — the character before
   `user_id` is an underscore, a word character, so no boundary exists. 21 tables
   were silently exempt from a check whose stated promise was "a new zero-policy
   table fails until a human classifies it". *(US-2008)*

3. **The hand-maintained list that stopped growing.** The JSON-LD parity test
   imported 16 page components by name while the route registry held 213. Adding
   a page and forgetting the prerenderer produced a green CI — which is how the
   flagship data report and two calculators shipped their structured data to the
   SPA only, invisible to every non-JS crawler. *(US-2044)*

4. **The test that covered the half that was never broken.** After fixing a
   partial-refund clawback, the added tests exercised the pure arithmetic — which
   had always been correct. The actual bug lived in an unexported handler, so
   reverting the fix left all 4,181 tests green while a customer kept both the
   credits and the money. *(US-2033 → US-2040)*

5. **The suite that skipped in silence.** Seventeen tenant-isolation cases were
   gated on a fixture the seed script never emitted, including *"viewer cannot
   pay for a grade (drains owner credits)"*. The job was green. The tests were
   labelled as though the wiring had landed. *(US-2039)*

6. **The assertion pinned to today's state.** A pricing test asserted "the
   purchase guarantee is the one not-live feature". Shipping that feature broke
   the test, and the obvious fix — swap in the next unshipped feature's name —
   would have relocated the same problem to the next person. *(US-2073)*

7. **The fixture that omitted the field under test.** A byte-equality guard
   between the SPA and SSR JSON-LD builders passed, not because the builders
   agreed, but because its fixture never supplied the one field where they
   differed. *(US-2071)*


8. **The guard that matched its own context.** A substring search satisfied by
   text *near* the property instead of the property. Three instances, all on
   2026-07-19, all in guards written that same day:
   - a builder sweep that hand-listed five JSON-LD builders — none of which
     happened to be the ones being fixed, so it passed against a deliberately
     reintroduced anonymous node *(US-2103)*;
   - a scheduler check searching for a bare identifier, which the surviving
     `import` line satisfied after the guard it protected was deleted
     *(US-2104)*;
   - an upload check looking back a fixed 3,000 characters for
     `validateImageUpload`, matched by both the import line and a *different
     handler* in the same file, so removing the real validation left it green
     *(US-276)*.

   The fix is the same each time: match a **call** (`name(` with the paren, which
   an import cannot satisfy) and scope the search to the **enclosing function**,
   not a character window. Derive the set you check from the source of truth
   rather than listing it by hand.

9. **The mirror: a test that re-implements the rule and asserts the copy.**
   The most convincing of the nine, because it looks exactly like a behavioural
   test - real inputs, real expected values, six cases:

   ```js
   const step = (resolved, s) =>
     s > 0 && resolved > 0 ? Math.max(s, Math.round(resolved / s) * s) : resolved;
   expect(step(32.49, 1)).toBe(32);
   ```

   The file under test is never imported. Changing `listing-kit.tsx` to
   `Math.floor` - the one thing US-2739 AC4 exists to prevent, because flooring
   quietly costs the seller money on every cross-post - leaves all six green.
   `numericOr` had the same thing (`const first = (a) => a.find(...)`).

   Its quieter sibling is the **source scan**:
   `expect(src).toContain("function numericOr(")`. That pins the NAME and the
   CALL SITE, which is worth pinning, and says nothing about the body. On
   2026-08-21 four stories were marked done on these two shapes, all in
   `src/test/cross-post-setup.test.ts`, and three of the four survived being
   reverted to the exact bug they were written for.

   **A source scan is not automatically wrong.** US-2725's guard asserts "no
   bare `c.json({error}, 500)` inside this handler" - a property of the text,
   correctly scoped, and it holds up under sabotage in both directions. The test
   is whether the property you care about IS syntactic. Rounding is not.

   The fix in every case: export the function and call it. That is a smaller
   cost than a green suite over a broken one.

### How common is it, actually

Swept 2026-08-21: **93 test files read source to assert and never import the
code.** That number is not a defect count, and reporting it as one would be its
own version of the mistake this note is about.

Four were sampled by sabotage, control-first:

| suite | verdict |
|---|---|
| `cross-post-setup.test.ts` | **the outlier.** 70 source-asserts of 111, plus two mirrors. Three separate reverts-to-the-original-bug went unnoticed. |
| `two-person-controls_test.ts` | **a hole.** Correct where it looks, blind where it does not: its hand-written route list omits the newsletter kill-switch route, so removing that step-up passed. |
| `account-erasure-order_test.ts` | **sound.** Ordering IS a property of the file's arrangement, its `soleIndex` refuses an ambiguous match, and both "delete the retention call" and "run it after the irreversible delete" fail it. |
| `billing-receipts-and-meters.test.ts` | **sound enough.** Asserts a duplicate section is gone and a component is rendered - structural facts - with behaviour covered elsewhere. |

So the shape to look for is not "reads source". It is **reads source about
something that is not syntactic** (a rounding rule, a coercion) or **reads source
from a hand-written list** (which only defends what someone remembered). Both
failed here; the two that asserted genuinely structural properties held up.

### Writing the harness is where the next one hides

Three extension guards were added on 2026-08-21 by loading `lister/common.js`
into a `new Function` with the browser surface stubbed. Every one of them
passed on a broken harness first, and each failure mode is reusable:

**The stub that cannot express the failure.** `commitTags` dispatches keydown,
keypress AND keyup per tag. The first harness counted Enter *events*, so "the
second tag sticks" actually meant "the second keystroke of the first tag
sticks" — and the third keystroke cleared it anyway. All three cases passed
against a model with no way to represent the bug. It counts value *writes* now.

**The stub that skips the code path.** `GT.setValue` walks
`HTMLInputElement.prototype` for the native value setter and calls it directly,
which is the React-safe way to set a controlled input. A plain-object stub has
no prototype to walk, so the test exercised a branch the extension never takes.
The harness defines real classes.

**Multi-line anchors do not match a CRLF tree.** Two sabotages reported SKIP
because the anchor used a bare `\n`. They read as "the property is not
implemented" until you notice both skipped for the same reason. Use single-line
anchors, and treat SKIP as loudly as NOT CAUGHT.

**Escapes die on the way in.** One regex took three attempts: a character class
that truncated at the first inner quote, a backreference that arrived as a
literal `U+0001`, and a broken string literal. The `U+0001` was caught by
the invisible-character guard (src/test/no-invisible-characters.test.ts) naming the file and line. Where a scan will do, a
line scan beats a regex — it has nothing to escape.

And the one that is not about harnesses: **a sabotage can land in the wrong
place.** Several "NOT CAUGHT" results this session were edits that never touched
the code under test — a `return false;` replaced at the first occurrence rather
than the intended branch, an `el.click()` inserted past the end of the function.
A NOT CAUGHT is a hypothesis; confirm the edit actually changed the thing before
recording a gap.

## The habit that catches all of them

**Break it on purpose and watch it fail.**

Before trusting a guard, reintroduce the exact defect it claims to prevent and
confirm it goes red — then restore. Every fix in that session was verified this
way, and it caught more real problems than the audits did, including three cases
where the *fix* was wrong rather than the code:

- a `_headers` edit aimed at prerender markers that the build consumes, so it
  would have matched nothing and silently done nothing;
- a parity assertion comparing a `JsonLd[]` against a string, which "failed" on
  routes that were already correct;
- a test that built its own grouping map and asserted on that, never touching
  the code it named.

A guard you have not watched fail is a guard you do not know works. That is the
whole of it.


## The second habit: check that it RUNS

Watching a guard fail proves it *can* fail. It does not prove anything ever
asks it to.

On 2026-07-19 the `scripts/` suite (~190 tests) and the extension suite (15
files) were invoked by **no CI workflow at all** — the first runs under a
separate vitest config that `test:coverage` does not include, the second is a
bare node script. Both ran only via the local pre-push hook, so the hook was
strictly stricter than the pipeline `CLAUDE.md` calls "CI parity". A
`--no-verify` push skipped them entirely.

The cost was concrete on both counts: `prd-lint.test.mjs` sat red for 15
commits, and two guards written that same day against defects that had *already
shipped once* — the legacy⇄unified selector parity check and the Firefox
version-floor check — could not have failed a build. The author had negative-
verified both. Neither was wired to anything.

So the full habit is two questions, and the second is cheaper to skip:

1. Does it go red when I break the thing? *(break it and watch)*
2. Does anything actually run it? *(grep the workflows, not the package scripts)*

> [!warning] A tenth instance, 2026-08-16 — and question 2 has a THIRD form
> `services/edge-functions/src/tests/ledger-append-only_test.ts` was run by the
> general `deno test src/tests/` lane, so question 2 answers *yes*. Seven of its
> eight cases are source scans and pass there. The eighth carries
> `ignore: !RUN`, and **no workflow supplies the fixture that clears it** — so
> the one assertion that actually proves 00597 (the credit ledger cannot be
> rewritten even by `service_role`) had been skipped in every run that ever
> happened. It passed the instant it was given a database.
>
> A file being *in* a suite is not the same as its assertions being *executed*.
> Where a test is conditional, the question becomes: **does anything run it with
> the conditions its assertions need?** A skipped case and a passing case are
> the same colour in the summary line, and the count of ignored tests is the
> only place the difference shows.
>
> Guard: `scripts/integration-lane-coverage.test.mjs` fails when any
> fixture-gated edge test is named in no workflow.
>
> Three more from the same pass, all invisible for the same reason — **CI starts
> every lane from a fresh `supabase start`, so anything that works exactly once
> works forever in CI**. The money fixture reset by DELETING ledger rows, which
> 00597 forbids for every role, so its second run always died. 00597's own risk
> note records that it was checked against "no migration and no edge module"
> doing that; a seeder in `scripts/` is neither, and fell through the gap
> between the two categories checked. `credit-refund_test.ts` hardcoded its
> Stripe payment-intent ids against a grant that is idempotent on them by
> design. And the tenant fixture died on a unique constraint the second time,
> then on the next one along. **If a thing is only ever run against a fresh
> database, "it works" and "it works once" are indistinguishable.**

## The third habit: run a control, or the sabotage lies too

Breaking the code proves nothing if the suite was already red.

On 2026-08-21 a sabotage run reported that the old mirror test "caught" all
three breakages of `stepPrice` - which would have made the whole finding above
wrong. It had not. The refactor that exported `stepPrice` moved the expression
that test scanned for, so it was failing before the first sabotage was applied,
and a red suite "catches" everything you do to it.

With a green control asserted first, the real numbers were: new test 4 of 4
caught, old source scan 4 of 4 **missed**.

So: assert every suite is GREEN before the first sabotage, and treat any run
without that control as unread. The same trap turned up the same day probing
whether a GoTrue admin route existed - the 401 read as "the route is there and
refused me" until a deliberately nonexistent control route returned 401 too,
because Kong was rejecting before GoTrue ever saw it.

## Corollary: a scoped search is not evidence of absence

Shape 8 has a research twin, and it cost a duplicated guard on 2026-07-19.

Before adding a `.or()`-on-mutation guard, the agent searched for the rule id in
`services/edge-functions/src/tests/` and `scripts/` — two directories, neither of
which was where the existing guard lived (`src/lib/__tests__/`). The empty result
was read as "no guard exists", a claim that then went into a commit message. A
repo-wide grep returns it as the second hit.

The guard had been on `main` since the previous day.

**Before building a check, grep the whole repo for the rule id — not the
directory you expect it in.** An empty result from a scoped search is a fact
about the search.

## Corollary: audit findings are hypotheses

Four confidently-argued findings from that session — each with file:line
citations — did not survive reading the code:

- a batch described as unbounded had carried a `.max(200)` cap all along;
- "counts by fetching ids" turned out to be ids that *derive storage paths*, so
  the proposed `head: true` fix would have **broken account deletion** — the
  exact GDPR failure another story had just fixed;
- a page listed as having four unbounded queries was already a correct
  `.in()` cascade, and the `select("*")` count was a shallow signal;
- "37 tests skip" was 17 when measured.

Roughly a 15% false-positive rate, and one would have introduced a bug. Treat an
audit finding — including one from an agent — as a lead to verify, never as a
conclusion to act on.

The 2026-07-19 session held that rate almost exactly. Four more did not survive
reading the code: a "blank OG fallback" story whose SSR-attribution fix would
have **poisoned a shared edge cache** with one visitor's referral code; a
three-extensions story whose central question had already been answered by a
founder decision six days earlier; two cited GDPR-export sites that were
load-bearing rather than wasteful. One suspicion was the agent's own — that a
grading copy path could smuggle HEIC into the private bucket — and it was
checked before filing rather than after. It was wrong.

## The sweep, 2026-08-23: probe every guard instead of waiting for one to fail

Every shape above was found while working on something else. This section is
what happened when the guards were probed **systematically** rather than
opportunistically: pick a guard, write a textbook instance of the thing it
exists to stop, and see whether it says anything.

**Eight guards probed. Four had holes. Four were solid.** That ratio is the
argument for doing it deliberately — none of the four holes was going to be
found by the work that happened to pass nearby, because a green guard reads
the same whether it is watching or not.

### Solid, so nobody needs to re-audit them blind

- **`rls-guard_test.ts`** — five probes, all caught: a `user_id` table with no
  RLS, `USING (true)`, a policy gated on bare `authenticated`, a zero-policy
  table not declared service-role-only, and the subtle one, a correct SELECT
  policy beside an `INSERT WITH CHECK (true)`.
- **`schema-version_test.ts`** — the US-1108 triple. Caught a new migration
  with no version bump, one with no self-record footer, and one whose footer
  recorded the wrong version.
- **`check-chained-sheets.py`** — caught two `.sheet` modifiers on one view
  *including* when other modifiers separated them.
- **`no-raw-jpeg-encode.py`** — caught a bare `jpegData(compressionQuality:)`.

### Four new shapes, numbered on from the nine above

10. **The rule id that names nothing.** The UI anti-pattern gate listed seven
    ENFORCED ids. Four could never fire: two were not the tool's names at all
    (`icon-tile-grid` and `uppercase-eyebrow`; impeccable calls them
    `icon-tile-stack` and `hero-eyebrow-chip`), one existed under no spelling,
    and one was browser-scoped so a source scan cannot raise it. **An id that
    matches no rule is not an error in that tool — it is simply absent from
    the findings, which is byte-identical to a clean codebase.** The gate
    reported seven and enforced three, and a green run was read as evidence
    for all seven. Fixed by making the gate scan a fixture per enforced rule
    and fail when one stops firing. *(commit a986bc905)*

11. **Two lists where the property is one.** `prod-diagnostics-safety.test.ts`
    checked the psql copy of the operator script against twelve write verbs
    and the CONSOLE copy against six. TRUNCATE, GRANT, REVOKE, COPY, VACUUM
    and REINDEX were forbidden in the file that runs through a client and
    permitted in the file a human pastes into the Supabase editor — **the
    weaker check guarding the more dangerous path.** `SELECT ... INTO` walked
    past both: it creates a table, names none of the banned verbs, and the
    copy it leaves behind carries user rows with no RLS. *(commit 1d1b44b21)*

12. **The scan pinned to one file when the property spans a corpus.**
    `sync-payload-guard_test.ts` says in its own header that its column
    allowlist "stops a future migration adding somewhere to put" buyer PII. It
    read 00632 alone and parsed only its `CREATE TABLE`, so an
    `ALTER TABLE ... ADD COLUMN buyer_name text` in any later migration was
    invisible. Three probes — buyer name, shipping address, and a generic
    jsonb payload — all passed. *(commit 3e3044b56)*

13. **One value of the dimension the rule gates on.** The 100%-failure
    detector from US-2668 compares `http_status >= 400`. Every test used 500,
    so narrowing it to `>= 500` broke nothing — **and trial-expiry, the
    incident the detector was written for, answered HTTP 400.** The guard had
    no test at the status that caused it. Its sibling gap: the file tested
    1-of-6 and 6-of-6 with nothing between, so `=== runs.length` could become
    `> runs.length / 2` undetected. *(commit ce033ae62)*

### A fifth, which is shape #2 wearing a list

`ui-check-scope.test.ts` asserted `ENFORCED.has(rule)` for four named tells
and passed the entire time two of them enforced nothing. **Membership in a Set
is not the property anyone cares about.** The same shape appeared twice more
the same day in guards written *during* this sweep: an enum check that looped
over a hardcoded `["sneakers","boots","sandals"]` stayed green when one of
three call sites was changed to a non-member, and a column check that looped
over a hand-listed set stayed green when a column was renamed to one that
exists nowhere. Both were fixed the same way: **extract the values the
artifact actually uses, then check those.**

### The probe is the part to get right

Two probes in this sweep were wrong rather than the guard:

- Renaming `api/grade/submit` to `api/grade/submitt` left a parity guard green
  — correctly, because the check is a substring test and `submitt` **contains**
  `submit`. Nothing had been removed. A mutation must remove the property, not
  decorate it.
- `.limit(50).order("id")` passed the mutation-qualifier guard and looked like
  a blind spot. It is legal: both methods are `searchParams.set()` followed by
  `return this`, so the JS call order never reaches the wire. Checked against
  the installed `postgrest-js` source rather than assumed. Reporting it would
  have been a false finding, and "tightening" the guard would have rejected
  correct code.

So the control matters in both directions: a probe that stays green may mean
the guard is blind **or** that the probe did not break anything.

## Related

- [[grading-scale-and-weights]] — the rounding rule that shipped wrong twice is
  shape #6 in production: a value duplicated across four sites with nothing
  asserting they agreed.
- [[seo-public-route-registry]] — the lockstep registry that shape #3 failed to
  guard.
