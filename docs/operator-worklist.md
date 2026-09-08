# What the backlog is waiting on you for

Regenerate with: node scripts/operator-worklist.mjs. Built from prd.json, where 154 of 251 open stories carry at least one OPERATOR criterion — a step only you can take.

This is not a list of blocked work. Most of these stories have buildable criteria before the operator step, and several were finished this session right up to it. It is a list of the last mile.

## Where the work happens

Most of these are not separate sittings. Grouped by what you need open:

- **Somewhere else (read the step)** — 56 steps
- **Coolify, or a deploy + env change** — 30 steps
- **Production database (psql or the Supabase SQL editor)** — 26 steps
- **A marketplace account, logged in** — 21 steps
- **A lawyer** — 11 steps
- **A grading run that costs real money** — 8 steps
- **A decision, with nothing to open** — 4 steps
- **Sentry or PostHog** — 3 steps
- **Email or SES** — 3 steps
- **A phone, in your hands** — 3 steps
- **App Store Connect** — 2 steps
- **eBay developer or seller account** — 2 steps
- **Cloudflare dashboard** — 2 steps

---

## Somewhere else (read the step)

### US-3042 — eBay Application Growth Check: close the compliance gaps before applying

priority 1

run the call counter for two weeks and read ebay_api_call_daily before submitting the growth check. Do not submit on an estimated number.

### US-3110 — Cut eBay API call volume before the Application Growth Check

priority 1

after 48 hours, re-read ebay_api_call_daily and confirm total daily calls and the Trading peak have both dropped; do not submit the growth check on the pre-fix numbers.

### US-3112 — eBay compliance: extension attribution, and stop calling APIs we cannot use

priority 1

read the next ebay-notification-reconcile run's log line and file the real cause of its 12 per-topic errors.

### US-2736 — Every platform variant is priced from the eBay draft alone, so an item priced on the item generates a kit with no price at all

priority 8

the fix only affects newly generated variants. Existing drafts carry the stored 0 - press Regenerate on the Listing Kit to pick up the price.

### US-3146 — Every Claude call outside grading runs at the default effort high, because 39 of 45 call sites send no output_config at all

priority 9

after the edge deploy, run scripts/ai-token-profile.ts over a window starting at the deploy day and compare median out/call for tag_ocr (BEFORE 204), measure_extract (138), photo_roles (167) and reconcile (631) against the US-3145 baseline. size_estimate and photo_qa are expected to be UNCHANGED - they run on Haiku, where effortParams is a no-op by design.

### US-3149 — Content generation can never hit the prompt cache, because the volatile history block sits in the middle of an uncached system string

priority 9

