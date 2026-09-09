---
title: "iOS in-app delist: the App Review case and the exact wording"
type: runbook
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-09-09
tags: [ios, app-review, marketplaces, extension, legal, copy]
summary: How to describe the attended in-app WebKit delist so App Review reads it as a person operating their own account rather than an app accessing Poshmark, with the paste-ready notes, consent copy and rejection reply.
---

# iOS in-app delist: the App Review case and the exact wording

The iOS app can end a Poshmark, Mercari, Vinted or Facebook listing without a
laptop, but only with the seller watching: a `WKWebView` they are already signed
in to, opened by their tap, filling their own form while they look at it. The
mechanism and its hard iOS limits are settled (see [[cross-listing]] and
[[adr-no-server-side-marketplace-automation]]). What is not settled is whether
App Review reads it as a person using a browser or as an app reaching into
Poshmark, and that is decided almost entirely by the words we use.

This note is the wording. Every sentence in it is either quoted from Apple or
true of the build; nothing here is a framing exercise laid over a different
product, because a description that does not match what the reviewer sees on
screen is how one rejection becomes three.

---

## 1. The single guideline that decides this

Everything else is noise. Quoted verbatim, 2026-09-09:

> **5.2.2 Third-Party Sites/Services.** If your app uses, accesses, monetizes
> access to, or displays content from a third-party service, ensure that you are
> specifically permitted to do so under the service's terms of use.
> Authorization must be provided upon request.

Read the second sentence carefully, because it is the trap. If a reviewer
decides 5.2.2 applies, the resolution is documentary evidence of permission from
Poshmark, filed in App Store Connect. We do not have that and cannot get it.
There is no appeal that wins on argument once the question becomes "show us the
authorization"; the only wording that helps is wording that keeps 5.2.2 from
being the frame in the first place. And falsified documentation terminates the
developer account under section 3.2(f), so the option of producing something
does not exist either.

**So the whole case is one distinction: the app does not access Poshmark. The
seller does, in a WebKit view, signed in as themselves, and the app fills a
field on the form they are looking at.** Every piece of copy below exists to
make that the obvious reading.

Three supporting guidelines, all of which we satisfy and one of which actively
helps:

- **2.5.6** requires that apps browsing the web use WebKit. We use `WKWebView`.
  Say so in the notes; it frames the screen as a browser.
- **5.1.1(v)** ends: *"An app may not store credentials or tokens to social
  networks off of the device and may only use such credentials or tokens to
  directly connect to the social network from the app itself while the app is in
  use."* That is written about social networks, but it is a statement of the
  principle we already follow to the letter, and quoting our compliance with it
  tells a reviewer we know where the line is.
- **4.7** covers software not embedded in the binary. It is the reason the fill
  scripts and selectors must ship inside the app and never be fetched from
  `functions.gradethread.com`. See §3.

**4.2 (minimum functionality)** is the other one to keep an eye on, but only if
the delist screen were the app. It is one button inside a native app with
grading, inventory, measurements and money in it, so it is not a repackaged
website. Do not build the feature as a general browser tab.

---

## 2. The precedent, and what it actually tells us

**An app called "Poshmark Bot: PrimeLister" is live on the App Store** under
Utilities, 4+, with no disclaimer of affiliation anywhere in its description. It
advertises Auto Share, Auto Relist and Auto Offer.

Its automation runs **in PrimeLister's cloud, against Poshmark credentials the
seller types into their web form and PrimeLister stores encrypted**. That is
precisely the model this company refuses.

Two conclusions, and they point the same way:

1. **Apple's bar in this category is not the obstacle people assume.** A
   reviewer has already approved an app with the word "Bot" and a marketplace's
   trademark in its own title.
2. **Our design is strictly more conservative than a shipped, approved app.** We
   hold no password, run nothing on a server, and act only while the seller is
   looking at the screen. If PrimeLister clears review, an honest attended
   version is not the harder case.

Do not put point 2 in the review notes. Naming a competitor in a submission
reads as an argument, and reviewers are not adjudicating fairness. Keep it for
an appeal, and even then only as "apps in this category are established on the
App Store," without the name.

---

## 3. What the wording has to be true about

Copy cannot carry this on its own. Each line below is a build constraint, and
each one exists because a sentence in §4 becomes a lie without it.

1. **The seller signs in to the marketplace themselves, inside the web view.**
   The app never has a field for a marketplace password and never types one.
