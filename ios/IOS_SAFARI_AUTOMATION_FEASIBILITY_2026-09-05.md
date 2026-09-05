# Can the iOS app automate Safari? Feasibility against Apple policy

Written 2026-09-05. Question from the founder: the iOS app sells the same
FlipDesk plans as web, but a phone cannot cross-list to Poshmark, Mercari,
Grailed, Vinted or Facebook Marketplace, because those five have no write API
and GradeThread reaches them from the seller's own browser. Is there an Apple-
compliant way to do that work on the phone, and which way should we pick?

Everything below is read from Apple's published guidelines, Apple's own
developer sessions and forum answers, the App Store listings of competitors,
the marketplaces' terms, and this repo. No Swift was compiled and no build was
submitted. Where a claim needs a human with an iPhone, it says so.

## Verdict

**Apple policy does not forbid this. Apple has approved apps that automate
Poshmark from a phone, including ones that run in the cloud and charge for it
through in-app purchase.** The rule that matters is 5.2.2, which makes the
marketplace's terms of use our problem and lets a reviewer demand written
authorization we do not have. That risk is real, it is the same risk the
desktop extension already carries, and Apple applies it unevenly.

Of the three ways to do the work on a phone, one fits our own rules and Apple's:

| Mechanism | Apple policy | Our ADR (no server-side automation) | Recommendation |
|---|---|---|---|
| A. Safari Web Extension shipped inside the GradeThread app | Allowed under 4.4. Reviewed as part of the app. | Holds unchanged: seller's Safari, seller's session, no cookies permission | **Build this**, after a half-day spike (section 6) |
| B. In-app web view with injected JavaScript, seller logs into the marketplace inside GradeThread | Approved for others, but it is the exact shape of the 5.2.2 rejection on record, and 5.1.1(v) blocks it for Facebook | Technically holds (cookies stay on device) but the seller types a marketplace password into our screen, the disclosure problem the ADR names | **No** |
| C. Cloud-run sessions on our servers | Approved for others (SwiftSeller, PrimeLister) | Refused by `vault/60-decisions/adr-no-server-side-marketplace-automation.md` | **No**, and nothing found here argues for reopening it |

So the answer to "does Apple lead us one way or the other" is: Apple removes
the cloud option's *technical* objection but not our reasons for refusing it,
and Apple makes option B riskier than option A. Option A is the one to do.

## 1. What Apple's rules say, verbatim

Quoted from the App Store Review Guidelines on 2026-09-05.

**5.2.2 Third-Party Sites/Services.** "If your app uses, accesses, monetizes
access to, or displays content from a third-party service, ensure that you are
specifically permitted to do so under the service's terms of use. Authorization
must be provided upon request."

This is the whole legal exposure in one sentence. It does not say automation
is banned. It says the marketplace's terms decide, and that a reviewer may ask
us to prove permission. Every marketplace in scope forbids automation in its
terms (section 4), so we could not produce that proof. Neither can Vendoo,
Crosslist, Closo, SwiftSeller or PrimeLister, all of which are live.

**4.4 Extensions.** "Apps hosting or containing extensions must comply with
... the Safari web extensions documentation ... and should include some
functionality, such as help screens and settings interfaces where possible.
You should clearly and accurately disclose what extensions are made available
in the app's marketing text, and the extensions may not include marketing,
advertising, or in-app purchases."

**4.4.2.** "Safari extensions must run on the current version of Safari on the
relevant Apple operating system. They may not interfere with System or Safari
UI elements and must never include malicious or misleading content or code.
Violating this rule will lead to removal from the Apple Developer Program.
Safari extensions should not claim access to more websites than strictly
necessary to function."

**2.3.1(a).** "Don't include any hidden, dormant, or undocumented features in
your app; your app's functionality should be clear to end users and App
Review. All new features, functionality, and product changes must be described
with specificity in the Notes for Review section."

**2.5.6.** "Apps that browse the web must use the appropriate WebKit framework
and WebKit JavaScript." (A WKWebView or a Safari extension both satisfy this.)

