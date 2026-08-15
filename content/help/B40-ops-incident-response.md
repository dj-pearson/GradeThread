---
slug: ops-incident-response
title: "Operator: incident response, the short version"
category: troubleshooting
visibility: internal
audience: operator
sort_order: 140
pillar_path: /status
summary: The first five minutes, the two failure shapes that look identical from outside, and why the status page is updated before the cause is known.
faq:
  - q: Should I wait until I know the cause before updating the status page?
    a: No. "We are investigating" published at minute three is worth more than a precise explanation at minute forty. Customers are already noticing; silence is the thing that turns an outage into a trust problem.
  - q: Everything is 503. Is the service down?
    a: Not necessarily. A hung event loop and a crash loop present identically from outside and have different fixes, so the first diagnostic step is telling them apart.
---

Internal. The full runbook is [[incident-response]] in the vault. This is the
first five minutes and the two traps.

## First five minutes

**Confirm it is real.** One report is a report. Check the health endpoint and
the status page before mobilising.

**Update the status page.** Before you know the cause. "We are investigating"
published at minute three beats a precise explanation at minute forty, because
customers already know something is wrong and the only variable is whether they
hear it from you.

**Find the blast radius.** One route or everything. One tenant or all of them.
That question shapes every decision after it.

**Then diagnose.**

## The two shapes that look identical

Both present as 503 on every route, and they need opposite responses.

**A crash loop** means the process is starting, failing and restarting. Logs
show repeated boot sequences. Usually an unhandled rejection at startup, or a
boot guard refusing to start.

**A hung event loop** means the process is alive and answering nothing. Logs
show a normal boot and then silence. The proxy reports no available server
because nothing is responding, not because nothing is running.

Telling them apart is the first diagnostic step, and the vault note
[[edge-hang-vs-crash-loop]] exists because they were confused once and the wrong
fix was applied for hours.

## The schema-version case

If a deploy went out alongside a migration that was not applied, the edge boot
guard refuses to start. That is the guard working, not a fault.

It reports expected versus applied. The fix is to apply the migration, send
`NOTIFY pgrst, 'reload schema';` and redeploy, in that order.

Note the mid-sequence trap: the guard compares the maximum recorded version, so a
database missing a migration in the middle of the range can still read as
matching. See [[migrations-process]].

## Communicating

Update the status page as you learn things, including when you learn nothing.

Say what is affected in terms of what a customer was trying to do, not in terms
of components. "Grading is failing" is useful; "the worker pool is degraded" is
not.

Do not promise a time you are guessing at. A missed estimate costs more trust
than no estimate.

## Afterwards

Write it up. What happened, what was tried, what worked, and what would have
made it faster to find.

The last one is the valuable part and the one most often skipped, because by then
everybody wants to stop thinking about it. It is also the only part that makes
the next incident shorter.

## Who does what

One person owns the incident and communicates. Everybody else investigates.

The failure mode without that split is four people all investigating and nobody
updating the status page, which is exactly the version customers experience as
silence.

The owner does not have to be the most senior person present. They have to be the
one not head-down in logs.

## Reading a red CI as an incident

Not every red thing is an outage. A failing test lane on a machine that ran out
of memory reports every remaining lane as failed, which looks like twelve
regressions and is one killed process.

[[reading-a-red-ci]] covers that pattern. Checking it before mobilising has saved
more time than any other single habit here.

## What not to do first

Do not deploy a speculative fix before you understand the shape. A deploy during
an incident changes the thing you are trying to observe, and if it does not help
you now have two variables.

Do not restart repeatedly hoping it settles. A crash loop is already restarting;
adding more tells you nothing and destroys the log continuity you need.

Do not go quiet while you investigate. That is the one failure customers
actually experience as bad handling, rather than as an outage.

## Related

- [[incident-response]]: the full runbook.
- [[edge-hang-vs-crash-loop]]: telling the two shapes apart.
- [[migrations-process]]: the schema-guard case and the apply order.
- [[rollback]]: when going backwards is the right move.