2. **No marketplace credential or cookie leaves the device.** Nothing is synced,
   nothing is sent to our edge. The web view uses a persistent
   `WKWebsiteDataStore` on the device so the session survives, and Settings
   offers a control that clears it.
3. **Every run starts with a tap on that specific job.** No timer, no queue that
   empties itself, no "run all while I do something else." One job, one tap.
4. **The web view is visible the whole time.** Not offscreen, not zero-height,
   not behind a spinner. The seller sees the marketplace's page doing the thing.
   This is also the honest answer to "is it doing what it says."
5. **The fill scripts and selectors ship in the app binary.** Not downloaded,
   not remote-configured. This is the 4.7 line and it is not negotiable; the
   desktop extension's remote `adapters` config must not be reused here.
6. **A login wall or a human check stops and hands over the screen.** The app
   never answers either. The seller is already looking at it, so this is a
   better experience here than on desktop, and it is the
   [[adr-no-server-side-marketplace-automation]] §3.2 line.
7. **The app is not named after a marketplace.** No marketplace word or logo in
   the app name, subtitle, icon or promotional text. Marketplace names appear in
   body copy only, as nominative references, with the existing `/trademarks`
   attribution.

If any of the seven is untrue when the build is submitted, fix the build, not
the sentence.

---

## 4. The wording, ready to paste

### 4.1 App Review notes