**5.1.1(v).** "... An app may not store credentials or tokens to social networks
off of the device and may only use such credentials or tokens to directly
connect to the social network from the app itself while the app is in use."
Facebook is the named example of a social network. This rule alone rules out
any background or cloud handling of a Facebook Marketplace login from an iOS
app, whatever else we decide.

**4.2.3(i).** "Your app should work on its own without requiring installation
of another app to function." Cross-listing to extension channels needing a
desktop browser is fine under this as long as the app is useful without it,
which it is (eBay, grading, inventory).

**3.1.1.** Subscriptions unlocked in the app must use in-app purchase. Already
true of the FlipDesk plans in `GradeThread.storekit`.

## 2. What Apple has actually approved and rejected

Rules are one thing. The record is another.

**Approved, and still live:**

- **SwiftSeller: Poshmark Bot** (Renegon LLC, App Store id 1568044125, version
  2.1 released 2025-07-04). The listing says: "All automation works in the
  background. No need to keep the app open." The user logs into Poshmark inside
  the app. It sells a $22.99 "background automation" subscription through
  in-app purchase. The word "Bot" is in the App Store title. This is mechanism
  C with mechanism B's login screen, approved.
- **Poshmark Bot: PrimeLister** (ByteBlast Digital LTD, id 6478108527, version
  1.0.30, 2025). "Auto Share, Relist, Offer Tool." Same category.
- **OneShop's Posh Sharing app** for iOS and Android, marketed as "24/7
  hands-free" with "CAPTCHA solving." That last item is something our ADR
  refuses separately (section 3.2 of the ADR), and Apple did not stop it.
- **Vendoo: A Seller's Best Friend** (id 1612168777). Note what its own FAQ
  says: "Your computer must be on and connected to the marketplaces for sale
  detection and auto delist to work in the mobile app," and "some features and
  marketplaces aren't yet available on mobile." Vendoo, with far more money in
  this than we have, relays through the desktop too. That is our US-2481 model.
- **List Perfectly** has no mobile crossposting at all; it is desktop only.

**Rejected:**

- An iOS app that let users set up Facebook Messenger auto-reply bots, built
  on Facebook's own permissioned bot API, was rejected under 5.2.2 with this
  text: "your app facilitates sales for and/or charges users for access to
  Facebook Messenger bots, potentially without authorization from the
  service." Apple offered two exits: attach documentary evidence of
  authorization from Facebook, or remove the feature. The developer asked
  Facebook and got no reply. (Apple Developer Forums thread 733529.)

**What the record shows.** The trigger for a 5.2.2 rejection is a reviewer
connecting three things: a third-party service by name, a paid feature, and
"automation" or "bot" in the description. Poshmark-branded bots get through
because Poshmark does not complain to Apple. Facebook gets caught because Meta
does, and because 5.1.1(v) names social networks specifically. So the same
mechanism can pass or fail depending on which marketplace is on the screen
when the reviewer looks. The practical consequence: **leave Facebook
Marketplace out of any iOS mechanism**, and write the review notes and store
copy so the seller is the actor ("fills the form in your Safari session")
rather than GradeThread ("our bot posts for you").

## 3. The three mechanisms in detail

### A. Safari Web Extension bundled in the GradeThread app

