---
title: Blocked-work gates — the decisions only Dj can make
aliases: [decision queue, owner decisions, what unblocks the backlog]
type: reference
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-08-10
tags: [agent, backlog, decisions]
summary: Thirteen open stories are stuck on a judgement call rather than on effort; four of those answers unblock more than one story, one unblocks nine, and one unapplied migration is holding 34 commits.
---

# Blocked-work gates

`shipped-but-unwired.md` has linked here since it was written. This is the note
it meant.

**What belongs here:** an open story stopped by a JUDGEMENT nobody else can
make. Not effort, not a deploy, not missing data — those are different queues
and are listed at the bottom so nobody confuses the two.

**Why it exists:** the decisions were each recorded carefully, on the story
where they arose, and then sat there. Scattered across thirteen stories they read
as thirteen small stalls. Collected, four of them turn out to gate a dozen others,
and most can be answered in one sitting because the previous passes already did
the work of laying out the options.

Ordered by leverage, not by priority number.

## 1. The counsel gate — nine stories (US-2114)

**Do we put the subscription copy in front of a lawyer, and do we write to one
strictest standard or vary by state?**

Recorded options: design to a single strictest standard — recommended, since no
state-based logic exists anywhere in the product — or vary by billing address.
The recommendation is California's ARL, because it binds and it tracks the
vacated federal rule closely.

Waiting on it: US-2115 AC5, US-2116 AC1+AC5, US-2118 (copy half), US-2124
AC1+AC3, US-2125 AC3, US-2127 AC3+AC4, US-2131 AC3, US-2133 AC1, US-2145 AC6.

The engineering under most of these is already built. What is missing is
approved wording. Note US-2117 records that an earlier pass over-applied this
gate and four stories turned out to be plain engineering — so check before
adding to the list.

## 2. Is Android on the launch plan? (US-2015 AC4)

**Yes or no.** No options were recorded because there are only two, and the
note is blunt that "if it is, the remaining work is essentially the whole app."

Waiting on it: the US-1299 epic and the US-1300…US-1396 block behind it, plus
US-2126 AC2–AC4, which became real on 2026-08-06 once a billing client existed.

Yes is very large. No is a paragraph. Either way the backlog stops carrying an
epic whose status nobody can state.

## 3. May a regrade of the same photos return a different score? (US-2035 AC1)

Recorded options: restore determinism — costly, and possibly not available on
this model family — or stop promising it, which is cheap but changes what a
certificate means.

Waiting on it: the rest of US-2035, and US-2107 AC3.

Keeping the promise means wiring `grading-reliability.ts` as a live
self-consistency gate; it exists, is tested, and has zero callers. Dropping it is
a public copy change. **Do not resolve it by pinning a temperature** — the model
family rejects the parameter.

## 4. Is quick-grade a lighter product? (US-2309 AC1)

**Should the fast grade behind the browser extension carry the same safety caps
as a full grade?**

Recorded options: (a) it is a lighter product and must be labelled as such
everywhere it surfaces, including not being called *certified*; or (b) it
carries the pipeline controls and stops being quick.

This one has a published claim attached, which is why it is higher than its
priority number. `grading-methodology.tsx` tells buyers that anything under 0.75
confidence goes to a human — and quick-grade skips every cap that would lower
confidence, so a quick 0.8 can be a grade that shipped unchecked while appearing
to satisfy the promise.

## 5. Does paid consumer grading belong on iOS? (US-2016 AC1)

Recorded branches: if yes, implement submit / pay / status / dispute on iOS. If
no, document why and confirm the 14-day dispute obligation is discharged some
other way.

Either answer costs something: a dispute window only one client can reach is a
chargeback risk in both directions.

## 6. Burn the leaked extension key, or rewrite history? (US-2284 AC3)

Recorded options: treat-as-burned — rotation makes the leaked copy inert, no
rewrite, and usually the right answer for a signing key — or rewrite with
BFG/filter-repo, which rewrites every open PR and invalidates every clone.

**Sequence matters more than the choice.** AC1 (rotate the key) is a separate
action, and US-1757 must not publish to the Chrome and Firefox stores before it
happens. Rotation is cheap now and expensive after publishing.

## 7. Darken the accent red? (US-2334 AC1+AC4)

Recorded options: move `--accent` from `#f03d5f` to `#cc1f3d` (5.48:1, matching
`--destructive`, every hover state across the app going slightly deeper), or
leave it and accept a hover/selected label at 3.79:1 — below the 4.5:1 AA bar.

Blast radius is measured: 39 `bg-accent` uses, 12 `text-accent-foreground`,
mostly hover states. Destructive buttons already pass and are unaffected. It is a
brand call because **no red in the documented palette clears the bar.**

## 8. Should a default admin hold 8 of 9 permissions? (US-2354 AC4)

Today every permission check except `users:role` is a no-op for a default admin,
and nothing prompts an operator to narrow a role. The note calls this the
highest-leverage item left on that story. Narrowing is a config change plus a
test update.

## 9. Untrack 31 committed junk files? (US-2437 AC3)

It changes what a fresh clone receives, which is why it is a decision and not a
lint fix. Three groups, already sorted in `scripts/check-tracked-ignored.mjs`
(which CI reads): `temp_prd/**` (20 unzipped Word parts), generated media
(`assets/hf_*`, an iOS screenshot, a `.pyc`), and `supabase/.temp/cli-latest`.
One command per group once the answer is yes.