Append this to `ios/fastlane/metadata/review_information/notes.txt`. It replaces
nothing except the existing COMMERCE NOTE, whose last line ("All marketplace
selling happens on the seller's connected eBay account via API") stops being
true the day this ships.

```
ENDING A LISTING ON A MARKETPLACE WITHOUT AN API
Some resale marketplaces (Poshmark, Mercari, Vinted, Facebook Marketplace)
publish no seller API. For those, GradeThread does not connect to the
marketplace at all. Instead the app opens the marketplace's own website in a
WKWebView, where the seller signs in as themselves, and helps them complete the
form on the page they are looking at.

How to see it: Sell tab -> "Still listed elsewhere" -> tap an item -> "End it
now". A web view opens on that listing's page. The first time, it asks the
seller to sign in to the marketplace; that sign-in happens on the marketplace's
own page inside the web view and GradeThread never sees or stores those
credentials. The seller then confirms, and the app clicks through the
marketplace's own "end listing" flow while the seller watches.

What the app does not do:
- It does not hold, store, transmit or type a marketplace password. There is no
  field in this app for one. Nothing about the marketplace session leaves the
  device.
- It does not act on a schedule, in the background, or while the app is closed.
  Every run is one tap by the seller on one specific listing, with the web view
  on screen for the whole run.
- It does not answer a CAPTCHA or any other human verification. If the
  marketplace asks, the app stops and hands the seller the screen.
- It does not download or execute remote code. All page scripts are in the app
  binary.

The seller is the account holder operating their own account in a WebKit view,
which is why the marketplace's own site and sign-in are shown rather than
proxied. Sample listings on the demo account are set up so this flow can be run
end to end without touching a live marketplace listing.
```

Keep the ordering. The negatives come after the positive description because a
reviewer who has already read what it is will read the negatives as scoping; a
reviewer who meets them first reads them as defensiveness.

### 4.2 The one-time consent screen, before the first run

This is the seller-facing sheet. It is also the screenshot to attach if review
asks a follow-up question, so it has to say the same things as §4.1 in the
seller's words.

> **End this listing on Poshmark, from your phone**
>
> GradeThread will open Poshmark's website here and end this listing while you
> watch. You stay in control the whole time.
>
> - You sign in to Poshmark yourself, on Poshmark's own page. GradeThread never
>   sees your password and never stores it.
> - Nothing runs unless you tap. There is no background job, and nothing happens
>   while this app is closed.
> - If Poshmark asks you to prove you are a person, GradeThread stops and hands
>   you the screen. It will never answer that for you.
> - Poshmark's terms restrict third-party automation. Plenty of sellers use
>   tools like this one, and Poshmark can still limit an account it decides is
>   automated. Your account, your call.
>
> GradeThread is not affiliated with Poshmark.
>
> [ Not now ]  [ Open Poshmark and end it ]

The fourth bullet is the existing `MECHANISM_DISCLOSURE.extension` copy
(`src/lib/marketplace-disclosure.ts`, mirrored in
`ios/GradeThread/Marketplaces/MarketplacesView.swift`). Reuse the string; do not
write a softer one for the phone. A reviewer who compares the web disclosure to
the app disclosure and finds the app's gentler has learned something about us
that no other sentence can undo.

### 4.3 The running screen

One line above the web view, visible for the whole run:

> GradeThread is filling this in. Tap anywhere to take over.

And when it stops:

> Poshmark is asking you to sign in. Finish it here and tap Continue.
> GradeThread will never answer that for you.

"Take over" matters. It is true, it is a real control, and it is the difference
between a browser with help in it and a bot.

### 4.4 App Store description

One paragraph, in the body, never in the subtitle:

> **Sold on eBay? End the copy on your other marketplaces from your phone.**
> When an item sells, GradeThread tells you which of your other listings are
> still live. For marketplaces with no seller API, it opens their website right
> in the app, where you are signed in as yourself, and walks the listing through
> its own end-listing flow while you watch. Your marketplace passwords stay
> between you and them.

Then, in the description's legal footer where the eBay attribution already sits:

> GradeThread is an independent tool and is not affiliated with, endorsed by, or
> sponsored by any marketplace named here. All trademarks belong to their owners.

### 4.5 Privacy labels

Nothing changes, and that is the point. The web view's cookies are website data
on the device, not data collected by the developer. Do not add a "Browsing
History" or "Contact Info" disclosure for this feature, because we collect
neither, and adding one would assert a data flow that does not exist. Confirm
against `ios/fastlane/metadata/PRIVACY_LABELS.md` before submitting and record
that you checked.

### 4.6 The support article

Publish before submitting, and link it from the consent sheet. A reviewer
following the link should find the same four facts, not a marketing page.
Title: "Ending a listing from your phone." Route it into `PUBLIC_ROUTES` per the
SEO registry rule so it is reachable and indexable.

---

## 5. If it is rejected anyway

**Rejected under 5.2.2.** Do not attach documents and do not argue the
marketplace's terms. Reply asking them to look again at what the app is:

> Thank you. We think 5.2.2 may have been applied on the understanding that
> GradeThread connects to Poshmark. It does not, and we would like to clarify
> what the reviewer saw.
>
> The screen in question is a WKWebView showing Poshmark's own website. The user
> signs in on Poshmark's own page, in that view, as themselves. GradeThread has
> no Poshmark API integration, no server-side connection to Poshmark, and no
> field anywhere in the app for a Poshmark credential. Nothing about that
> session leaves the device, and nothing runs unless the user taps, with the web
> view on screen throughout.
>
> The app is not accessing or displaying a third-party service on its own
> behalf. It is helping a person fill in a form on a website they are signed in
> to, in the same session they would use in Safari. We would be glad to walk a
> reviewer through it on a call, or to provide a video of the full flow.
>
> If the concern is the scripted form fill specifically, we can gate that behind
> an explicit per-run confirmation, or ship the build with the user completing
> the final action by hand. Please let us know which would resolve it.

That last paragraph is the important one. Offer a narrower version before they
have to invent one. A reviewer with an easy "yes, do that" usually takes it.

**Rejected under 4.2.** The delist screen is not reachable except from an item
that has actually sold, which a reviewer may not have been able to reach. Seed
the demo account so it is, and say which tap gets there.

**Rejected under 4.7.** Something in the build is fetching a script. Find it and
move it into the binary. This one is our bug, not their misreading.

---

## 6. Words that lose this

Each of these describes something we do not do, and each one hands a reviewer a
different guideline:

| Do not write | Why | Write instead |
|---|---|---|
| "bot", "automation" as a noun | Names a category with cloud precedents that store passwords | "fills the form", "walks it through" |
| "GradeThread ends your Poshmark listing" | Makes the app the actor, which is 5.2.2 | "you end it, GradeThread fills it in" |
| "automatically", "in the background", "hands-free" | Untrue on iOS and invites 2.5.x | "with one tap, while you watch" |
| "connect your Poshmark account" | Implies a stored credential | "sign in to Poshmark in the app" |
| "sync with Poshmark" | Implies an integration we do not have | "end the listing on Poshmark's site" |
| Poshmark in the app name or subtitle | 5.2.1 metadata | body copy only, with attribution |

The mechanism words we own are already in the codebase and already tested:
`MARKETPLACE_MECHANISM` calls this tier `extension`, and its disclosure says
"Runs in your browser, not on our servers." iOS is the same sentence with a
different browser. Keep it.

---

## Related

- [[adr-no-server-side-marketplace-automation]] the bright line this feature sits inside, and §4's stated cost
- [[cross-listing]] the channel-reach model and which marketplaces have no API
- [[facebook-marketplace-no-api]] the same problem on the channel with the strictest terms
- [[INDEX]]