**How it works on iOS (from Apple's WWDC21 session "Meet Safari Web
Extensions on iOS" and the forum answer in thread 720885):**

- "For Safari, Web Extensions are parts of apps. So when you want to install a
  web extension, you install its app." It ships inside the GradeThread binary
  as an app-extension target. `ios/project.yml` already declares two such
  targets (ShareExtension, GradeThreadWidget), so the xcodegen pattern exists.
- The user turns it on in Settings > Safari > Extensions, or from Safari's
  action menu. Safari then asks per site: "Safari will ask the user for
  consent by presenting a dialog which makes it clear which websites the
  extension is trying to access." Options are allow once, allow for one day,
  or always allow. An Apple engineer confirmed permissions "cannot be
  pre-granted by default"; `browser.permissions.request()` can prompt from
  code.
- "Background pages must be non-persistent on iOS." The background script
  loads when there is work and unloads when idle. `browser.alarms` exists but
  only fires while Safari is alive. A native message from the container app
  does not wake a suspended background script (forum thread 790310). **So
  there is no five-minute drain on the phone.** The queue runs when the seller
  opens Safari and taps the extension, or opens the marketplace page.
- `nativeMessaging` lets `background.js` talk to a Swift extension handler,
  which shares an App Group with the main app. That is how the extension gets
  the seller's GradeThread session without any cookie: the app writes a
  short-lived token to the shared container, the handler reads it. This
  replaces `externally_connectable`, which Safari does not support, the same
  way `gt-bridge.js` replaced it for Firefox (US-1882).
- The manifest posture is unchanged from `extension-unified`: no `cookies`
  permission, host permissions limited to the marketplace domains, no
  permission on gradethread.com. 4.4.2's "no more websites than strictly
  necessary" is satisfied by listing only the enabled channels' hosts.

**Why it fits the ADR.** The seller's own Safari, the seller's own login, the
work done on the seller's device. GradeThread's servers hold an instruction (item
id, platform, locale), exactly as in US-2481. Nothing in section 3 of the ADR
moves.

**Why it fits Apple.** 4.4 wants an extension with help and settings screens:
the container app already has both. 2.3.1 wants it described in review notes:
draft in section 7. 5.2.2 exposure is identical to the desktop extension's,
and the framing ("fills the listing form in a tab you are logged into, then
reports the URL back") is the same one Vendoo and Crosslist ship under.

**The costs, honestly:**

1. **Mobile pages are different pages.** Poshmark, Mercari, Grailed and Vinted
   serve a different sell form to a phone user agent, and on some of them the
   mobile web sell flow may redirect to the native app. `lister/selectors.js`
   is verified against desktop DOMs only. "Request Desktop Website" is a
   per-site setting the seller flips under the aA menu; an extension cannot
   force it. So it is one of: a second selector set per channel (doubling the
   monthly breakage the README already warns about), or an onboarding step
   that has the seller set desktop mode once per marketplace, or both. This is
   the single biggest unknown and it is checkable in an afternoon (section 6).
2. **Photos.** The content script attaches images to a file input from
   downloaded blobs. WebKit on iOS supports assigning a `DataTransfer.files`
   list to an input, but it has not been tried on these five forms from a
   phone. Needs the same afternoon.
3. **No background drain.** The mobile UI keeps saying "runs when you open
   Safari with the extension on." The honesty rule from `ExtensionQueueService`
   still applies, with a shorter loop.
4. **A third build target to keep in parity.** `extension-unified` already
   abstracts `chrome.*` versus `browser.*` and has a test that pins the
   background dependency list; the Safari packaging step joins
   `scripts/package-extensions.mjs`. `test/legacy-parity.test.cjs` shows what
   happens when a second copy drifts, so the Safari copy must be a build
   output of the unified source, never a fork.
5. **Review is per app version.** Every selector fix that ships inside the
   app waits on App Review. Desktop fixes ship the same day. Expect a lag of
   one to three days on iOS for a broken form, and say so in the popup.

**Effort.** Weeks, not days: extension target and handler, token hand-off,
Safari packaging, mobile selector verification per channel, App Review round.
The spike in section 6 comes first and can kill it cheaply.

### B. In-app WKWebView with injected JavaScript

The seller logs into Poshmark inside a GradeThread screen; a `WKUserScript`
runs the same fill code; the session lives in the app's website data store.

**Why it is tempting.** No Safari extension target, no per-site consent
prompts, no App Group hand-off, and the app controls the user agent so it can
request the desktop DOM and reuse today's selectors unchanged. It is the
fastest path to a demo.

**Why not:**

- It is the exact shape of the rejection on record: a paid feature, a named
  third-party service, a login screen for that service inside our app. The
  Facebook-bot developer had an API permission from Facebook and was still
  told to produce "documentary evidence." We would have less.
- 5.1.1(v) forbids using social network credentials except "while the app is
  in use" and forbids storing them off device. That kills Facebook here
  outright and puts any "keep going after you lock the phone" feature in
  breach.
- The seller types a marketplace password into a GradeThread screen. The ADR's
  section 3.1 gives the reason this matters: our trust position is that we
  say what we do, and "log into Poshmark inside GradeThread" is a sentence
  that needs a paragraph of reassurance after it. Section 5 of the ADR relies
  on the extension being structurally unable to see a cookie; a web view we
  own can.
- We inherit login, two-factor, CAPTCHA and bot-detection handling for five
  marketplaces inside our own app, on a WebKit user agent the marketplaces can
  fingerprint. The desktop model leaves all of that to the seller's real
  browser.

### C. Cloud-run sessions

Apple allows it; SwiftSeller and PrimeLister prove that. This changes nothing
in the ADR, which was written knowing Nifty does the same. The reasons stand:
GradeThread becomes the actor under every marketplace's terms, one breach
becomes every seller's breach, and it cannot be disclosed honestly. Apple's
approval of a competitor is not authorization under 5.2.2, and if Apple ever
asks, the cloud model has the weakest answer of the three.

### D. Things that do not apply

Shortcuts and App Intents cannot drive a page's DOM. `SFSafariViewController`
and `ASWebAuthenticationSession` do not allow script injection. Universal
clipboard tricks are not a mechanism.

## 4. The marketplaces' own terms

Every channel in scope forbids what the extension does, on desktop or on a
phone. This is the exposure 5.2.2 points at, and it is unchanged by which
device the seller uses.

| Marketplace | Wording |
|---|---|
| Poshmark | Section 4.b: users may not "copy, scrape, harvest, crawl or use any technology, software or automated systems to collect any information or data for the Service." Enforcement in practice targets share volume ("share jail"), not listing tools. |
| Mercari | Prohibits "any robot, spambot, spider, crawler, scraper or other automated means or interface not provided by us to access the Service or to extract data." |
| Grailed | Prohibits "any robot, spider, scraper, crawler, data mining tools ... artificial intelligence or machine learning systems (including large language models), or other automated means" and any "system that submits offers, makes purchases, or completes checkout without direct human initiation and review of each transaction." The most explicit of the five. |
| Vinted | Members must not use external software tools, including bots, unless Vinted authorizes it. Vinted has blocked accounts for automation in 2026. |
| Facebook Marketplace | Meta Terms: may not "access or collect data from our Products using automated means (without our prior permission)." Meta's Automated Data Collection Terms require "express written permission." Meta is also the one marketplace known to push Apple to enforce 5.2.2. |

The disclosure copy from US-2475 (`src/lib/marketplace-disclosure.ts`) already
states this per channel on web. Any iOS mechanism reuses it word for word.

## 5. Decision

1. **Do not build B or C.** Both are recorded above with reasons, so the next
   person under deadline pressure argues against the reasons, not the gap.
2. **A is feasible and is the only mechanism consistent with both Apple and
   the ADR.** It stays behind the paid FlipDesk gate the desktop extension
   already uses (`registry.js` `sellerEnabled`), keeps the same clickwrap, and
   ships without Facebook Marketplace.
3. **The desktop relay comes first regardless.** A Safari extension drains the
   same queue; US-2718 (an env var on Coolify) and US-2727 (a held migration)
   block it in production today. Closing those gives iOS sellers working
   cross-listing before any Swift is written.
4. **Until then the iOS paywall and the push-to sheet say what is true:**
   extension channels run from a desktop browser. The `Tier.label` text
   "Browser extension" in `CrossListingRegistry.swift` is accurate but
   incomplete on a phone; the plan comparison should carry the desktop note.

## 6. The spike that decides it (half a day, needs an iPhone)

Do this before filing the build story. The existing popup has a **Check
selectors** button (US-2484) that prints a report against the live DOM; the
same report can be produced from the iPhone by loading `extension-unified` as
a development Safari extension through Xcode.

For each of Poshmark, Mercari, Grailed and Vinted, logged in, on the sell
page:

1. Does the mobile web sell form load at all, or redirect to the native app?
2. With "Request Desktop Website" on for that site, does the desktop form load,
   and does the current `required` selector list resolve?
3. Does a fetched image attach to the photo input from script?
4. Does the seller's existing native-app login carry into Safari, or is a
   second login needed? (It is a second login; confirm, because onboarding
   copy depends on it.)

Record the answers in this file's next revision. If (2) passes on three of
four channels, file the story. If (1) redirects and (2) fails on most, the
honest iOS answer stays "queue it for your desktop" and this document is the
record of why.

## 7. What to tell App Review (draft for Notes for Review)

> GradeThread includes a Safari web extension for sellers on a paid FlipDesk
> plan. When the seller has drafted a listing in GradeThread and opens a
> supported marketplace's sell page in Safari while logged into their own
> account, the extension fills the listing form with the seller's own draft
> (title, description, price, photos) and, after the seller reviews and
> submits it, records the listing URL back in GradeThread. The extension
> requests access only to the marketplace domains listed in its manifest, has
> no cookies permission, never reads or stores marketplace credentials, and
> never submits a form without the seller present. Demo account: [from
> `REVIEW_DEMO_*`]. To test: sign in, open Sell > Listing Kit > any draft >
> Push to > Poshmark, then open poshmark.com/create-listing in Safari and
> enable the GradeThread extension when prompted.

Keep the words "bot" and "automation" out of the store listing and the review
notes. Describe the seller's action, not ours.

## Sources

- Apple, App Store Review Guidelines: https://developer.apple.com/app-store/review/guidelines/
- Apple, WWDC21 "Meet Safari Web Extensions on iOS": https://developer.apple.com/videos/play/wwdc2021/10104/
- Apple Developer Forums, per-site permission prompt and `permissions.request()`: https://developer.apple.com/forums/thread/720885
- Apple Developer Forums, native messaging does not wake a suspended background page: https://developer.apple.com/forums/thread/790310
- Apple Developer Forums, 5.2.2 rejection of a Facebook Messenger bot app: https://developer.apple.com/forums/thread/733529
- SwiftSeller: Poshmark Bot, App Store: https://apps.apple.com/us/app/swiftseller-poshmark-bot/id1568044125
- Poshmark Bot: PrimeLister, App Store: https://apps.apple.com/us/app/poshmark-bot-primelister/id6478108527
- Vendoo mobile app page and FAQ: https://www.vendoo.co/mobile-app
- Vendoo, "some features and marketplaces aren't yet available on mobile": https://www.vendoo.co/everything-you-need-to-know-about-vendoo-for-online-sellers
- List Perfectly has no mobile crossposting: https://nifty.ai/post/list-perfectly-alternatives
- OneShop Posh Sharing app description: https://resellgenius.com/genius-portal/oneshop-this-poshmark-bot-automation-app-wont-get-you-banned/
- Poshmark Terms of Service: https://poshmark.com/terms
- Mercari Prohibited Conduct: https://www.mercari.com/us/help_center/topics/account/policies/prohibited-conduct/
- Grailed Terms of Service: https://www.grailed.com/about/terms
- Vinted terms and automation enforcement: https://www.redrip.app/en/blog/vinted-automation-restriction-2026/
- Meta Terms of Service: https://www.facebook.com/terms and https://www.facebook.com/legal/automated_data_collection_terms
- In this repo: `vault/60-decisions/adr-no-server-side-marketplace-automation.md`, `vault/30-platform/closing-a-coverage-gap.md`, `extension-unified/README.md`, `ios/GradeThread/Marketplaces/ExtensionQueueService.swift`, `ios/GradeThread/Marketplaces/CrossListingRegistry.swift`, `ios/IOS_RESELLER_UX_DEEP_DIVE_2026-09-03.md` section 3.3.