after the edge deploy, generate 3+ articles inside one 5-minute window, then run scripts/ai-token-profile.ts from the deploy day. The 'content' row must show hit% above zero and a lower median in/call than the 5,488 baseline. Social stays at 0% by design (1,908 tok prefix against Haiku's 2,048 minimum) and is not a failure.

### US-3086 — Lululemon size-dot rim: decode a transcription that starts mid-circle, and re-run the backfill on undecoded codes

priority 11

run the backfill with --redo-undecoded --dry-run, confirm the five items above decode, then --apply, and paste the summary into this story's note.

### US-3147 — The writing and extraction calls also run at default effort high, and those are the ones where lowering it could actually be felt

priority 11

after the edge deploy, run scripts/ai-token-profile.ts from the deploy day and compare median out/call against the US-3145 baselines (content 4504, autolister 781, catalog_extract 461). Then run a 20-item AutoLister batch and compare item-specifics fill against US-3044 - a coverage drop is the failure a cost table cannot show.

### US-3148 — The agent kernel re-bills its system prompt and every tool schema on all 24 steps, because nothing on that call is cached

priority 11

after the edge deploy, trigger one agent run of 8+ steps and read cacheHitShare for its agent:* phase in scripts/ai-token-profile.ts. BEFORE: every agent:* phase 0%, ~2,300 median input tokens across 443 calls. A zero AFTER is checked against the per-model minimum (all 15 charters measured 1,064-2,145 tokens against Sonnet's 1,024) before the placement is blamed.

### US-3108 — Universal Links are dead in production: the live AASA file does not list the iOS app ID

priority 12

confirm the current failure first — ios/Scripts/check-aasa.sh reports 'AASA does not list appID RV6W9F4Y4P.com.gradethread.app' against https://gradethread.com/.well-known/apple-app-site-association as of 2026-09-03, while ios/GradeThread/GradeThread.entitlements declares applinks:gradethread.com; record the file's current contents in the story notes before changing it

### US-3108 — Universal Links are dead in production: the live AASA file does not list the iOS app ID

priority 12

after the file is live, tap a real password-reset link from Mail on a device with the app installed and confirm it opens the app rather than Safari; record the date and the device in the notes

### US-3184 — An operator script spent 169 prod AI calls on a previous-generation model, because the local .env still pins the 2026-07 default

priority 12

set system_settings.grading_model_cascade.escalationModel to claude-sonnet-5. It is dormant today (enabled:false) but sits on the grading allowlist, so enabling the cascade would route escalations to a previous-generation model.

### US-3061 — Worker tab: a pinned GradeThread tab that drains the cross-listing queue all day, and the same drain on Firefox for Android

priority 13

on a Chrome desktop and on Firefox for Android 142+, queue one list and one delist from the phone app, open the worker tab, and confirm both complete without a click; record which platforms passed on mobile in this story's notes

### US-3065 — MCP tool to queue extension work: 'list my new items on Poshmark' from Claude, drained by the seller's own browser

priority 17

from Claude Desktop with the connector attached, queue one list job for a test item, confirm the MRTR prompt appears, then open the extension and confirm the row drains; paste the tool call ids from the audit log into the notes

### US-3058 — Extension revision: verify the redesigned overlay on live marketplace pages and ship 1.1.0 to the stores (operator)

priority 19

run node scripts/package-extensions.mjs, upload the 1.1.0 Chrome and Firefox zips, and paste the SUBMISSION.md description and release notes; the store screenshots are regenerated from the redesigned surfaces.

### US-3067 — Flip mode on sourcing sites: should I buy this, on ShopGoodwill and GoodwillFinds

priority 19

open one live ShopGoodwill auction and one GoodwillFinds product, run flip mode, confirm the gallery, title and current bid resolve and set lastVerified on both adapters

### US-2703 — EPIC: grade as dispute evidence — turn the grade report into an eBay INAD defense

priority 20

drive one real eBay INAD return end to end and confirm AC6. All four children (US-2704..US-2707) pass; this is the only thing left and no child carries it. On the next INAD return for an item graded and published through FlipDesk, open it on the post-sale page, press Evidence, paste the buyer's words, READ THE VERDICT BEFORE SENDING, and confirm a drafted response and an attachable pack come out with no manual file assembly. If the verdict says the report agrees with the buyer and refuses to assemble, that is AC5 working and the story still closes. Why it cannot be done here: the Post-Order file contract (UploadFileRequest then SubmitFileRequest, activation by filePurpose) was verified from eBay's reference and never exercised, and there is no sandbox INAD case to drive. Closing on the children alone would assert an end-to-end result nobody has seen.

### US-3068 — Return shield: the grade evidence pack on the eBay return page itself

priority 20

on a real eBay return for an item graded and published through FlipDesk (the same case the US-2703 epic is waiting on), open Seller Hub with the extension and confirm the pack renders; note the outcome on both stories

### US-3069 — In-browser background removal: no photo leaves the seller's machine, and no per-image API bill

priority 21

on the reference laptop without a discrete GPU, time the first and second removal for a 12-megapixel photo and record both in the notes; if the second exceeds 4 seconds, the default stays server-side and the local path becomes opt-in

### US-3071 — Turn on revise and relist on every extension channel, and verify Vinted delist

priority 23

run one revise and one relist on each of the four platforms from a test account after the store build is live and record the outcome per platform in the notes; a platform that fails goes back to enabled:false in the same session, not later

### US-2328 — Add Shopify fulfillment: tracking numbers never reach Shopify

priority 45

exercise the fulfillment call against a Shopify sandbox store (AC3). AC1 and AC2 are written; nothing here can be proven without sandbox credentials.

### US-2812 — iOS and Android ask a hat for its inseam: the native measurement catalogs never matched the web

priority 57

AC6 is a device check and it is the only thing left. AC1-AC5 are done and guarded — src/test/native-measurement-catalog-parity.test.ts now holds both native catalogs to the web templates key for key, label for label and unit for unit. What no test here can do is look at the screen: open a hat, a bag and a belt on a real iPhone and a real Android and confirm the fields offered are the ones the web asks for. Android is checkable from this box and iOS is not, so a passing Android build is evidence about the shared table, not about what iOS renders.

### US-2810 — Shadow the footwear category criteria, so the golden set can exist

priority 58

choose a daily spend ceiling and set PER_IMAGE_SHADOW_DAILY_VISION_CAP to it. Unset is 0 and 0 is off, so this is the switch that makes everything below actually run.

### US-2830 — The consumer grade flow quotes a price and has no way to pay it, on both phones

priority 60

AC1 is the only real decision and it is small - does the consumer flow re-charge to detect the grant, or ask for a balance? Everything else follows from it. Worth knowing before you answer: nobody can currently spend money at this screen, so whatever the consumer conversion rate looks like today, it was measured with the buy button missing.

### US-2831 — Live Capture earns one badge for three different strengths of evidence

priority 70

AC1 is the decision and it is a product one, not a technical one. The honest summary: today a photo taken in the GradeThread browser tab and a photo taken in the iPhone app earn the same badge, and the iPhone one could prove more than it currently claims. Deciding nothing is fine and leaves a working, honestly-earned tier in place; deciding to split it is a promise every future client has to keep.

### US-2457 — Buyer audit rows are indistinguishable from seller ones, so the reconciler reads a buyer cancellation as a seller cancellation

priority 1200

start Docker Desktop, which is the single blocker on AC4 and takes seconds. Confirmed down again 2026-08-16 (docker info cannot open the named pipe), so npm run verify:db and verify:security are SKIPPED on every run - the throwaway-Postgres lane that proves a migration applies to a fresh schema is not running at all. AC4 needs a migration that ALTERS A UNIQUE INDEX on an operator-facing table, and shipping an index change that no Postgres has ever executed is the one thing that lane exists to prevent. With Docker up this is a single focused session rather than a blocked one.

### US-1689 — YouTube grading shorts + on-page embeds

priority 1689

making and publishing YouTube shorts is human work - filming, editing, uploading, writing descriptions. The on-page embed half is code and small; nothing can start until videos exist. Declared because a marketing task with no operator marker reads, to anyone scanning the backlog, exactly like an unstarted engineering ticket.

### US-1691 — State of Secondhand Condition data report + PR/podcast push

priority 1691

writing the State of Secondhand Condition report and running the PR/podcast push is human work end to end. One asset feeding two channels (AI citations and links). Same reason for declaring it as US-1689: nothing here is waiting on an engineer.

### US-1753 — EPIC: GradeThread browser extension — AI condition second-opinion at point of purchase

priority 1753

AC2 is store submission and cannot be done from a repo. Shipping on the Chrome Web Store and Firefox AMO is US-1757's job (open, and already declared as operator work), and this epic cannot close before it. AC1's surface exists as extension-unified/, whose remaining work is tracked on US-1872 and its children rather than here. This criterion exists so the epic stops reading as buildable.

### US-2504 — Walk-around video grading is web-only, on the platform without the camera

priority 1802

needs a macOS toolchain. AC2's actual recorder (the AVCapture walk-around mode) and AC4's upload progress are both Swift, and neither can be built or verified from the Windows checkout - the iOS CI lane on macOS runners is the compile gate. AC4 is worth doing rather than deferring: a 60MB upload with no feedback is indistinguishable from a hang, which is the failure a seller reports as 'the app froze'. The edge half is done and verified here (deno check on the route and the isolation suite, deno lint clean, 6 iOS source guards green, full web lane 14/14).

### US-1872 — EPIC: Unified GradeThread extension — one install, role- and subscription-aware (buyer research for everyone, seller tools on top)

priority 1872

the remaining work is carried by three children that already declare their own operator step, plus AC5 which waits on them. US-1880 (verify the five unverified adapters), US-1881 (Firefox and Edge), US-1882 (the postMessage transport) are the open ones; US-1873, US-1883, US-1884 and US-1885 pass. AC5's removal of the legacy extension/ and extension-condition/ folders is explicitly conditioned on the unified extension REACHING PARITY, which those three children are what parity means — so it cannot be done first. This criterion exists so the epic appears in `npm run prd:operator` instead of reading as buildable.

### US-1881 — Cross-browser: Firefox + Edge support for the unified extension

priority 1881

AC3 (Firefox end to end) and AC5 (Edge smoke) need a real browser and a person. The code is written; what cannot be done from here is installing the add-on and driving it. Note the Firefox floor was a RECURRENCE rather than a one-off - the packager's own comment already listed a dropped strict_min_version among three drift breakages, and it came back by absence rather than overwrite.

### US-1949 — FlipDesk is described but never shown publicly; contradictory 'Join waitlist' CTA signals vaporware

priority 1949

capture real FlipDesk and AutoLister screenshots with the product open, and decide what seller data is safe to show in them. This is AC1 and it is the only criterion still open - AC2 is satisfied, and the homepage and /for-resellers already show real surfaces. Nothing here can take a screenshot of a signed-in product or make the judgement about which order numbers, buyer names and prices may appear publicly.

### US-2415 — Prod Postgres + storage host has no full-disk encryption — a pulled or reclaimed VPS disk is readable plaintext

priority 1970

full-disk encryption is a host action on the Contabo box and nothing in this repository can perform or verify it. Enable it, then fill in the key's storage LOCATION (never its value) in vault/10-ops/key-rotation.md — AC2 was deliberately left undone because there is no key to list until you create one, and a placeholder row in a key inventory is how a key inventory stops being trusted.

### US-2003 — Every alert channel is optional and silently no-ops — nothing proves anyone gets paged

priority 1979

run the delivery drill (AC1). /health/ready already reports features.alerting = ok, so at least one channel is CONFIGURED - what is unproven is whether a message ARRIVES. A configured webhook pointing at a dead endpoint reports ok here forever, so configuration is not the question. Fire a test alert and confirm it reaches a human.

### US-1980 — eBay Media API: video upload for listings

priority 1980

two facts need a human with a browser on eBay's docs, and nothing is built yet. Max video duration (believed 1 minute) and videos-per-listing (believed 1) remain unconfirmed from a primary source. Confirmed already: max file size 150 MB / 157,286,400 bytes, classification should be ITEM, eBay accepts .mp4 H.264/AVC only, and playlists are generated only once a video reaches LIVE - so a poll that stops before LIVE has no playable URL to attach. ⚠ DO NOT SPEND MORE AGENT ATTEMPTS ON THE DOCS. Five fetches failed across two sessions on four distinct URLs plus the edp.ebay.com mirror, each exceeding 60s. That is a recorded conclusion, not a run of bad luck: every eBay doc fact in this repo now comes from search summaries, the generated SDKs or the community forum until someone opens a page by hand. The two open decisions are also yours and they gate the build: AC2, whether the client transcodes HEVC before upload or the server does (iPhones record HEVC by default and eBay takes H.264 only), and AC3, whether publish waits for LIVE or proceeds without the video and attaches it later.

### US-2219 — Authenticity tell coverage follows brand-pack order, not counterfeit prevalence

priority 1980

AC1 needs SOURCED counterfeit-exposure figures from outside this repo, and AC2 is the seeding that follows. Half of AC1 is already available - submission volume is in our own database and scripts/brand-style-coverage.mjs --db shows the query shape - but the exposure half needs external sources, and a ranking assembled from recollection is the exact failure this corpus documents as its worst (the RN 17257 / Longchamp trap: a real record, the right brand string, completely the wrong company). WHERE THE CORPUS ITSELF POINTS, needing no external source: the packs headers repeatedly note Nike, adidas, Supreme, BAPE, Moncler, Canada Goose, The North Face and Patagonia as heavily counterfeited, and every one sits in a pack whose tells were written in the legacy shape. THE MEASUREMENT THAT MATTERS MORE THAN THE RANKING, already done: all 179 seeded tell payloads use the legacy {tell, detail} shape and ZERO use the structured one, so they are prose the prompt reads and the verdict cannot use.

### US-2216 — brand_styles covers a fraction of the KB's brands — model-level identity is what sets price and it is mostly missing

priority 1983

AC2, AC3 and AC4 are SOURCING work - model-level identity for the brands the KB already covers. AC1 is done and the premise was corrected in the notes; what remains is data nobody in this repo can author.

### US-2215 — No international size-system conversion, and no plus / petite / tall / big-and-tall charts as first-class

priority 1984

this is a SOURCING project, not a coding one. The corpus holds exactly one extended chart (Talbots), so plus, petite, tall and big-and-tall are representable and unpopulated - someone has to find and enter the charts. The reading half shipped: a converted size now reaches the certificate line, so a chart added tomorrow is read rather than merely stored.

### US-2131 — Build the authenticity golden set — the gate is worthless without ground truth

priority 1990

the authenticity golden set needs LABELS, and labelling is the story. The gate is worthless without ground truth, and ground truth here means a person deciding genuine or not on real items. Nothing in this repo can produce it, and US-2134's AC5 (narrowing the prompt) is gated on it.

### US-2209 — EPIC: Grading depth — identity, sizing, brand knowledge and product coverage

priority 1990

umbrella only, and every open child already declares its own operator step, so there is nothing here to pick up. Three of the six ids this epic names are still open and all three are declared. This criterion exists so the epic appears in `npm run prd:operator` rather than in the actionable list, which is where it had been sitting while none of it could be started.

### US-2791 — US-826 closed with AC1 unmet: the attribute confirm chips exist and no screen presents them

priority 1990

needs a macOS toolchain to compile and a device or simulator to judge. This is a screen, and a screen written blind is where an agent ships something that compiles and looks wrong. The iOS CI lane is the compile gate, not the design gate.

### US-2118 — In-place plan upgrade charges a prorated amount on a single click with no confirmation

priority 1991

run one real paid-to-higher upgrade against Stripe TEST MODE, on both products, and confirm the prorated figure the dialog discloses is the figure Stripe actually charges. Everything else is built and guarded on both FlipDesk and buyer: the 409 gate sits before the mutation, the preview endpoint simulates the item swap, the consent artifact is written, and seven sabotage mutations plus a control each reddened their own test. WHY THIS CANNOT BE WAVED THROUGH: a dialog stating a WRONG prorated amount is worse than today's no-dialog state, because it converts an omission into an affirmative misstatement about a charge. The structural tests prove the gate is wired; they cannot prove the arithmetic. Also confirm the webhook writes an agreement row for an in-place change (AC2 - US-2117 landed the plumbing).

### US-2119 — No advance renewal reminder exists anywhere — annual plans are charged silently

priority 1991

two Stripe-side steps, and neither is code. (a) AC2 - set the renewal-reminder lead time explicitly in the Stripe Dashboard under Settings -> Billing -> Upcoming renewal reminders, with a LONGER lead for annual than monthly. The 3-day default is thin notice for a full year of charge and is the reason this story exists. (b) AC5 live half - confirm a real annual subscription actually produces the reminder before renewal, which needs a Stripe run and cannot be asserted from a checkout. Everything else shipped: invoice.upcoming and customer.subscription.trial_will_end are handled, the notice goes out as TRANSACTIONAL so a marketing opt-out cannot suppress it, and there is a test for that.

### US-2125 — Two divergent cancellation paths — the stale portal route bypasses the reviewed flow

priority 1992

in the Stripe Dashboard, check whether 'Cancel subscription' is enabled on the ACCOUNT DEFAULT customer portal configuration, and report on/off. billingPortal.sessions.create is called with no `configuration`, so the account default is what applies, and this checkout cannot observe it. If it is on - Stripe enables it by default in most setups - the portal is a second cancellation path reachable from the seller billing page, the plan picker and the buyer page, bypassing the reviewed dialog entirely: no period-end statement, no acknowledgement checkbox, no reason capture, no undo banner. That is the bigger half of AC2 and it cannot be closed from code.

### US-2137 — Guided macro capture — framing, distance and lighting for authenticity shots

priority 1992

everything that can be done from a Windows checkout is done, and all three remaining pieces need a person. AC1's framing OVERLAY is visual work that needs a Mac to see and run — the copy half now ships to every client through GET /api/flipdesk/photo-profiles as `macroGuidance`, so only the overlay is left. AC2's camera selection is built (commit cc339f649) but has never been COMPILED; iOS CI is the gate. AC3 is design work: worked good-versus-unusable example shots for each slot type, which someone has to photograph. AC4 measures a rollout, so it needs the rollout first.

### US-2139 — Per-brand tell depth is 3 brands and 7 tells, all unverified

priority 1992

per-brand authentication tells need a human with the brand knowledge to verify them. The story states it is explicitly not agent work, and the current depth is 3 brands and 7 tells, all unverified - publishing unverified tells as authentication guidance is the risk this story exists to avoid, so an agent filling them in would be the failure mode rather than the fix.

### US-2143 — Surface authenticity as a buyer-facing selling point once the evidence supports it

priority 1992

this story's own AC4 already says it is BLOCKED, and the blocker is a judgement rather than a task. The gate is 'the evidence base supports the claim', which someone has to decide — the epic's audit put the evidence base at roughly 5% against scaffolding that is roughly 80% built, and selling authenticity ahead of the evidence is the FTC Section 5 exposure the rest of the batch exists to fix. It carries no dependsOn because the blocker is a THRESHOLD, not a story id, which is exactly why it kept reading as buildable. Nothing here needs a page written; it needs someone to say the evidence is defensible.

### US-2499 — iOS ships English-only while Android ships Spanish, and the localization guard reads as though a migration is under way

priority 1993

answer one product question - is a non-English-speaking seller a customer on iOS? Android already answers yes: it ships values-es plus a CI lane that fails the build on MissingTranslation, so a new English string cannot land without its Spanish counterpart. iOS answers no by omission, which is what makes this a DECISION rather than a cleanup - nobody chose English-only, it is just what happened. The cost of each answer differs sharply and is worth knowing before choosing: yes means localising the whole iOS string catalogue and adding the same CI gate, which is real ongoing work on every string thereafter; no means saying so on purpose, and it is a defensible answer for a US-first product. What is not defensible is the current state, where the two clients disagree and neither says why. AC4 was always independent of this and is unaffected.

### US-2103 — Organization.sameAs is effectively empty — no brand profiles to resolve against

priority 1996

AC1, AC2 and AC3 are business actions - the brand profiles do not exist yet. The code half (AC4, AC5) is done and is deliberately correct in emitting NOTHING rather than placeholder sameAs entries, so there is no code change waiting on you, only the profiles.

### US-2109 — No product/pricing/UI A/B testing — PostHog flags are never read client-side

priority 1998

pick and run one real experiment (AC3, deliberately left open). AC1, AC2 and AC4 shipped the flag-reading and assignment plumbing; what is missing is a decision about what to test, which is a product call rather than a code one.

### US-2231 — MeasureCard is a brochure with no path into the actual measure flow

priority unranked

same class as US-1949 AC1 - a human with the product open, not a code change. MeasureCard needs someone to walk the real measure flow and decide what the path into it should be from the marketing surface.

### US-2280 — Outcome-grounded grading truth: regress realized FlipDesk outcomes against assigned grades

priority unranked

look at the numbers before anyone builds a surface for them, then answer AC3 - WHICH surface. The regression itself runs; what has not happened is a human reading the output and deciding what matters. A panel built first would be guessing at which columns earn their place, and this one carries a constraint the others do not: it must NOT share a surface with the public data reports. Realized-outcome data about individual sellers' grades is an internal calibration tool, and putting it beside a public-facing report is how it ends up quoted as a published statistic. So the order is: read the output, decide what the panel is for and who sees it, then build.

### US-2395 — Variation listings cannot be revised: resubmit needs an offer id a group listing never has

priority unranked

this story's AC7 is the only thing still open and it cannot be done from a checkout — after the next edge deploy, open a real multi-variation eBay listing, change ONLY the price, and Save and resubmit. That is the case the second pass introduced and then fixed (a price-only revise used to fall through to the offer path with an empty offer id), so it is the one worth exercising by hand.

### US-2447 — The edge hang watchdog did not cap the outage at ~60s, and nothing in the repo can tell whether it is still installed

priority unranked

an edge hang is uncapped today - /health/ready reports hostWatchdog unconfigured. Install scripts/ops/edge-watchdog.sh on the host with FLIPDESK_INTERNAL_JOB_SECRET, put it on cron, and confirm the readiness line flips to ok (AC1, AC2).

### US-3082 — eBay Partner Network: affiliate attribution on every outbound eBay link from Scout, Prospect and trigger alerts

priority unranked

read the EPN rate card and program terms at approval time and record in the same vault note the apparel commission rate, the per-item cap, and the click-to-purchase attribution window, dated, so the margin math is checkable and re-checkable

## Coolify, or a deploy + env change

### US-3042 — eBay Application Growth Check: close the compliance gaps before applying

priority 1

apply migration 00711 to prod, NOTIFY pgrst, redeploy the edge, then schedule the two new Coolify crons (/api/jobs/ebay-rate-limits hourly, /api/jobs/ebay-retention daily).

### US-3110 — Cut eBay API call volume before the Application Growth Check

priority 1

apply 00724 to prod, NOTIFY pgrst, then redeploy the edge (columns and RPC are read by name; the edge must not go first).

### US-3110 — Cut eBay API call volume before the Application Growth Check

priority 1

read the next ebay-notification-reconcile failure from the container log now that it names itself, and file the real defect.

### US-3111 — Stagger the per-SKU eBay offer read

priority 1

apply 00725 to prod, NOTIFY pgrst, then redeploy the edge (the column is read by name; the edge must not go first).

### US-3111 — Stagger the per-SKU eBay offer read

priority 1

48 hours after deploy, confirm from ebay_api_call_daily that GET /sell/inventory/v1/offer has fallen to roughly one read per SKU per day, and that no listing sits in 'listed' with an ended eBay listing for more than 24 hours.

### US-3112 — eBay compliance: extension attribution, and stop calling APIs we cannot use

priority 1

apply 00725 to prod (it now carries disputes_access_denied too), NOTIFY pgrst, then redeploy the edge.

### US-2659 — The storage mirror has no restore path, and its key lives on the host it protects against losing

priority 5

move the rclone crypt password and salt off the DB host and take a second offline copy, then record where (never the value) in vault/10-ops/key-rotation.md. Nothing in this repository can do it, and until it is done the offsite photo mirror does not survive the loss of the host it is backing up.

### US-2668 — Four scheduled jobs fail on every single run: trial-expiry 500 (cause proven) and three 502s

priority 5

after deploy, confirm trial-expiry answers 200 and report the first `downgraded` value. It is the size of the backlog, and it tells us how many accounts held Pro entitlements past their trial end.

### US-2718 — Cross-posting is unreachable in production: the Listing Kit's extension button is compiled out of the live build

priority 8

set the two Pages variables and the edge variable, redeploy, then confirm the button renders on the FlipDesk composer Listing Kit for a paid account with the extension installed.

### US-2665 — docker-compose.coolify.yml is not what deploys the edge, so nine settings it declares are unset in production

priority 10

paste the output of `docker inspect <edge-container> --format '{{json .HostConfig.LogConfig}}{{json .HostConfig.Memory}}'` on the Coolify host. That one line settles the log-rotation and memory questions together, and neither can be answered from this repo.

### US-3107 — OPERATOR: turn on eBay image search for garment-only Prospect and apply for Marketplace Insights so prices come from sold data

priority 15

set SCOUT_EBAY_IMAGE_SEARCH_ENABLED=true on the Coolify edge, run one garment-only Prospect from a phone and record in the notes that identitySource came back 'visual' with no AI action charged (the ai_action ledger row is absent)

### US-2597 — The verify-email step is unmeasured, and a link opened on a second device dead-ends

priority 20

confirm AUTH_EMAIL_HOOK_SECRET on the edge and GOTRUE_HOOK_SEND_EMAIL_* on the auth container, then re-measure /health/ready features.auth_email_hook.

### US-2313 — Nothing in version control creates or verifies the 73 production cron schedules

priority 25

two confirmations against prod (AC3, AC4). (a) Is cron-fleet-health itself a Coolify Scheduled Task, and does its CRITICAL ops event actually reach a human? A watcher nobody scheduled is the joke version of this story. (b) Run the first query of section 11 of scripts/prod-diagnostics-console.sql: both ops_alert rows EXIST (owner confirmed 2026-08-03), but a present row with an EMPTY value ends the entire alert path in an admin screen nobody is watching, and that is what section 11 reports.

### US-2617 — Wire the remaining unmonitored crons into the ledger, starting with the eBay token refresh

priority 25

after the next edge deploy, expect cron-fleet-health to report ebay-token-refresh as STALLED if its Coolify task does not exist. That is the finding, not a false positive - the detector computes expected slots from the schedule rather than from prior runs, so this is the question is-this-task-installed answering itself for the first time.

### US-2617 — Wire the remaining unmonitored crons into the ledger, starting with the eBay token refresh

priority 25

delete the Coolify scheduled task named ebay-orders-sync. Its registry entry is gone (ebay-order-backstop was already the same half-hourly sweep, working), so the task now hits a seller route that answers 401 and nothing in the repo can see it - the drift check catches a MISSING task, never an extra one.

### US-2617 — Wire the remaining unmonitored crons into the ledger, starting with the eBay token refresh

priority 25

change the photo-archive Coolify task URL to /api/jobs/photo-archive. It has pointed at /api/flipdesk/images/archive, a seller route, so the nightly sweep has answered 401 every night since it was created. The old URL still works for a signed-in seller and is deliberately left alone.

### US-2617 — Wire the remaining unmonitored crons into the ledger, starting with the eBay token refresh

priority 25

change the reconciliation-sweep Coolify task URL to /api/jobs/reconciliation-sweep. Same fault as photo-archive - it pointed at a seller route and has answered 401 every night. /api/flipdesk/reconciliation/run stays as the seller Auto-match button.

### US-3028 — credentials-refresh reports one no_block for four different skips, three of which are stale live badges

priority 30

after deploy, hit Run now on credentials-refresh at /admin/ops/jobs and read the new counters to find out what the 13 skipped listings actually are.

### US-2643 — The privacy page says security logs are purged at 90 days; the audit log is append-only by design

priority 35

confirm the retention actually configured on the infrastructure logs the row may be about - Sentry, Cloudflare and the Coolify host. Nothing in this repo can read those, and if the row is only about them then there is no code change to make.

### US-2811 — A shoe's size never reaches the grade: the chain breaks in three places

priority 59

set GRADING_TAG_OCR=true on the edge and redeploy. It accepts 1/true/yes/on. This is the switch that makes a shoe's size stamp readable at all, and it is cheap to reverse.

### US-2609 — Every push to main restarts the production edge, including doc-only commits

priority 60

this is a Coolify setting, not a repo change. In the edge resource, set the build/watch path filter to services/edge-functions (Coolify calls it Watch Paths). Nothing in this repository can do it, and nothing here can verify it either except by pushing a doc-only commit and watching whether the container rolls.

### US-2594 — [HELP CENTER] Converge support_kb_articles into help_articles so the assistant and the help page cannot disagree

priority 83

run the row migration against PRODUCTION, then flip the flag, in that order. AC2 is the migration of support_kb_articles into help_articles - it has been written and re-run against the local stack, but the rows have never landed in prod, and the flag flip is deliberately ordered AFTER they do rather than before. AC5 (retire or redirect /admin/support/kb to /admin/content/help) follows the flip rather than leading it, so it is sequenced behind this, not independently doable. AC6 is a retention decision only you can make: migrate support_kb_revisions alongside, or archive it - the criterion says say which in the note and do not drop edit history silently. ⚠ ONE THING TO KNOW BEFORE THE PROD RUN: the summaries the migration writes are DERIVED from each article's first real paragraph, not authored. deriveSummary skips headings, list items, blockquotes, tables and fenced code, strips link and emphasis markup, prefers a sentence boundary and caps at 200 characters - sized against the 83 hand-written summaries, which run 93-200 and average 133. All 8 migrated articles landed between 80 and 152 characters locally. That removes the duplicate-description problem, and it is still not a substitute for 8 written summaries if these articles matter for search. AC1, AC3, AC4 and AC7 are done.

### US-2813 — Eight measurements are collected and reach no eBay aspect

priority 610

pull the real eBay aspect names for the eight keys from the Taxonomy API, on live bag, belt and hat leaf categories. This is the ONLY thing blocking AC1-AC3 and it cannot be done from this machine: it needs eBay app credentials, which live in Coolify, against live category data. The repo has no cached taxonomy for those categories (checked: the one aspect fixture, src/test/fixtures/required-aspects-cases.json, is the US-2389 required-aspects table and covers none of them). Web search is not a substitute and the story says why: a wrong name here publishes a VALUE under a name that means something else.

### US-2416 — Offsite backups are uploaded unencrypted — R2 credentials alone yield a full plaintext database dump

priority 1972

the mechanism is built and verified; production has not moved. Generate the age keypair, put the identity somewhere off the DB host (never on it - the host holds only the recipient half on purpose), set BACKUP_AGE_RECIPIENT, install the updated scripts/ops/*.sh on the DB host, and run one drill against an ENCRYPTED artifact. Until then every offsite object is still plaintext.

### US-2001 — Edge builds ship with release="dev" — every prod edge error is unattributable to a commit (frontend is correct)

priority 1977

this is a Coolify build question, not a repo change (AC1). /health reports release="unknown" - the value moved from "dev" to "unknown", which is the same defect wearing a different word, so the declarative fix (build.args GIT_SHA in docker-compose.coolify.yml) is not being substituted. Look at how Coolify expands build.args rather than adding another instruction somewhere. AC4's guard already names the candidates for you: /health/ready reports which of RELEASE_SHA, COMMIT_SHA, SOURCE_COMMIT and GIT_SHA held a real commit. AC3 (a real Sentry event carrying the release) is moot until this lands, since the release it would carry is the broken one.

### US-2001 — Edge builds ship with release="dev" — every prod edge error is unattributable to a commit (frontend is correct)

priority 1977

(2026-08-16, SUPERSEDES the build-arg criterion above): do NOT chase Coolify's build-arg expansion. Set SOURCE_COMMIT as an ordinary environment variable on the edge resource in the Coolify UI — the same place SUPABASE_URL and the rest live — and redeploy. A runtime override now works and is the whole fix. VERIFIED by running the edge with SOURCE_COMMIT=abc1234deadbeef and nothing else changed: GET /health returned release="abc1234deadbeef". Coolify populates SOURCE_COMMIT itself on some versions, so try referencing it before hardcoding; if the value has to be typed, any string that names the build is fine (short SHA and tags are accepted deliberately). Then re-read /health and confirm AC2, and check a Sentry edge event carries it for AC3.

### US-2010 — Single edge replica with no graceful shutdown — every deploy strands in-flight work for 6-15 minutes

priority 1986

scale the edge to 2+ replicas in Coolify (AC1), then deploy during an active grading batch and confirm nothing enters stale-reclaim (AC3). Both need the same thing and the second cannot happen before the first. Nothing in this repo can set a replica count.

### US-2104 — Content engine is built and cold — 4 finished drafts unpublished, flags off, webhooks unset

priority 1996

everything still open here is an ops action, in the story own words - AC3 was the only code item and it shipped 2026-07-19. Four things, and the ORDER matters. (a) Read the GSC Page-indexing diagnosis first (US-2095): this story is gated on it because the domain is new and pSEO volume is already an indexability risk. (b) Publish the four finished drafts - zero marginal authoring work, and safe to do immediately even while the engine stays cold. (c) Set CONTENT_INTERNAL_JOB_SECRET and register the content cron in Coolify. (d) Do NOT enable auto_publish_blog until the pacing decision from US-2094 is made. Follow vault/40-growth/content-scheduler.md Safe rollout rather than flipping flags directly. The false-success bug is already fixed in both the manual route and the unattended scheduler tick, so a webhook that is unset no longer marks posts published with nothing sent.

### US-1566 — [OPS — USER ACTION REQUIRED, DEFERRED for agent loop] Prod runtime reconciliation: apply migrations, fix SES/SMTP, create Coolify cron tasks

priority 2358

every criterion here is a production or Coolify action - the title has said USER ACTION REQUIRED since it was filed, in a form prd-operator's DECLARED check does not read, so it has been sitting in the code queue. AC1 apply the migrations and reconcile applied_migrations. AC2 confirm AutoLister generation and photo rotate work afterwards. AC3 fix the SES/SMTP credentials in Coolify and drain the queued backlog. AC4 create the Coolify Scheduled Tasks for the cron registry, each verified with Run Now. AC5 fire the one-off backfills. AC6 configure the migrate:prod pre-deploy gate so schema drift stops recurring. AC6 is the one that pays for itself: it is the difference between this story happening once and happening again.

### US-3082 — eBay Partner Network: affiliate attribution on every outbound eBay link from Scout, Prospect and trigger alerts

priority unranked

apply at partnernetwork.ebay.com for an eBay Partner Network (EPN) publisher account naming gradethread.com and the FlipDesk app as the properties, create one campaign for FlipDesk sourcing, and store the campaign id in Coolify as EBAY_EPN_CAMPAIGN_ID (reference only, value never written to the repo); vault/10-ops/env-reference.md gains the row and the runbook note says approval typically takes days and needs a live site with real traffic

## Production database (psql or the Supabase SQL editor)

### US-3112 — eBay compliance: extension attribution, and stop calling APIs we cannot use

priority 1

one prod eBay connection lacks sell.payment.dispute and one lacks nothing else of note; that seller must reconnect at /oauth/start before dispute notifications work for them.

### US-2288 — Unlimited free trials: handle_new_user grants 14 days of Pro with no abuse check

priority 5

run §19 of scripts/prod-diagnostics-console.sql (AC4). Four read-only queries: trials started vs converted, addresses that normalise to the same mailbox once plus-tags and dots are stripped, what the trials cost in grading, and whether any came from an account since deleted. AC1 is deliberately gated on this - the right abuse control is a different control at two people than at two hundred.

### US-2347 — Run the production verification queries this audit could not run

priority 5

this whole story is prod reads (AC1-AC8). Most of it is already written up as scripts/prod-diagnostics-console.sql, which is read-only and was executed against a real database with ON_ERROR_STOP=1 so it cannot fail your session on a wrong column name. Run it and paste the output back into this story.

### US-2351 — Impersonation is unbounded, unmarked, non-revocable, and allows account deletion as the user

priority 5

confirm the GoTrue OTP TTL in prod (AC7). It sets the real lifetime of the impersonation and resume tokens, so the 30-minute cap enforced in code is only the shorter of the two. AC1-AC6 are done.

### US-2403 — A denied function call from anon or authenticated SEGFAULTS Postgres and restarts the whole database

priority 5

run `show supautils.hint_roles;` over psql on the prod database (read-only, one line). If anon is absent, AC1 closes as does-not-reproduce and AC2 is already satisfied, which unblocks 00527 and US-2282. Do NOT confirm by calling a revoked function: that call is the outage.

### US-2727 — listings.listed_at is NOT NULL but the code writes null for a draft, so the extension writeback INSERT has never succeeded

priority 5

apply 00634 to prod, then NOTIFY pgrst, 'reload schema', then retry one Send to extension and confirm a 200.

### US-2687 — Every paid plan is denied the Claude connector, including the two sold with it

priority 6

apply 00625 to production and confirm with `select key, gate_flags->>'connectorAccess' from public.pricing_plans`. Until it is applied, every Pro and Business seller is still refused the connector. No NOTIFY needed - no table, column or RPC changed, only row data.

### US-2687 — Every paid plan is denied the Claude connector, including the two sold with it

priority 6

decide whether anyone was actually turned away. The connector is dark in production behind MCP_ENABLED, so the likely answer is nobody - but that is worth confirming rather than assuming, and the mcp audit rows record a `plan_required` denial reason.

### US-3044 — [GATE] Measure what the 2026-09-02 AutoLister change did to specific fill rates and per-item cost before the next cut

priority 9

run it against prod for the 200 drafts before 2026-09-02 and the first 200 after, and paste both tables into this story's note; the note names the one aspect whose fill rate moved least and the reason found for it.

### US-2842 — Calibration spike: prove a comp read is close enough to price with, and measure what one costs

priority 11

cannot run from the Windows dev box and is not a coding task. services/edge-functions/.env points SUPABASE_URL at prod but carries a 21-char SUPABASE_SERVICE_ROLE_KEY and a 22-char ANTHROPIC_API_KEY, both placeholders, and EBAY_ENV is sandbox, which has no real comp inventory. Needs a run with real prod service-role, real Anthropic and EBAY_ENV=production credentials, plus the ~100 reads of real AI spend.

### US-2832 — The listings.draft_id prod repair exists only in a markdown file, so no audit can prove it was applied

priority 12

apply it to prod. It changes nothing there - the column exists - and the point is the applied_migrations row, so that a future audit, a restored backup or a staging stack can tell a repaired database from a broken one. Then NOTIFY pgrst, 'reload schema'.

### US-2832 — The listings.draft_id prod repair exists only in a markdown file, so no audit can prove it was applied

priority 12

, SEPARATE AND BIGGER: run scripts/prod-schema-audit.sql against prod. 00134 was half-applied and nothing noticed for months; that script reports every missing table, column, index and function in one read-only pass, and it is the only way to know whether anything else below 00254 is missing too.

### US-2618 — The Help Center is live and empty: 83 articles are written and none are in the database

priority 15

run SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/seed-help-articles.mjs against production, then re-check https://gradethread.com/help. The script needs the service-role key, which is why it cannot be automated from here.

### US-2339 — Android: expense dates walk back one day on every edit-sync cycle

priority 25

audit prod expense rows for dates that already drifted (AC4). Note the drift is directional and COMPOUNDING - an affected row is off by one day per edit-sync cycle it went through, so it cannot be corrected by a single fixed offset. Only rows edited by a user in a negative-UTC-offset zone are affected.

### US-2359 — Buyer plan gating: all 13 gate flags are now accounted for — only the free-tier usage count (AC4) is left

priority 25

run the ALL-TIME half of section 12 of scripts/prod-diagnostics-console.sql (AC4) - the demand_board and guarantee_claim rows of its first query. The 30-day slice came back 0 twice, so nobody ACTIVE loses anything; what is unanswered is whether an account that used either feature months ago should be grandfathered before the gates deploy.

### US-2670 — The disputes RLS insert policy never checks who owns the grade report

priority 25

apply the migration, then re-run AC4 query against prod. The count is expected to be zero - every client except iOS has always gone through the edge route, and iOS filed with its own user_id against reports it was displaying, so the realistic exposure is a crafted API call rather than anything a normal app produced.

### US-2922 — Top 100 brand size charts: verified, sourced and department-complete

priority 43

apply the seed migrations to prod and re-run the coverage script against prod, recording the result in the notes.

### US-2304 — FlipDesk grading drops the label photo the pipeline still blocks on

priority 45

run §26 of scripts/prod-diagnostics-console.sql (AC4). It counts FlipDesk grading rows that ended in needs_photos per month and the refunds that followed. Read the two together: rows with no matching refunds is a WORSE finding than the one this AC asked about, because the seller then paid for a grade they never got.

### US-2610 — A garment with no readable tag cannot be graded at all, and that is a real garment, not an edge case

priority 70

run section 27 of scripts/prod-diagnostics-console.sql (AC5), which decides whether this story gets built at all. It counts submissions stuck in needs_photos by which required photo is missing. READ IT WITH ITS LIMIT: quality_feedback is nulled the moment a grade is produced, so this measures who is STUCK NOW, not how often it has happened - it undercounts by every seller who added the photo and succeeded. If 'label' is far ahead of front and back, the tagless case is real and worth building; if the three are level, it is ordinary incomplete uploads and the fix is upload-time guidance rather than a grading change.

### US-1968 — bulkMigrateListing — bring a seller's existing eBay (Trading) listings under management

priority 1968

run one real-eBay end to end - publish a Trading-API listing, migrate it with bulkMigrateListing, then revise and reprice it. This needs a live seller account with legacy listings and is unreachable from the sandbox, which is why it has never been done. It is the only remaining item; the feature was re-probed and is healthy in production.

### US-2002 — Backups: mechanism verified, prod backup cron never installed — real RPO is total loss

priority 1978

on the prod DB host, install the backup cron and confirm a dump plus its .sha256 lands in the offsite bucket, then run restore-postgres.sh against a REAL offsite dump on a scratch host and record the measured timing (AC1, AC2, AC4). Until the cron is proven to run, the real RPO is not 24 hours, it is total loss.

### US-2434 — Email-keyed PII retained for accounts deleted BEFORE the US-2005 purge shipped is still queryable

priority 1982

run the PII census against prod (the single remaining item). Read-only, has no --apply and never will, and never prints an address. Record the numbers on this story, and treat a missing deleted_account bucket as THE FINDING rather than as a query that came back empty - the population cannot be established from the deletion log, which is why the AC asks for a census rather than a backfill.

### US-2117 — No record of what price or terms any user actually agreed to — pricing_plans is mutated in place

priority 1990

run section 21 of scripts/prod-diagnostics.sql against prod and paste the two counts back here. The story own note says it closes on running that rather than on more code. Read the answer the way that note does: agreements_total at zero means nobody has subscribed since the table shipped and the question is still unanswered, while a non-zero total with with_disclosure_version at zero is the BAD answer - rows are being written and the Stripe metadata is not arriving. The file is read-only and, as of 2026-08-16, is known to execute end to end: all 27 sections were run against a stack built from the full migration corpus, which is also how a fatal bug in it was found and fixed the same day.

### US-2417 — Postal addresses and phone numbers are stored as plaintext columns while OAuth tokens next to them are AES-GCM encrypted

priority 1990

run both backfills against PROD with the real EDGE_ENCRYPTION_KEY — `deno run --allow-net --allow-env scripts/backfill-user-shipping-pii.ts --apply` and the same for scripts/backfill-measure-card-pii.ts. Until they run, the encryption this story shipped applies to NEW writes only and every pre-existing address and phone number is still plaintext, which is the exposure the story was filed for. Both are dry-run by default, both refuse to start without the key, and both are re-runnable (an already-encrypted value passes through rather than double-wrapping, which would be unrecoverable). Run the dry run first and read the row count.

### US-2458 — Support cannot see a buyer subscription at all — no admin route reads buyer_plan or buyer_subscription_status

priority 1991

decide two things, both writes against a customer's money, which is why neither was built speculatively. (1) Should support be able to CANCEL or CHANGE a buyer subscription from the admin surface, or should that stay with the customer via the portal? (2) Is a buyer comp a product we want at all? This is AC4 and it is now the ONLY item left - AC1, AC2, AC3 and AC5 are all done and verified 2026-08-22 (8 tests green, and the buyer_past_due_since column confirmed present in production via PostgREST's OpenAPI document). No code can start until the answers exist.

### US-3016 — eBay drops every descriptive aspect value the AI produces, because nothing maps Taupe onto Beige

priority unranked

run scripts/aspect-value-coverage.ts against prod once the cache is warm, and fold any reported misses into the family tables

## A marketplace account, logged in

### US-2738 — Photos are reported as attached when the page never took them, because the file list was shadowed rather than assigned

priority 8

open a live Poshmark listing form, run the extension's photo attach, and report whether the images actually land. This is AC7 and it is the only thing keeping the story open. It also DECIDES US-2775: if Poshmark accepts the direct assignment, US-2775 is a latent gap on other hosts; if it refuses and the defineProperty fallback runs, US-2775 IS the live bug and this story is not fixed. The honest-failure reporting is already in place, so a refusal now shows the seller 0/8 attached rather than a silent success.

### US-2739 — Poshmark takes whole dollars and we send cents, so the price we type is a value the field cannot hold

priority 8

publish one Poshmark listing through the extension and report whether the price lands. This is AC6/AC11 and it is the only item left. The units bug is fixed (whole dollars, rounded to nearest, never below one step) and so is the reason nobody saw the real failure: the deep probe skipped priceDialog entirely, because its walker only pushed STRING values off the flow config and priceDialog is an OBJECT - so every report saying the Poshmark list flow probes clean was true of nine selectors and blind to three, including the one selectors.js openly records as inferred rather than read off the page. What is unproven is whether the units were the ONLY thing stopping the price. If it still fails, the banner text distinguishes the cases: 'could not set the price' means the dialog never opened, and that is a selector, not a number.

### US-3060 — Verified badge on live listings: show the GradeThread certificate on the marketplace page every extension user is looking at

priority 12

with a graded item listed to eBay and Poshmark from a test account, open both listings in Chrome and Firefox with the 1.1.x build and confirm the badge, the certificate link and the scan-mode badge; flip the opt-out and confirm both disappear on reload

### US-3062 — Side panel work surface: the queue, the item card, comps and the grade next to any marketplace tab

priority 14

on Chrome, Edge and Firefox, open a Poshmark listing from a signed-in test account, open the panel, run a revise from it, and confirm the queue row appears and completes; record the per-browser result in the notes

### US-3154 — Depop closet import through the unified extension

priority 14

the adapter selectors must come from a human running the popup Check selectors probe against a signed-in Depop shop. A guessed adapter is not acceptable, per the recorded history in the US-2702 notes

### US-3063 — Selector snapshot fixtures: catch a marketplace redesign in CI the day it lands

priority 15

capture the eleven fixtures above from a logged-in test account and commit them; the story cannot close on a synthetic fixture

### US-3066 — On-device pre-read with Chrome's Prompt API: an instant, free, private first look before the certified grade

priority 18

on Chrome 138+ with the on-device model downloaded, open a Poshmark listing with a visible pill on the fabric and confirm the quick look names it before the paid read; on Firefox confirm the option is hidden and nothing else changes

### US-3058 — Extension revision: verify the redesigned overlay on live marketplace pages and ship 1.1.0 to the stores (operator)

priority 19

load extension-unified unpacked in Chrome and Firefox, open one listing and one search page on each of eBay, Poshmark, Grailed, Mercari, Depop and Vinted, and record (screenshot per site, light and dark) that the overlay ring, tier, factor bars, signal rows, pin and alert controls, the owner-listing collapsed bar and the search badges render without site CSS bleed; file any miss as its own story before shipping.

### US-3070 — Label reader from the context menu: right-click a tag photo, get brand, size, RN and style code

priority 22

right-click a real care-tag photo on a Poshmark listing and on an unrelated site (a blog post) and confirm both render; confirm the RN link lands on the RN page with the box prefilled

### US-2322 — Concurrent token refresh disconnects sellers on providers that rotate refresh tokens

priority 25

ask Etsy, Depop and Whatnot whether they invalidate the OLD refresh token on rotation (AC4). This sets SEVERITY, not correctness - siblingRefreshWon already makes the race survivable either way. AC5 is answered: prod section 13 returned no rows, so the race never disconnected a seller.

### US-2472 — EPIC: marketplace coverage + honest automation — close the gap on Crosslist/Vendoo without copying Nifty

priority 30

nothing in this epic needs code, and the remaining work is carried by its children rather than here. Four are open and all four already declare their own operator step: US-2473 (Depop partner approval), US-2474 (Etsy app keystring), US-2479 (one live Vinted listing re-run through the popup selector check), US-2480 (Facebook Marketplace enable). Two partner approvals and two sessions with a browser open. This criterion exists so the epic appears in `npm run prd:operator` instead of reading as buildable and costing another session the four reads it takes to discover otherwise.

### US-2479 — Vinted lister flow: publish and delist via the unified extension

priority 37

the LIST flow is already live (selectors verified 2026-08-11 on www.vinted.com/items/new). What is left is DELIST: open one of your OWN live Vinted listings while signed in and re-run the popup selector check, then set delist.enabled. The earlier probe missed because it ran on a page that was not the seller's own listing, where the action menu cannot exist - that miss is not evidence about the selectors. Until then a Vinted sibling of an item sold elsewhere gets a pending-delist marker and a reminder rather than being left silently live.

### US-2480 — Facebook Marketplace lister flow: publish and delist via the unified extension

priority 38

run the popup selector check on the live Facebook Marketplace create form while signed in, then set enabled with a version and lastVerified. The code is written and deliberately stops at Next rather than publishing: auto-publishing with a guessed category gets the listing removed and the account flagged, so a human confirms the category on every publish by design. Marketplace class names are hashed and churn every deploy, which is why the selectors are ARIA-anchored and why they need re-checking against the real page rather than a fixture.

### US-2696 — EPIC: extension sold-sync — two-way truth for the no-API marketplaces

priority 40

the remaining work is one sitting, carried by three children that already declare it: US-2698 (Poshmark), US-2700 (Mercari), US-2702 (Grailed and Vinted). Each needs the same thing and none of it is code — a person with a logged-in account running the popup's Check selectors probe against their own sold pages, saving a scrubbed fixture into extension-unified/test/fixtures/, setting lastVerified, bumping the version off -draft and flipping enabled in sync/selectors.js. This criterion exists so the epic appears in `npm run prd:operator` rather than reading as buildable.

### US-2698 — Poshmark sold-sync observer: passive harvest, no automated traffic

priority 42

one sitting with a logged-in Poshmark account. Open the popup's Check selectors probe on your closet and on the Sold page, save the scrubbed HTML into extension-unified/test/fixtures/ (the fixture guard checks it on that commit), then set lastVerified, bump the version off -draft and flip enabled in sync/selectors.js. Nothing else in this story needs code - all 40 extension test files pass and the fixture guard was sabotage-checked 6 of 6.

### US-2700 — Mercari sold-sync observer

priority 44

sign in to a real Mercari account with at least one sold item and confirm the sold-sync observer harvests it. This is AC1 and it is the only item left - AC2 through AC5 are satisfied, three of them by construction. AC5 is the story's own thesis and it measured true: no Mercari-specific code path was added to the server, so the intake built in the previous story really is platform-agnostic.

### US-2326 — Marketplace webhooks have no freshness window and one debug flag disables all four

priority 45

two confirmations that cannot be made from here (AC1, AC5). (a) In staging, check EDGE_ENV and WEBHOOK_PAYOUT_DEBUG, and whether staging shares marketplace_connections with prod - if it does, the unsigned-request path is live against real seller connections. (b) Get Depop's actual webhook documentation: the header names in the receiver (x-depop-signature / x-depop-hmac-sha256, x-depop-webhook-id / x-depop-delivery-id) are GUESSES, and the dedupe failure mode on a wrong guess is SILENT.

### US-2702 — Grailed and Vinted sold-sync observers

priority 46

the first step needs a human with logged-in Grailed and Vinted accounts, running the popup's Check selectors probe against their own sold pages. AC5 is the only criterion already met; everything else waits on those selectors being read off real pages rather than guessed.

### US-1880 — Research surface: verify the five unverified adapters, fix the dead Poshmark upgrade rule, close intl host gaps, add selector-failure ping

priority 1880

open a real listing on each of Poshmark, Grailed, Mercari, Depop and Vinted while logged in, confirm the gallery, title and brand selectors read it and that the URL-upgrade rule yields a FULL-RES image rather than a thumbnail, then set verified:true and lastVerified in BOTH config files (AC1, the only thing still open). Everything else shipped: the dead Poshmark regex is fixed, the international hosts are in with a drift guard, srcset picks the widest candidate, and the anonymous selector-failure ping is live end to end. The five verified flags are the last false things in the file.

### US-1882 — Web↔extension transport v2: postMessage bridge so seller tools work beyond Chromium

priority 1882

run a seller flow end to end in FIREFOX on a real Poshmark listing form. That is AC4's second half and the only thing left - AC1, AC2, AC3 and the Chromium no-regression half of AC4 are code-complete and tested. The bridge itself is executed rather than grepped by extension-unified/test/gt-bridge.test.cjs, which asserts the frame guard, the correlation-id round trip, the explicit target origin, five ignored envelopes, and that the push relay forwards ONLY GT_LISTER_JOB_UPDATE and GT_LISTER_LISTED. What no test can reach is whether Firefox's real content-script timing and a real marketplace page behave like the stub.

### US-1662 — Whatnot listing publish/update/delist + order sync

priority 2145

needs Whatnot partner access and live docs. Their API is private with no public documentation, so unlike Etsy - which has real v3 docs - the endpoint and field shapes cannot be responsibly finalized from the outside. Building against a guessed shape here would produce an adapter that compiles, passes its own tests, and fails on first contact. Nothing starts until someone has the partner materials in hand.

## A lawyer

### US-3064 — Seller honesty in the overlay: state how far this seller's claims sit from the grade, from the condition index

priority 16

after US-2709 closes, confirm with counsel's answer in hand which of AC2 and AC3 may ship, and note the decision on this story before any code merges

### US-2708 — EPIC: market condition index — aggregate the claimed-vs-actual gap the extension already measures and throws away

priority 50

nothing in this epic can start until US-2709's question to counsel is answered. All five children (US-2709..US-2713) sit behind it: US-2709 carries the question itself, and US-2710 through US-2713 each depend on it for the fields they are allowed to retain. The spike's AC1-AC5 are done and the decision contract is written at vault/20-domain/market-condition-index-contract.md; what is missing is a per-marketplace go or no-go on whether aggregating buyer-initiated listing reads is consistent with each marketplace's terms. One question, six marketplaces, because the clause is the same shape everywhere. This criterion exists so the epic appears in `npm run prd:operator` rather than reading as buildable — its children are correctly blocked via dependsOn, and the umbrella was not.

### US-2709 — Decision spike: what may be aggregated from buyer condition reads, and under what contract

priority 51

one question to counsel, covering all six marketplaces at once - the terms clause governing automated processing of listing data by a browser extension acting for a logged-in shopper. That is AC6 and AC7, the only two left, and it is deliberately ONE action rather than six because the clause is the same shape everywhere. The decision contract is already written up at vault/20-domain/market-condition-index-contract.md with the k-anonymity floor, the price-banding rule and the user_id decision settled; the per-marketplace go/no-go is the part that needs a lawyer. US-2710 through US-2713 are all blocked behind this answer.

### US-2528 — The Terms of Service predate four shipped products

priority 1942

counsel has to write the extension disclosure section of the Terms (AC5). Nothing here writes legal copy, and terms.tsx and acceptable-use.tsx are deliberately untouched. The drift guard is already in place and is honest in both states - while the section is absent it asserts the absence is tracked as open work, and the moment a section lands it starts checking all four disclosed facts are present, matching on the CLAIM rather than the wording so counsel can rephrase freely.

### US-2114 — Counsel review gate + jurisdiction matrix for subscription disclosure and cancellation

priority 1990

this entire story is counsel work - it is the review gate the other subscription-disclosure stories are waiting behind. AC1 needs a lawyer to review the point-of-sale disclosure copy, the affirmative-consent wording and mechanism, and the cancellation flow. AC2 needs a jurisdiction decision (which state ARLs are in scope, and whether we design to a single strictest standard). AC3 needs a written determination on whether the 14-day no-card trial is an automatic renewal or continuous service offer under California law. AC5 needs the consent-record retention period confirmed. Only AC4 - recording the outcome in a vault note under vault/50-business/ and linking it from the pricing and legal notes - is work anyone else can do, and it cannot start until the other four have answers. US-2116's AC1 and AC5 are explicitly deferred to this story.

### US-2115 — No auto-renewal disclosure exists on ANY web purchase surface

priority 1990

get the auto-renewal disclosure copy reviewed by counsel (AC5, the only thing still open). The story's own acceptance criteria forbid an agent drafting it, and the brief is at docs/legal/terms-update-brief-2026-08.md.

### US-2116 — No affirmative consent to recurring billing is captured or retained at purchase

priority 1990

AC1 and AC5 are counsel items belonging to US-2114 and cannot be closed here. The engineering half shipped - the confirmation query for the operator queue is SELECT method, count(*) FROM public.legal_acceptances WHERE accepted_at > <apply time> GROUP BY method, expecting both signup_clickwrap and signup_clickwrap_confirmed present in roughly equal numbers.

### US-2145 — A seller whose GENUINE item is flagged has no way to contest it

priority 1990

AC6 needs counsel on the contest/appeal terms. AC1 through AC5 shipped, including the contest button that was the only missing piece of the flow.

### US-2133 — Substantiation review of every public authenticity claim and its framing

priority 1991

review every public authenticity claim WITH COUNSEL. AC1 requires it, and the story's own instruction is 'do not let an agent draft the claim language' - so this is not work to hand back to an agent under any framing. Declared because a story that says NOT AGENT WORK only in a note reads, to anyone scanning the backlog, exactly like a story nobody has got to yet.

### US-2124 — No price-change notice or consent path on any platform

priority 1992

AC3 is a legal determination and belongs with US-2114's counsel review - whether a price increase requires FRESH affirmative consent on the web, which it commonly does under state automatic-renewal laws. Batch it into that same conversation rather than asking twice. AC4 is a standing instruction rather than a task: do not implement a price change of any kind until the notice path exists. Worth keeping visible, because it is the criterion someone will step over when a pricing decision feels urgent.

### US-2127 — Refund policy contradicts the vault: an undisclosed 14-day money-back guarantee

priority 1992

AC4 is counsel review of refund.tsx sections 4 and 5 - the EU/UK right-of-withdrawal waiver and the chargeback clause - and it gates the rest. AC1's factual half is SETTLED from the schema and needs no lawyer: users.grade_credit_balance is a plain integer with a >= 0 CHECK and no expiry column exists across all 612 migrations, while the monthly allowance is a separate system (grades_used_this_month / grade_reset_at / included_grades_this_period) that does reset. So 'credits never expire' is true of PURCHASED packs and 'do not roll over' is true of MONTHLY INCLUDED grades, and the Terms sentence uses the word credits for the thing that resets. What remains is approving wording, not investigating. NOTE FOR WHOEVER PICKS THIS UP: terms.tsx was edited once and deliberately reverted, because rewriting it ahead of counsel swaps one unreviewed statement for another - the KNOWN_CONTRADICTIONS entry in src/test/credit-expiry-claims.test.ts says so and must be DELETED in the same commit as the fix, since the guard fails on a stale entry as loudly as on a new contradiction.

## A grading run that costs real money

### US-2301 — The golden-set eval gate never runs in CI and the live prompt versions have no DB row

priority 25

two reads settle AC1 and size AC3. §15 of scripts/prod-diagnostics-console.sql returns golden-set size and which ai_prompt_versions rows are active with what qualified_model. An EMPTY set is the finding, not a null result: it means the accuracy gate has never run and cannot.

### US-2471 — Grading + AI prompts name photo roles instead of numbered slots

priority 51

run the golden-set eval with GRADING_PHOTO_ROLES on, then take it through a canary slice before flipping it in prod (AC2). Needs real vision calls, so neither CI nor an agent can do it.

### US-2674 — listing_gen_v2 carries the verified eBay policy rules and has never gone live

priority 61

run the eval and the canary. AC1, AC3, AC4 and AC6 all need production, and none of them is a code change. (1) Run runListingEval against listing_gen_v2 so its ai_prompt_versions row shows eval_passed = true - this costs real vision calls, which is why it has never been done casually. (2) Activate through activatePromptVersion, never by editing the LISTING_GEN_PROMPT_VERSION default; that door is now guarded by prompt-activation-single-door_test.ts. (3) Let a canary window accumulate listing_prompt_acceptance rows for BOTH listing_gen_v1 and listing_gen_v2. (4) Check summarizeListingPromptPerformance reports v2 field keep-rate at or above v1 over at least 30 drafts, and roll back if not. (5) Strike gap 10 in vault/30-platform/ebay-ranking-playbook.md in the same commit that activates v2. The code side is finished and verified: AC2's two guards and AC5's resolvePromptText case pass, 16 tests green across listing-gen-prompt-v2_test.ts and prompt-activation-single-door_test.ts.

### US-1997 — Category rubric activation was never filed — 00231 shipped grade_reports.rubric_key/factor_scores to prod and nothing ever writes them

priority 1200

AC2 needs a GOLDEN SET for non-clothing that does not exist, and it cannot be manufactured here. US-1997 already decided ACTIVATE (AC1) and recorded it (AC5); AC4's drift guard is closed on evidence - rubric-parity_test.ts runs 53 green on the edge and 10 on the client against the same src/test/fixtures/rubric-factors.json. Phase 2 - the pipeline actually writing rubric_key + factor_scores for non-clothing categories - has to pass the eval gate before it can serve, and the grading-engine contract is explicit that a golden set grows from REAL corrected grades with expert consensus and never from synthetic fabrications. So this needs someone to grade real non-clothing items (sports cards and whatever else is in scope) and have those corrections reviewed, before any code can be evaluated against them. Until then the feature is correctly not live: rubric.ts stays on the check-unwired-modules allowlist as PENDING, with its client mirror src/lib/rubrics.ts live and the two pinned by that shared fixture.

### US-2225 — Handbags and small leather goods cannot be graded — 'bag' routes into the clothing rubric

priority 1974

bootstrap a handbag and small-leather-goods golden set from real corrections (AC5, AC6, both US-1997 Phase 2). They are all waiting on the SAME missing input, which is worth seeing together: a prompt only ships through shadow -> golden-set eval gate -> canary, and a gate with no cases for the new category cannot pass or fail it - it would report on the eight categories already covered and say nothing about the ones the story is about. Golden cases grow from REAL human-corrected grades, so the bootstrap is: grade some of these items behind the flag, collect expert corrections, THEN gate.

### US-2223 — Headwear cannot be graded — hats have a garment_category, no rubric, no photo slots and no measurements

priority 1976

bootstrap a headwear golden set from real corrections (AC5; AC4 is US-1997 Phase 2 engineering that follows it). They are all waiting on the SAME missing input, which is worth seeing together: a prompt only ships through shadow -> golden-set eval gate -> canary, and a gate with no cases for the new category cannot pass or fail it - it would report on the eight categories already covered and say nothing about the ones the story is about. Golden cases grow from REAL human-corrected grades, so the bootstrap is: grade some of these items behind the flag, collect expert corrections, THEN gate. The schema half is done and verified against a throwaway stack from zero. Note the enum values are effectively permanent: Postgres cannot drop one, so a revert means leaving them inert and rolling the frontend back.

### US-2222 — Category grading criteria cover 8 of 20 garment categories — 12 categories grade with no category guidance at all

priority 1977

bootstrap a golden set for the twelve uncovered garment categories, then decide the shadow spend (AC3, AC4). They are all waiting on the SAME missing input, which is worth seeing together: a prompt only ships through shadow -> golden-set eval gate -> canary, and a gate with no cases for the new category cannot pass or fail it - it would report on the eight categories already covered and say nothing about the ones the story is about. Golden cases grow from REAL human-corrected grades, so the bootstrap is: grade some of these items behind the flag, collect expert corrections, THEN gate. AND IT IS A SPEND DECISION, not just a flag flip: the per-image shadow path is OFF by default and costs a vision call per photo plus a composite per sampled submission (PER_IMAGE_SHADOW_DAILY_VISION_CAP). GRADING_CATEGORY_CRITERIA_V2 stays OFF until both are settled.

### US-2210 — Grading never runs the tag-OCR ground-truth pass — the brand and size on a certificate are seller-typed, not read off the label

priority 1989

run the prompt-version lifecycle for the +tag era and decide whether to activate. This is AC3 and it is the only thing left. Shadow-compare on live traffic, then the golden-set eval gate (EVAL_MAX_MAE / EVAL_MIN_AGREEMENT), then activate through activatePromptVersion, optionally via a canary slice - every step needs LIVE vision calls against real submissions, which is why the feature shipped gated on GRADING_TAG_OCR with the default OFF rather than half-activated. A SECOND DECISION RIDES ON THE SAME NUMBERS: tag_read is deliberately kept out of the public certificate allowlist, because publishing a machine read of a seller's tag as certified identity is a product call that should wait for eval accuracy. AC1, AC2, AC4, AC5, AC6 and AC7 are done and tested.

## A decision, with nothing to open

### US-2090 — Two iOS parity gaps have no covering story

priority 1930

decide how authenticated iOS UITests get a session, then someone with a Mac runs them. AC1 is the only item left - AC2 (inline per-field editing of saved comps) shipped in e9b90109. It needs either a seeded test account or a mock network layer, which is a decision before it is code, and iOS cannot be built or verified from the Windows checkout at all (AC4) - the iOS CI lane on macOS runners is the gate. Today the only UITest coverage is the launch smoke in ios-smoke.yml, so no authenticated flow is exercised anywhere.

### US-2557 — iOS shows no unread notification count on the tab bar

priority 1953

decide where a seller marks a notification read on iOS. AC3 says the badge 'clears as rows are marked read' and nothing on iOS ever marks one - measured 2026-08-22: unreadBadge.reset() has no caller, nothing writes notifications.is_read, and BuyerAlertsView reads the flag without ever setting it. So the badge rises on a push and cannot be dismissed from the phone; it falls only if the same notifications are read on web. A badge that cannot be cleared trains the user to ignore it, and AC4 puts that same number on the app icon. The three candidates behave differently and none is obviously right: clear on opening the alerts view (dismisses things they meant to return to), per row on tap (the count falls one at a time), or an explicit mark-all-read control (matches web, but is a new affordance). Web has a real notification centre to hang this on; iOS has a filtered alerts view and no centre, which is why there is nothing to copy. Everything else in this story is built: the tab badge, the app-icon badge, the shared count, and now UnreadBadgeStoreTests.

### US-2016 — iOS silently omits the entire paid consumer grading path, including the 14-day dispute flow

priority 1992

decide where the consumer grading path is entered from on iOS, then it can be wired. The flow itself is BUILT and TESTED - ConsumerGradeFlow.swift implements submit, pay, poll and result with the money-first ordering, PhotoGradeSubmit posts to the endpoint, dispute ships - and NOTHING CONSTRUCTS IT. Measured 2026-08-22: ConsumerGradeFlow is referenced only by its own file and its test; PhotoGradeSubmit has no caller outside its own file. A seller cannot reach any of it. ⚠ AND THE PARITY GUARD READS GREEN OVER THIS. grading-pipeline-parity.test.ts asserts iOS has every endpoint of both pipelines, and it does - as strings in two files nothing opens. The guard answers whether the source contains the call, not whether a user can get to it, so it will keep passing until someone looks. The decision is the entry point: a tab, a row on an existing screen, or a route from a push. Once that is chosen the wiring is small.

### US-2113 — Comparison cluster: one page built against the highest-volume keywords we have

priority 1998

read the Google Search Console Page-indexing report (US-2095, already declared) and decide whether to expand or consolidate. That is this story's own gate, set at filing: do not start until the diagnosis is read, and if the domain is crawl-constrained, consolidate before expanding. Nothing here can reach Search Console. The criteria themselves are largely met already - 16 comparison pages are registered against AC1's 3-5, AC3's interlink wiring and approved anchors are in place, and AC4's CollectionPage + ItemList on the hub was delivered by US-2072 and is guarded by the US-2044 parity test. So the decision is whether to write MORE, not whether to build anything.

## Sentry or PostHog

### US-2337 — iOS: SyncEngine can prune the entire local database when the session lookup fails

priority 5

check Sentry and PostHog for users whose local item count dropped to zero (AC4). Correlate against the new breadcrumbs 'Sync reconcile aborted: tenant scope unresolved' and 'Sync reconcile refused: prune requested under an unresolved tenant scope'.

### US-2688 — Filing a grade dispute from iOS fails every time, and the customer is shown a property name

priority 7

check whether any iOS dispute was lost. The filings 400ed so nothing was written - a seller who tried saw an error and may have given up inside the 7-day window. Sentry carries the failures if the sheet reported them.

### US-2011 — Stripe webhook dead-letters alert only to Sentry, whose routing is unverified — a paid checkout can vanish quietly

priority 1987

confirm a Sentry event actually ROUTES to a human (AC2). The title's premise is now partly measured and narrower than it reads: SENTRY_DSN is set in production and Sentry IS receiving events, so the open question is the Sentry-side alert rule, not the DSN. The one reason the observability group still reports degraded is RELEASE_SHA, which is US-2001.

## Email or SES

### US-2597 — The verify-email step is unmeasured, and a link opened on a second device dead-ends

priority 20

confirm SES is out of sandbox and confirmation mail is actually delivered. No client event can tell an unopened email from an undelivered one.

### US-1757 — Extension: store distribution + install funnel

priority 1757

publish the extension to the Chrome Web Store and Firefox AMO. That is AC1 and it is the core deliverable. It needs store developer accounts and a running browser to capture the screenshots, neither of which exists on this host. The note has said OPERATOR-GATED since 2026-07-09 in prose; declaring it so the queue counts it.

### US-2218 — Authentication tells are text-only — there is no known-genuine reference imagery to check a font, stitch or stamp against

priority 1981

source licensed or owned known-genuine reference imagery. Every acceptance criterion above is DONE - they cover the mechanism (mandatory provenance, private-by-default serving, the unverifiable marking, no seller photos, the confidence cap) and all five hold. The story stays open because its TITLE is about the outcome and authenticity_references is empty, so every visual tell reports UNVERIFIED in production and the cap sits at 0.6 on every authenticity submission. Same shape as US-2215's extended-sizing seeding: the dimension is the prerequisite, not the deliverable. Closing on the mechanism would archive a story whose stated problem is unsolved for every real submission.

## A phone, in your hands

### US-3109 — Prospect opens on a live viewfinder instead of a two-slot form

priority 20

this is the part of Prospect that cannot be verified without hardware. Run the capture flow on a real device, background and foreground the app mid-capture, and record the device and iOS version in the notes

### US-2335 — Roughly 359 form controls have no accessible label

priority 45

verify a representative page with a real screen reader (AC4) - NVDA on Windows, VoiceOver on macOS. The scanner reports zero, but it measures whether a name EXISTS, not whether it DISTINGUISHES one control from eight identical siblings; US-2450 was found that way and no count in this repo can see it.

### US-2450 — Every control in a FlipDesk listings row is named the same thing, so a screen reader cannot tell which garment it is about to reprice

priority 1989

drive the FlipDesk listings table with a real screen reader (AC6) - NVDA on Windows, VoiceOver on macOS. This is the same gap as US-2335's AC4 and it is not a formality: distinguishing names are necessary and not sufficient, and fourteen controls per row is a lot of speech per item however well each is named.

## App Store Connect

### US-2286 — Apple sandbox purchases grant production plans

priority 5

audit existing appstore-sourced entitlements for sandbox-originated grants (AC5). Grants made before the environment marker are NULL, so they cannot be identified from the database alone; this needs App Store purchase history.

### US-3138 — Action Credits: prepaid top-ups so a small shortfall does not force a tier upgrade

priority 20

create four Stripe prices and set STRIPE_PRICE_ACTION_CREDITS_50/150/400/1000; create four App Store Connect consumables; create four Play Console products. The checkout returns 503 until the Stripe prices exist

## eBay developer or seller account

### US-2790 — Predict the shipped parcel from the measurements we already took - the bulk margin floor prices postage at zero

priority 9

read eBay's packageWeightAndSize field shape from a browser, or point at a vendored SDK type. That is the ONLY thing left. services/edge-functions/src/lib/ebay-client.ts InventoryItemPayload has no such field, so adding it means writing eBay's exact field names, nesting and unit enums - and developer.ebay.com has timed out six times across three sessions on five distinct URLs plus the edp.ebay.com mirror, while pe.usps.com answered four times in a single session. It is eBay's documentation specifically, not the network. Writing that shape from memory is what this story's own carrier-number discipline forbids, and a wrong eBay field name fails at PUBLISH rather than at compile - the expensive place, because the offer is already created by then. Everything else shipped: the estimator and its edge mirror, the pack model, USPS dimensional weight at the published 139 divisor (the design draft said 166, which is UPS/FedEx), the sourced rate table with both provenance guards, the shared margin rule, the bulk grid (the original defect), the logistics rates route, migrations 00649 and 00650 both applied, the prediction writer, and the per-item profit figure.

### US-3107 — OPERATOR: turn on eBay image search for garment-only Prospect and apply for Marketplace Insights so prices come from sold data

priority 15

apply for the Marketplace Insights API grant (buy.marketplace.insights scope) on the eBay developer account, after US-3042's compliance gaps are closed; record the application date and outcome in vault/10-ops/env-reference.md next to EBAY_MARKETPLACE_INSIGHTS

## Cloudflare dashboard

### US-2619 — Two OG image endpoints return 200 with an EMPTY body, so blog posts and social cards preview blank

priority 20

open the Cloudflare Pages real-time log and search for [og/social/card] render failed. Every failure now logs the actual exception with the endpoint named, and that one line is the cheapest path to the root cause by a wide margin - four hypotheses have been eliminated from the outside and the fifth cannot be tested without the Workers runtime.

### US-2095 — GSC/Bing verification + Page-indexing diagnosis — the gate for all content work

priority 1993

this whole story needs Search Console access and DNS (AC1-AC5). It is the gate for all content work: seo-geo-strategy.md and seo-indexability.md deliberately contradict each other, and the argument cannot be settled without the Page-indexing numbers.
