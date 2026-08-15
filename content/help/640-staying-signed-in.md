---
slug: staying-signed-in
title: Staying signed in
category: mobile
visibility: public
audience: all
sort_order: 50
pillar_path: /how-it-works
summary: How long a session should last, why the interval between logouts is the single most useful thing to report, and what to try first.
faq:
  - q: How often should the app log me out?
    a: Essentially never during normal use. A session refreshes itself in the background, so repeated logouts are a fault rather than a policy.
  - q: What is the most useful thing to include in a ticket?
    a: How often it happens. Roughly hourly and roughly daily have completely different causes, and saying which turns a long investigation into a short one.
---

The app is meant to keep you signed in indefinitely. A session refreshes itself
quietly in the background, so being asked to sign in again during ordinary use is
a fault rather than a security policy.

## The interval is the diagnosis

If it is happening to you, the single most useful thing you can tell us is **how
often**.

**Roughly every hour** points at the session refresh not happening. The
underlying credential has a lifetime of about that, and something is preventing
the renewal that should be invisible.

**Roughly once a day** points at something else entirely, usually a periodic
check against the identity provider deciding the credential is no longer good.

These have different causes and different fixes, and they look identical from the
outside: the app asks you to sign in. Which one it is cannot be guessed from
"it keeps logging me out", which is why the interval is worth noticing before you
report it.

**Once, after an update** is normal and not worth reporting.

## What to try first

**Sign in again properly**, rather than dismissing the prompt. A clean sign-in
often re-establishes what lapsed.

**Check the date and time on the phone.** A clock that is wrong by enough will
make a valid credential look expired. Automatic time zone is the correct setting.

**Check whether it happens on one device or all of them.** One device points at
that device; all of them points at the account.

**Check whether the web is affected too.** If the website is fine and only the
app is not, that narrows it considerably.

## What does not cause it

**Using several devices.** Signing in on a phone does not sign you out
elsewhere. Sessions are per device and are meant to coexist.

**Changing network.** Moving from wifi to mobile data does not end a session.

**Closing the app.** The session survives the app being closed and the phone
being restarted.

If any of those seem to trigger it, that is itself useful information and worth
including.

## Reporting it

Open a ticket with three things: how often, which device, and whether the web is
also affected.

That combination usually identifies the cause without any further conversation,
because the interval narrows it to one of two mechanisms and the device answer
narrows it again.

What is less useful is a screenshot of the sign-in screen. It looks the same
whatever caused it.

## Signing out on purpose

In settings. It ends the session on that device only.

If you have lost a phone, changing your password ends every session everywhere,
which is the stronger action and the correct one in that situation.

## What a normal session looks like

Sign in once. Stay signed in across app launches, phone restarts, network
changes and updates.

The credential behind that has a short life and is renewed quietly in the
background, which is why the renewal failing looks like an hourly logout and why
that specific interval is diagnostic.

## If it is happening on the web too

Then it is the account rather than the app, and the useful detail changes: which
browser, whether private browsing is involved, and whether any extension is
clearing site data.

Browser settings that clear cookies on close will sign you out every time by
design, and that is worth ruling out before reporting anything, because it looks
identical to a fault and is not one.

## Security actions that end sessions on purpose

Changing your password ends every session everywhere. That is intended and it is
the correct response to a lost or stolen device.

Revoking a device, where offered, ends that one. Neither is a fault, and both are
worth knowing about so that a deliberate sign-out is not mistaken for the problem
this article is about.
