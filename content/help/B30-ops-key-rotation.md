---
slug: ops-key-rotation
title: "Operator: key rotation"
category: troubleshooting
visibility: internal
audience: operator
sort_order: 130
pillar_path: /developers
summary: When rotation is required rather than good hygiene, the order that avoids an outage, and where the values live. No secret is written here.
faq:
  - q: Does this article contain any keys?
    a: No, and it never will. It names where a value is stored. A runbook containing a secret is a secret in every backup, every clone and every search index that runbook ever touched.
  - q: What is the correct order?
    a: New value in, deploy, verify, then revoke the old one. Revoking first produces an outage between the revoke and the deploy, every time.
---

Internal. The full procedure and the storage locations are in [[key-rotation]]
in the vault. This is when to do it and the ordering rule people get wrong.

## No values here

This article names where things live. It contains no key, no token and no
secret, and it never will.

A runbook that contains a value puts that value into every backup of the
document store, every clone of the repository, and every search index the
document has ever been in. Rotating it afterwards means rotating everything it
touched.

See the Pearson Media rule: secrets are references, never values.

## When rotation is required

**Somebody who had access left.** Not eventually. As part of the leaving.

**A value was exposed.** Committed, pasted into a ticket, screenshotted, logged.
Treat exposure as compromise regardless of how briefly.

**A provider says so.** Some rotate on a schedule and some force it.

**Scheduled hygiene.** Regular rotation for long-lived credentials, which mostly
matters because it proves the rotation procedure still works.

## The ordering rule

New value in, deploy, verify, then revoke the old one.

Revoking first creates an outage lasting from the revoke until the deploy
completes, every single time, and that window is longer than anybody estimates
because the deploy is when you discover the value was needed in a second place.

The only exception is a confirmed compromise, where the outage is the cheaper
side of the trade and you revoke immediately.

## Verify before revoking

"Deployed" is not "working". Check the thing that uses the credential actually
succeeded with the new value.

For anything with a boot-time check, watch the boot. For anything asynchronous,
watch one real operation complete rather than assuming the absence of errors
means success.

## Where each value lives

Named in [[env-reference]] and in [[key-rotation]]. Between them they cover the
edge service, the Cloudflare Pages environment, and the provider consoles.

Team-shared variables are the case worth knowing about: some values are shared
across projects deliberately, so rotating one changes behaviour somewhere you
were not thinking about. Check what else reads it before you rotate.

## After a compromise

Rotate, then work out how, in that order. The investigation is calmer with the
door already shut, and nothing about it gets easier by leaving the door open.

Then write down what happened. Not for ceremony: the same exposure route
recurring is the commonest pattern, and the only defence is a record.

## Rotating a shared value

Some values are shared deliberately across projects, so rotating one changes
behaviour in a system nobody in the room was thinking about.

Before rotating anything shared, list what reads it. [[env-reference]] is the
place that answer lives, and checking takes a minute against an outage that
takes considerably longer.

## The rotation that proves the procedure

Scheduled rotation of a long-lived credential is partly hygiene and mostly a
rehearsal.

A procedure nobody has run in a year is a procedure with a broken step in it that
nobody knows about, and the moment you find out is during a compromise. Running
it while nothing is on fire is the point.

## What counts as exposure

Treat all of these as compromise, without debate about how likely it is:

Committed to a repository, even privately, even briefly. Pasted into a ticket, a
chat or an email. Printed in a log. Included in a screenshot. Read aloud on a
call that was recorded.

The common thread is that the value now exists somewhere it was not designed to
be deleted from, and "probably nobody saw it" is not a control.

## Related

- [[key-rotation]]: the procedure and the locations.
- [[env-reference]]: what each variable is and where it is set.
- [[incident-response]]: if the rotation is part of a live incident.
