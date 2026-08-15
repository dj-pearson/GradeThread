---
slug: api-keys-and-the-sandbox
title: API keys and the sandbox
category: integrations
visibility: public
audience: developer
sort_order: 10
pillar_path: /developers
summary: Minting a key, what the sandbox does differently, and exactly what to do in the first five minutes after one leaks.
faq:
  - q: Is the key shown again after I create it?
    a: No. It is displayed once. Store it in whatever you use for secrets before you close the dialog, because there is no way to recover it afterwards.
  - q: A key leaked. What now?
    a: Revoke it first, then work out how. Revoking takes seconds and stops the bleeding; the investigation can happen with the door already shut.
---

The API grades garments from your own product. This is how to get a key, how to
try it without spending anything, and what to do when one escapes.

## Minting a key

Developers, in the account area, if your role can manage API keys.

The key is **shown once**. Copy it into your secret store before closing the
dialog. There is no way to display it again, which is deliberate: a key you can
re-read from a web page is a key anybody with your session can re-read.

Name keys for where they are used. "Staging worker" and "Zapier" tell you what
breaks when you revoke one; "key 3" does not.

<!-- SCREENSHOT: the API keys page after creating a key -->

## The sandbox

A separate environment for building against.

**It does not spend credits.** That is the main point. Building an integration
means calling the endpoint dozens of times with rubbish inputs, and paying for
that is a bad reason not to test properly.

**It returns realistic shapes, not real grades.** Responses have the correct
structure, the correct fields and plausible values, so your parsing, your error
handling and your retries are all exercised. What you must not do is treat a
sandbox score as an assessment of the garment you sent.

**Its data is separate.** Nothing you create there appears in your live account.

Build against sandbox, switch the key, go live. The only thing that changes is
which key you send.

## Rotating a key

Create the new one, deploy it, then revoke the old one. In that order, so there
is no window where nothing works.

Rotate on a schedule if the key is in something with staff turnover, and rotate
immediately if anybody who had it has left.

## When a key leaks

Do these in order, and do the first one now.

**Revoke it.** Seconds, from the same page. This is the whole emergency response;
everything after it is cleanup.

**Mint a replacement** and deploy it.

**Then investigate.** Where it was, who had it, how it got out. That
conversation is much calmer once the key is already dead.

The commonest leaks are a key committed to a repository, a key pasted into a
support ticket or a chat, and a key baked into a client-side bundle. The third
is the one to design against: a key in front-end JavaScript is public the moment
it ships, and there is no configuration that makes it not public.

## What a key can do

Everything your account can do through the API, which includes spending credits.

Treat it as a credential of real value, not as a configuration string. Do not
put one in a client-side application, a mobile app binary, a public repository,
or a screenshot.

## Quotas

Keys are subject to rate limits and to your plan's quota. Both are covered in
[Rate limits and quotas](/help/integrations/rate-limits-and-quotas), and both
are worth reading before you build a retry loop rather than after it has run for
an hour.

## Give each integration its own key

One key per system, named for the system.

The value shows up the day something goes wrong. Revoking "Zapier" affects
Zapier; revoking the single key everything shares takes down your whole
integration surface at the moment you least want to be debugging it.

It also makes usage attributable. Two integrations sharing a key produce one
stream of activity that cannot be told apart afterwards.

## Storing it

Whatever you already use for secrets: an environment variable, a secret manager,
your deployment platform's configuration.

Not in the repository, not in a shared document, not in a chat message, and not
in the front-end bundle. The last one bears repeating because it looks safe in
development and is public the moment it ships.
