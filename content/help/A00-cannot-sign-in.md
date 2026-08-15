---
slug: cannot-sign-in
title: You cannot sign in
category: troubleshooting
visibility: public
audience: all
sort_order: 10
pillar_path: /how-it-works
summary: The five causes that account for nearly every failed sign-in, in the order worth checking them.
faq:
  - q: My password is definitely right and it still will not let me in.
    a: Then it is almost certainly an unconfirmed email address. The app says so rather than making you guess, but the message is easy to read past when you are sure the password is fine.
  - q: I signed up with Apple or Google and it is asking for a password.
    a: You are on the password path for an address that has no password set. Use the Apple or Google button instead, or set a password with the reset link.
---

Work through these in order. The answer is usually earlier in the list than it
feels like it should be.

## 1. The email was never confirmed

By far the most common cause, and the one people skip because the password is
obviously correct.

Signing up sends a confirmation link. Until it is clicked, the account exists
but cannot sign in. The app says so, and that message is easy to read past when
you are certain the problem is the password.

Check spam and any quarantine your provider runs. If the link is old, it has
expired: ask for a new one from the sign-in page rather than clicking the old
one again.

## 2. You are on the wrong path

If you signed up with Apple or Google, there is no password on the account
unless you set one afterwards.

Typing a password into the email form for such an account fails in a way that
looks like a wrong password. Use the button you originally used.

The reverse also happens: an account created with a password, then somebody
tries the Google button with a different Google address, and lands in a new
empty account rather than the one they wanted.

## 3. A different email address

Two addresses, one work and one personal, is the usual version. So is a typo in
the address at signup, which produces an account that never received its
confirmation because the address does not exist.

If a password reset says no account exists, that is the answer: you are trying a
different address from the one you registered.

## 4. The password is genuinely wrong

Use the reset link. It is faster than remembering and it works.

Watch for a browser or password manager filling an old value. A field that
appears filled when you have not typed anything is worth clearing and typing
into by hand once.

## 5. Something on your side

**Clock.** A device clock wrong by enough breaks authentication in ways that
look arbitrary. Automatic time zone is the correct setting.

**Browser data cleared on close.** A common privacy setting that signs you out
every session by design. It is not a fault, and it looks exactly like one.

**Extensions that block storage.** Some privacy extensions prevent the session
being stored at all.

Try a private window. If it works there, it is a browser setting rather than the
account, which narrows it enormously.

<!-- SCREENSHOT: the sign-in screen showing the unconfirmed-email message -->

## Still stuck

Open a ticket with the email address you are using and which route you are
trying, password or Apple or Google.

Almost every sign-in question is answerable in one reply once we can see the
account, and the address is the thing that makes that possible. What is not
useful is a screenshot of the error, because every one of the causes above looks
much the same from the outside.

## If it is a phone app doing it repeatedly

That is a different problem: not being able to sign in at all is not the same as
being signed out over and over. See
[Staying signed in](/help/mobile/staying-signed-in), and note the interval
before you report it.

## What we can and cannot see

We can see whether an account exists on an address, whether it has been
confirmed, and when it last signed in successfully.

We cannot see your password, and nobody here can read it or tell you what it is.
That is how password storage is supposed to work, and it means "can you check my
password" has no answer other than a reset link.

We also cannot see why a sign-in attempt failed on your device if it never
reached us, which is what a clock problem or a blocked storage setting produces.

## The two-minute version

If you have thirty seconds rather than five minutes: request a password reset.

It confirms the account exists on that address, it tells you if it does not, and
it fixes the password case outright. Three of the five causes above resolve or
identify themselves from that one action.