## 10. Retry a failed weekly email next week? (US-2314 AC3)

Recorded options: (a) widen selection to the previous two weeks and skip anyone
with a log row, accepting stale content; or (b) accept the loss and rely on the
now-visible failed count plus the `job.failed` alert.

(b) is nearly free and is what already ships. (a) means mailing someone a
celebration of a week that is two weeks gone, carrying a streak number that has
since moved.

## 11. Keep or kill the web listing-copy button? (US-2442 AC1)

Recorded branches: if the composer's rewrite feature has genuinely superseded it
on the web that is a legitimate answer — delete `useListingCopy`; otherwise wire
it somewhere a seller can reach.

"Superseded" is defensible: rewrite already offers title_seo, title_shorten,
title_keywords, description_tighten and description_regen. **Either way, do not
delete the edge route — iOS uses it live** (AC4, and it is a hard rule).

## 12. May support cancel, change or comp a BUYER subscription? (US-2458 AC4)

Support can now SEE a buyer subscription. They still cannot act on one: no admin
route writes any buyer column, and a buyer comp additionally needs a buyer
equivalent of `subscription_status = 'comp'`, which today is a seller-only enum
value.

This is a decision about writes against a customer's money, not a gap. The read
half shipped 2026-08-10 precisely so the decision could be made with the state
visible.

## 13. Is "only destruction needs an audit row" the rule? (US-2459 AC4)

`admin-tasks.ts` audits its DELETEs and not its creates or updates. That looks
deliberate — and nothing states it, because a classifier bug was reporting those
routes as audited anyway. Six writing routes are now filed OPEN awaiting this
one answer; three of them are the tasks routes and become EXEMPT the moment the
rule is written down once.

The other three want their own look: an ads theme archive, a grading review
release (claim and approve both audit, release does not), and a newsletter
enforce that lands in `ops_events` rather than the central log — the same
domain-trail question as gate 1's ads routes.

## Not decisions — different queues

Kept here so nobody files them as gates:

- **⛔ BLOCKS THE PUSH — one operator action:** migration `00586` is HELD and
  unapplied, and the held-migration gate refuses the push until it is. As of
  2026-08-10 that is **34 local commits** behind one SQL statement. It restores
  the signup clickwrap record, which has not been written since `00303` — so
  until it runs, `POST /api/legal/confirm-signup` keeps refusing every caller
  and the metric added for it fires on every email signup. `PENDING_MIGRATIONS.md`
  carries the risk note, the apply order and the rollback. **Nothing else in the
  backlog unblocks as much as this.**

- **Needs production data first:** US-2359 AC4, US-2123 AC4, US-1996 AC5,
  US-2444 AC1, US-2304 AC4. Read the data, then there may be a call.
- **Needs a deploy or a live measurement:** US-2001 AC2+AC3, US-2330 AC2+AC4,
  US-2395 AC7, US-1968.
- **Needs a machine or an account we do not have here:** a Mac (US-2090,
  US-1995), a screen reader (US-2335 AC4), real Firefox/Edge (US-1881), a live
  eBay seller account, a live Stripe test run (US-2017, US-2119, US-2118,
  US-2451, US-2452, US-2453 — one test-mode buyer subscription taken through
  purchase, renewal, a declining card and a cancellation exercises all six
  buyer billing emails at once).
- **Needs Docker running:** US-2457 AC4. The buyer half of billing
  reconciliation needs a migration that swaps a partial unique index, and
  `verify:db` is the only thing that can prove the swap applies to a table with
  live rows. Scoped in full on the story; one focused session once Docker is up.
- **A one-minute dashboard check, not a decision:** US-2125 AC2's other half.
  The Stripe billing portal is opened with no `configuration`, so the account
  default applies. If "Cancel subscription" is enabled there, the portal is a
  second cancellation path bypassing the reviewed flow entirely — the exact
  defect AC1 fixed for the Free tile, through a different door. Settings →
  Billing → Customer portal → Cancellations.
- **Needs sourced facts that do not exist:** US-2222, US-2210, US-2139,
  US-2131, US-2221, US-2220, US-2218, US-2215 AC3. Inventing these is the
  specific failure those stories were written to prevent — see
  [[brand-kb-negative-findings]].

## Already decided — do not re-open

An earlier pass listing "decision needed" is not evidence one is: US-1997
(ACTIVATE, 2026-07-23), US-2304 AC1 (FlipDesk requires the tag photo), US-2127
AC1 (public pages win, delete the 14-day guarantee claim), US-2219 AC3 (disclose
and cap, do not block the sale), US-2351 AC5 (reviewer joins
`PRIVILEGED_ROLES`), US-1881 AC4 (moot), US-1968's SKU question (resolved by
US-1999). See [[shipped-but-unwired]] for why a stale claim in a note costs a
session — it happened five times on 2026-08-09 alone.

## One requirement, two owners

Duplicated requirements hide here. Two were resolved on 2026-08-09 (US-2147 AC5
into US-2139 AC1; US-2139 AC6 into US-2133 AC3). Live ones to watch:

- **US-2133 AC2** (claim posture) feeds US-2133 AC3, US-2145 AC6 and US-2219 AC5.
- **US-2284 AC1** (rotate the key) gates US-1757 by sequence rather than by
  requirement.
