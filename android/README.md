# GradeThread Android

Native Kotlin/Compose client, **partway through** the US-1299 conversion backlog.
The iOS app is the behavioural source of truth.
Reference: [`vault/90-archive/android-conversion-plan.md`](../vault/90-archive/android-conversion-plan.md).

## Status — read this before estimating (US-2015)

**This client is NOT at iOS parity.** It previously said it was, next to a package
map for directories that contained no code; both are corrected below. iOS has
~578 Swift files across ~60 feature areas, Android ~250 Kotlin files across ~12.

**It is also not a launch gate** (owner, 2026-08-15, US-2015 AC4). Launch is web
and iOS. Android keeps building and its verify lane stays green — locally and in
CI — but it gets no store listing this cycle, and no open Android story blocks
launch. That is a scope decision, not a verdict on the code: read the open
Android stories as post-launch work rather than as a list of things holding
anything up. See `vault/10-ops/launch-checklist.md` §7.

**Built and wired:** auth (PKCE) · Room offline cache + sync coordinator, delta
pull, mutation queue *and its replay*, delete reconciliation · CameraX capture and
staged uploads · AI attribute extraction · Snap-to-Value · the full certified
grading path (validate → submit → poll → report → dispute, plus bulk) · inventory
list and item canvas (photos, measurements, comps, eBay specifics) · global search ·
eBay OAuth connect · eBay listing sync (pull → poll → provenance-aware merge),
the unified listing card, and publish/relist with pre-flight, listing-time
category specifics and a live profit estimate · the negotiation inbox (offers,
send-offer, buyer messages) · bulk pricing · orphan-listing reconciliation with
the shell-wide banner · per-listing promotions and markdown sales · post-sale
shipping and feedback · repricing rules with scan-driven suggestions ·
AutoLister batches, photo QA and the drafts library · flaw disclosure with
annotated photos · timezone-aware scheduled drops · trigger/action/scope
automations ·
payout reconciliation against the recorded sales ·
Play Billing for credit packs and FlipDesk subscriptions ·
the paywall, the one-time post-signup plan step and the shell-wide plan gate ·
analytics (grade distribution, brands, sell-through, inventory value, grading ROI,
a range selector and an on-demand AI summary) with the listing-performance
drill-down ·
community benchmarks with brand deep-links into inventory ·
consignors, per-item splits and the payout report ·
listing templates applied from the publish composer ·
Scout (graded, profit-ranked eBay candidates) and in-store Prospect ·
verified-seller status with an offline-tolerant requirements checklist ·
the item passport (pedigree timeline with confidence per hop) ·
the shipping queue with tracking entry and offline-queued mark-shipped ·
FCM push (channels, deep-linked taps, inline accept/counter/mark-shipped/reconnect) ·
Home, Money (KPIs, cash flow, aging, time-on-market, ROI-by-source, per-item
P&L), Sales, Expenses, Settings.

**Not built.** The remaining work is the expensive half, not a polish pass:

| Area | Owning story |
|---|---|
| Full string externalization beyond the 39 scoped files | US-2368 (in progress) |

US-1379–1389 have since landed (widgets, background refresh, shortcuts, share
target, onboarding, referrals, support, feedback, workspaces, CSV import) — see
the sections below. Localization is **partially** done: the mechanism, the
guard, the plurals, the locale picker and the pseudolocales all ship, and seven
Compose files are converted and locked. The remaining ~80 are not.

## Stack (pinned in `gradle/libs.versions.toml`)

Kotlin 2.1.20 · AGP 8.9.2 · Gradle 8.13 (wrapper) · JDK 21 (build only; bytecode still 17) ·
Jetpack Compose (BOM 2025.04) + Material 3 · Hilt · Room · DataStore ·
Navigation-Compose · Coroutines/Flow. minSdk 26, target/compileSdk 36.

## Build

```bash
npm run android:doctor     # find a usable JDK + the SDK, write local.properties
npm run verify:android     # everything CI runs, in CI's order
```

`android:doctor` is the first thing to run on a machine that has never built
this. It resolves a JDK, the SDK and a Python 3, says which candidates it
rejected and why, and prints the exact install command for anything missing.
The failure it exists to prevent is AGP's, which reports an unusable JDK as
`What went wrong: 25.0.2` and names neither the JDK nor the fact that a JDK is
the problem. JDK **21** is what CI builds on; 21-23 are accepted, and anything
newer is rejected because Gradle 8.13 will not run on it.

The floor moved 17 → 21 in US-2891 and the reason is worth stating, because
nothing in this app's code needs Java 21: Play requires targetSdk 36 →
`compileSdk` 36 → Robolectric needs its SDK 36 `android-all` jar → that jar
will not load below Java 21. The doctor still *finds* a JDK 17 so it can say
"you have 17, you need 21" rather than "no JDK at all". The app's own
`sourceCompatibility` / `jvmTarget` stay at 17, so the shipped bytecode is
unchanged — this is the JVM Gradle runs on, nothing more.

`verify:android` runs the same list as `.github/workflows/android-ci.yml`, in
the same order, from the `on("android")` block in `scripts/verify.mjs`. It is
opt-in rather than part of `npm run verify`, because a cold run is minutes of
Kotlin + KSP + R8 and the default set has to stay fast enough that people run
it. **The pre-push hook turns it on automatically when the push carries
`android/**` changes** — which is the moment it matters, and the gap it closes:
before US-2502, android code could reach origin with nothing having compiled it
locally.

## Working without Android Studio (US-2502)

Everything Android Studio does for this project has a command, except three
things that genuinely need the IDE. The point is not to avoid the IDE — it is
that a laptop with no IDE, and CI, can reach the same verdict.

| Android Studio | Here |
|---|---|
| Sync / first-run setup | `npm run android:doctor` |
| Build > Make Project | `npm run verify:android`, or `./gradlew :app:assembleDebug` |
| Reformat Code | `npm run android:format` (spotless + ktlint) |
| Analyze > Inspect Code (Kotlin) | `./gradlew :app:detekt` — plus the Compose ruleset |
| Analyze > Inspect Code (Android) | `npm run android:lint` — warnings are errors, baselined |
| Run tests | `npm run android:test` |
| Coverage gutter | `npm run android:coverage` → `app/build/reports/kover/` |
| Compose Preview pane | `npm run android:screenshots` (Roborazzi, renders on the JVM) |
| Layout Validation (sizes/dark) | the same screenshot tests, light + dark goldens |
| Layout Inspector — static tree | `npm run android:device hierarchy` (uiautomator dump; it diffs) |
| Run on device | `npm run android:device run` |
| Logcat | `npm run android:device logcat` (filtered to this app's pid) |
| Crash from a build you shipped | `npm run android:device crash` |
| AVD Manager | `npm run android:device avd create` / `avd start` |
| Run instrumented tests on a device | `npm run android:e2e` — Gradle boots and tears down the emulator |
| Database Inspector | schema: `app/schemas/`; migrations: `RoomMigrationTest` |
| APK Analyzer (download size) | `python3 scripts/abi-size-report.py`, budgeted in `abi-size-budget.json` |
| Dependency update inspection | `npm run android:updates` |
| Generate signed bundle | `./gradlew bundleRelease` + `.github/workflows/android-release.yml` |
| Screenshot | `npm run android:device screenshot` |
| Deep-link testing | `npm run android:device deeplink <url>` |

**Still needs Android Studio.** Three things, and they are all live-attach
tooling rather than anything that gates a release:

- the **Profiler** — memory, CPU and energy traces
- **Layout Inspector's live view hierarchy** — the 3D, attached-to-a-running-app
  one. The static tree is available above and is the half that diffs.
- **interactive breakpoint debugging**

### The gates, and what each one is for

Run in this order by both `verify:android` and CI, cheapest first — a formatting
failure should not cost the eight minutes `assembleRelease` takes to surface.

| Gate | Catches |
|---|---|
| `no-ungated-log.py` | a session token or a seller's address written to logcat |
| `no-bare-strings.py` | UI text that can never be translated |
| `check-string-formats.py` | a placeholder-count mismatch that throws in one language only |
| `check-room-schemas.mjs` | a Room version whose schema JSON was never committed |
| `spotlessCheck` | formatting, on new and changed code only (ratchets against origin/main) |
| `detekt` | swallowed exceptions, dead code, unstable Compose params |
| `lintDebug` | leaked contexts, unused resources, known-vulnerable SDK versions |
| `testDebugUnitTest` | the logic |
| `koverVerifyDebug` | a change that deletes tests |
| `verifyRoborazziDebug` | a visual change nobody looked at |
| `assembleDebug` + `check-merged-manifest.mjs` | a manifest merge that drops the widget, the share target or the deep links |
| `assembleDebugAndroidTest` | a broken instrumented test source, without an emulator |
| `assembleRelease` + `lintRelease` | an R8 rule that strips something the app needs at runtime |
| `bundleRelease` + `abi-size-report.py` | a dependency that doubles the download |

### Baselines

Three of these carry a checked-in baseline, because turning a gate on across an
existing codebase otherwise means either a thousand-file fix or a gate switched
off:

- `android/app/lint-baseline.xml`
- `android/config/detekt/baseline.xml`
- spotless has no baseline file; it **ratchets** against `origin/main`, so only
  files you touched are checked. `SPOTLESS_RATCHET=off` for a checkout with no
  `origin/main`.

Regenerate with `npm run android:baseline`. Do it **in the same commit as
whatever fixed the findings**. A baseline refreshed on its own is a gate turned
off quietly, which is the failure mode all three are trying to avoid.

The coverage floor works the same way: `koverLineFloor` in
`app/build.gradle.kts` is set to the measured number, not to an aspiration.
Raise it in the same commit as the tests that earned it.

### Screenshot goldens

`app/src/test/screenshots/*.png` are recorded on whoever ran
`npm run android:screenshots:record`. Robolectric's native graphics ship their
own font stack, so the output is much more portable than a device screenshot,
but antialiasing can still differ between a Windows checkout and the Linux CI
runner — so the CI step is `continue-on-error` for now. To make it a real gate:
run **Android CI** from the Actions tab with `record_screenshots: true`, download
the `roborazzi-goldens` artifact, commit it, and delete the `continue-on-error`
line. Nothing else has to change.

CI: `.github/workflows/android-ci.yml` runs all of the above on every push/PR
touching `android/**` (the ubuntu image ships the SDK).

## Package map

Only packages that **exist and contain code**. The earlier version of this table
listed `grading` / `inventory` / `marketplaces` / `money` / `billing` before any of
them had a single `.kt` file, which read as a finished architecture to anyone who
opened the project (US-2015). Add a row when the code lands, not before.

| Package (`com.gradethread.app.…`) | iOS counterpart | Owns |
|---|---|---|
| `auth` | `Auth/` | PKCE sign-in/up, session store, auth-state Flow |
| `sync` | `Persistence/` + sync engine | Room cache, delta pull, mutation queue + replay, Realtime, delete reconcile |
| `capture` | `Capture/` | CameraX intake, staged uploads, capture drafts |
| `upload` | `Upload/` | WorkManager photo uploads, signed URLs |
| `ai` | `AIExtract/` | attribute extraction + review sheet |
| `vision` / `speech` | on-device ML | ML Kit OCR + barcode, dictation |
| `snap` | `Snap/` | Snap-to-Value free grade |
| `grading` | `Grading/` | validate/submit/poll, reports, certificates, disputes, bulk |
| `inventory` | `Inventory/` + `DetailsIntake/` + `Measure/` | list, facets, item canvas, photos, measurements, comps, eBay aspects, search |
| `marketplaces` | `Marketplaces/` | eBay OAuth connect + multi-account (connect only — no listing lifecycle yet) |
| `money` | `Money/` + `Sales/` + `Dashboard/` | rollups (KPIs, cash flow, aging, ROI, P&L), sales list, expenses |
| `home` | `Dashboard/` + `Onboarding/` | snapshot, sparkline, quick actions, activation checklist |
| `settings` | `Settings/` | profile, plan, preferences, diagnostics, sign-out |
| `billing` | `Billing/` | Play Billing credit packs + FlipDesk subscriptions, paywall, post-signup plan step |
| `plangate` | `PlanGate.swift` | shell-wide 402 upgrade dialog + 80% soft-warning banner |
| `analytics` | `Analytics/` | grade/brand/sell-through/value/ROI rollups, AI narrative, listing performance, community benchmarks |
| `consignment` | `Consignment/` | consignor CRUD (RLS-scoped), per-item split picker, payout report |
| `templates` | `Templates/` | listing-preset CRUD (RLS-scoped), editor, apply-to-composer |
| `scout` | `Scout/` + `Prospect/` | ScoutAI deal finder, in-store photo prospecting, buy-or-walk verdict |
| `verified` | `Verified/` | read-only badge status, requirements checklist, cached-offline standing |
| `passport` | `Passport/` | PII-free pedigree timeline, confidence taxonomy, chain strength |
| `fulfillment` | `Fulfillment/` | shipping queue, tracking entry, mark-shipped (eBay or local, offline-queued) |
| `platform` | `Networking/` + `Telemetry/` | EdgeAPI, Supabase, Sentry/PostHog, workspace scope, app lock, FCM push |

## Play Billing (US-1338, US-1366)

The client never decides an entitlement. It sends the product id and the purchase
token to `POST /api/payments/google/verify`, which checks the token with Google,
maps it through `ANDROID_CATALOG` in the edge's `lib/google-play/products.ts`, and
grants the plan or the credits. Anything Play-specific sits behind the
`PlayBilling` interface so the whole purchase path runs against `FakePlayBilling`
in a plain JVM test.

**Product ids** must match the Play Console (Monetize → Products) AND the server
catalog exactly. The server fails closed on an unknown id, so a typo is a purchase
the buyer completes and is never credited for. `SubscriptionCatalogTest` and
`CreditTopUpFlowTest` pin both lists.

| Kind | Product ids | Console type |
|---|---|---|
| Subscriptions | `flipdesk_{starter,pro,business}_{monthly,yearly}` | Subscription (one base plan each) |
| Credit packs | `credits_{10,25,50,100}` | One-time product, **consumable** |

**Testing a purchase without spending money.** Play has no local sandbox — a
purchase always goes through a real Play Store on a real signed build:

1. Upload a signed build to an internal-testing track (the app must be published
   to a track before Billing responds at all; an unpublished app returns an empty
   product list, which looks exactly like a typo in the ids).
2. Play Console → Setup → License testing: add the tester's Google account. Their
   purchases are free, renew fast (a monthly sub renews every ~5 minutes), and can
   be refunded from the order page.
3. Install as that account from the internal-testing link, not by sideloading —
   Billing checks the install source.
4. Google's reserved ids (`android.test.purchased` and friends) work only for the
   deprecated AIDL flow and are **not** usable with Billing 7. Use real test SKUs.

**Where the plans are shown.** `PaywallScreen` (route `ShellRoutes.PAYWALL`,
reached from Settings → Plan, Settings → Grading credits, or any plan gate),
`PlanStepHost` (the one-time post-signup step, rendered over the shell and
recorded per ACCOUNT so a shared tablet still asks the second person), and
`PlanGateHost` (the 402 dialog + 80% banner, mounted once above the section
content so a cap hit in any tab reaches the seller).

Settlement rules the tests hold to: consumables are **consumed** (so they can be
bought again), subscriptions are **acknowledged** (Play auto-refunds an
unacknowledged purchase after three days), and NEITHER happens until the server
has confirmed the grant.

## Push (US-1378)

There is deliberately **no `google-services` Gradle plugin and no
`google-services.json`**. That plugin fails the build outright when the file is
absent, which would stop anyone building this app without Firebase credentials
that aren't ours to commit. Firebase is initialized by hand in `PushConfig` from
four BuildConfig values — `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`,
`FIREBASE_API_KEY`, `FIREBASE_SENDER_ID` — supplied like every other secret (CI
env var, then `local.properties`). **All four or none:** a half-configured client
initializes fine and then fails on the first token request. An unconfigured build
simply has no push, the same DSN-gated shape Sentry uses.

Tokens register at `POST /api/notifications/register` with `platform=fcm` on
every cold start (the route is idempotent, and the server prunes stale tokens —
a client that only registered on rotation would never come back). Sign-out
`DELETE`s the token **before** clearing the session, since unregistering needs
that session to authenticate.

Five channels, not one per category: `money`, `selling`, `grading`, `urgent`,
`updates`. Only `urgent` (an expiring eBay token) bypasses Do Not Disturb.
POST_NOTIFICATIONS is requested at a **money moment** (first sale / first grade),
never at launch — Android auto-denies the second dialog, so there is one real ask.

## Background refresh (US-1379)

A `PeriodicWorkRequest` (30 minutes, 10-minute flex, `CONNECTED` +
`requiresBatteryNotLow`) runs the same pull the foreground uses, then compares
what arrived against a stored baseline and posts a local notification for
anything new. `sync/BackgroundRefresh.kt` holds every decision and is pure, so
the part that runs with nobody watching is the part under test.

Three rules that are not obvious:

- **No baseline, no notifications.** `baselineEstablished` is tracked separately
  from the id sets being empty, because "brand-new account with no sales" and
  "never baselined" are different states. Conflating them is how a first sync
  announces an entire back catalogue.
- **The baseline is written AFTER posting.** A crash between the two re-notifies.
  A duplicate is a nuisance; a missed sale alert is the thing this prevents.
- **Past three findings it collapses to one summary.** A wall of notifications
  teaches people to swipe the lot away unread.

`ExistingPeriodicWorkPolicy.KEEP` on every cold start doubles as the reboot
rescheduler (WorkManager restores its own queue), and REPLACE would reset the
period each launch so a frequent user would never reach a run. Settings has a
toggle that moves the stored flag and the schedule together; sign-out clears the
baseline so the next account doesn't inherit the previous seller's.

## Home-screen widget (US-1380)

Glance, in `widget/`. The app computes a small rollup after every sync and
writes it to one DataStore key; the widget only ever reads it back. **No Room
and no network at render** — a widget draw runs on the system's schedule with a
hard budget, and anything slow shows up as a blank tile.

iOS needs an App Group container because its widget is a separate process.
Glance runs inside the app process, so a plain DataStore is enough — no shared
container, no extra entitlement. One JSON blob rather than seven keys, so a read
is atomic; half-updated numbers are worse than slightly old ones.

`WidgetPublisher.decide` is the coalescing rule and is pure: identical numbers
publish nothing at all, and a change landing inside the 30-second window is
stored but held. Unlike iOS, which drops the held reload, Android schedules a
`WidgetReloadWorker` for the rest of the window — otherwise a change one second
after a reload is stranded until the next sync.

Taps go through `com.gradethread.app://widget/…` (US-1314's grammar), not the
https app link: an unverified app link falls back to a browser chooser, and a
seller tapping their own sales figure should never be asked which app to open.

Sign-out **overwrites** the snapshot with the signed-out placeholder rather than
deleting it. Deleting leaves the store empty, which is indistinguishable from
"never published", so the next publish would redraw every widget for nothing.
Signed-out is also deliberately distinct from an all-zero signed-in snapshot,
which is a real seller having a quiet day.

TalkBack labels are composed in `WidgetCopy` rather than inline, because a
Glance composable cannot be asserted from a JVM test and the spoken label is the
only version of this widget some sellers ever get.

## Shortcuts, icons, Assistant (US-1381)

Two **static** long-press shortcuts (`res/xml/shortcuts.xml`): Snap to Value and
Add an item. Static because neither needs state to decide, so a fresh install
has them before the first sync. One **dynamic** shortcut, pushed by
`AppShortcuts.refresh` from the same publish moment as the widget: "what sold
today", whose LABEL is the answer. Android has no spoken-return equivalent of
the iOS intent, but a label read off the long-press menu needs no launch, no
auth and no network — which is what the acceptance criterion is actually asking
for. `SoldTodaySummary` composes it from the same snapshot the widget renders,
so the two can never disagree.

**Shortcut links use `com.gradethread.app://shortcut/…`, never the https App
Link.** Two reasons, both load-bearing: `res/xml` is not processed for manifest
placeholders, so a static shortcut's `targetPackage` cannot follow the debug
build's `.debug` applicationId suffix; and an App Link is only *verified* on the
release build, so an https shortcut opens a browser on a debug build. The
`shortcut` host is deliberately separate from the widget's `widget` host.

The `<capability>` block declares the Assistant App Action and binds the three
shortcuts to it as inline inventory. Declaring it is the whole of what the repo
can do — Assistant only surfaces a capability for a published app.

**Icons landed here too, because there were none.** `PushNotifier` referenced
`R.mipmap.ic_launcher` against a `res/` tree that contained no drawable or
mipmap at all, and the manifest had no `android:icon` — an unbuildable state
that had not surfaced because `android-ci` only runs on `main` and on PRs. The
adaptive icon lives in `mipmap-anydpi` **without** a `-v26` qualifier: minSdk is
26, so the element always parses, and a version-qualified folder with no
unqualified fallback is a resource with no default declaration. The status-bar
icon is now a silhouette (`ic_notification`), not the launcher icon — Android
masks every small icon to white, so a full-colour one renders as a blob.

## Share target → intake (US-1382)

"Share to GradeThread" from any gallery. `ShareTargetActivity` stages the
photos and finishes; `IntakeDrainer` folds them into the capture draft on the
next foreground. Its own Activity, not a shell route — the system hands a share
to a component and expects it back promptly.

**Files are copied, not referenced.** A `content://` read grant dies with the
Activity that received it, so a stored Uri would be unreadable by the time
anyone opened the app — which is the entire window this feature covers. Every
photo goes through the same `PhotoProcessor` pipeline a camera capture takes,
which matters here more than there: a shared photo carries GPS from wherever it
was taken, usually someone's home.

**The batch is a Room row, not a manifest file.** iOS needs `manifest.json`
because its Share Extension is a separate process writing into an App Group
container it must describe. The Android share target runs in this process and
already has Room, so the row IS the manifest (v5, `intake_batches`).

Three rules that are not obvious:

- **A share never overwrites a photo already taken.** A photo whose slot is
  taken moves to the next free one; only when nothing is free is it dropped, and
  a drop is always reported. Silently replacing frames is indistinguishable from
  the app eating someone's work.
- **The drain consumes the batch either way.** A batch that couldn't be placed
  won't become placeable later, and replaying it every foreground is its own bug.
- **The row goes before the files.** A crash between them leaves orphaned JPEGs,
  which `sweepOrphans` clears. The other order leaves a row pointing at files
  that are gone, which shows an empty intake with no explanation.

Unopened batches are swept after 7 days. Sign-out drops both the rows
(`SessionScope.signOutWipe`) and the files (`IntakeInboxStore.clearAll`). The
share target deliberately does **not** require sign-in: someone shooting a rail
in a thrift store shouldn't lose the photos to a forgotten password.

## Onboarding (US-1384)

Three steps in `onboarding/`: a four-slide carousel, a use-case pick, and a
two-item activation checklist. `OnboardingHost` renders nothing once it has been
seen, so `AppShell` hosts it unconditionally — the same shape `PlanStepHost`
uses. It sits **above** the plan step: asking someone to pick a plan before they
know what the app does is the wrong order.

The use case routes to a first **action**, not a dashboard. A brand-new account
has no data, so landing on empty charts teaches the seller the app is empty.
Reseller → AutoLister, grader → photo capture, store → Marketplaces. Skipping
still records completion and still queues the first-action nudge (US-1178): a
skip is an answer, not a missing one.

Every DataStore key carries a `_v1` suffix. A redesign that wants to re-run
onboarding for existing users bumps the suffix rather than shipping a migration.
`takeFirstAction` reads and clears in the **same** edit, so the two paths that
can trigger routing cannot both fire it. Sign-out clears the store, or the next
account inherits a use case it never chose.

The activation checklist is deliberately short and skippable — a checklist that
blocks the app is a wall in front of someone who hasn't seen it work. Two rules
in it are not obvious: the notifications row **disappears entirely** below
Android 13, where there is no runtime grant to give and a button could not do
anything; and once the permission has been asked, the row stays visible but is
not tappable, because Android auto-denies the second dialog and a live button
there would do nothing and look broken. Done rows stay on the list with a tick —
a list that shortens as you work it looks like things are being taken away.

## Referrals (US-1385)

`referrals/` reads `GET /api/referrals/me`, shares the link via `ACTION_SEND`,
and applies a friend's code through `POST /api/referrals/redeem`. Reached from
Tools.

Three things worth knowing:

- **In-progress is `total − granted`, not `pending + qualified`** (US-1255), so
  the three columns always reconcile even if the server adds a fourth
  `reward_status` this build has never heard of. Clamped at zero.
- **A business rejection is a result; an auth or 5xx failure is thrown.** The
  edge tags each refusal with `error_code`, and `RedeemRejection` turns it into
  specific copy — "that's your own code" beats "that code isn't valid" in front
  of someone who typed their own. A 401 must never read as a bad code.
- **Every wire field is defaulted.** `credits` and `milestones` landed after the
  first clients shipped; a strict decode would take the screen down for a field
  nobody reads.

Copy announces via `announceForAccessibility` **only below Android 13** — 13+
shows its own clipboard toast, so announcing there would double it, and below 13
there is no system feedback at all. The code is spoken character by character;
TalkBack otherwise tries to pronounce `ABCD2345` as a word.

Once you have been referred, the redeem form becomes a sentence. A form that can
only ever be refused is worse than no form.

`EdgeApiError.AccountSuspended` was added here: the edge sends suspension as a
403, which mapped to `Unauthorized`, so a suspended seller was told their session
had expired and sent to sign in again — wrong, and actionable in the wrong
direction.

## Support tickets (US-1386)

`support/` reads `GET /api/support-tickets`, opens one with `POST /`, loads a
thread with `GET /:id`, and replies with `POST /:id/messages`. Reached from
Tools, and from a `support.reply` push — `DeepLinkRoute.SupportTickets` now
resolves to the real thread instead of falling back to Settings, which dropped
the seller on a preferences screen with no reply in sight.

Four decisions worth keeping:

- **The character caps are duplicated on purpose.** The edge *slices* past its
  own cap rather than refusing, so a client that allowed more would lose the end
  of what someone wrote in silence. `MAX_SUBJECT`/`MAX_BODY` mirror the server
  exactly, the counter is visible, and the service trims before sending.
- **Open tickets sort above resolved ones.** The server orders by activity
  alone, which buries the one request a seller is waiting on the moment support
  closes a batch of older ones.
- **An unknown status shows itself.** Quietly calling it "Open" would tell
  someone their closed ticket is still being worked; an unrecognised `author`
  is never treated as the seller.
- **A reply to a resolved ticket warns first.** The edge reopens on any user
  reply, and "thanks, that worked" shouldn't put it back in the queue by
  surprise.

Internal notes and agent identities are never modelled — the edge strips both,
and a client type naming them would invite a request for them.

## Feedback (US-1387)

`feedback/` posts to `POST /api/notifications/feedback` from a sheet in
Settings, with app version, Android version and `MANUFACTURER MODEL` attached.

**The category is a message prefix, not a field.** The endpoint has no category
column, and a picker whose value the client drops on the floor is a picker that
does nothing — so it goes where a human triaging the row will read it.
`source` stays `"android"`, because support groups on it.

**The ViewModel is hoisted to `SettingsScreen`, not held inside the sheet.**
That is the whole of AC3: Compose state inside a `ModalBottomSheet` dies with
the sheet, so closing it to go and check a version number would throw away the
draft. The text clears on a successful send and never otherwise — a failed send
that wiped the field would lose the whole report.

Sending confirms for ~1.2s before the sheet closes itself. Closing instantly
reads as nothing having happened, which is how the same feedback gets sent three
times. The confirmation is also announced, since it auto-dismisses.

The sheet says feedback is **one-way** and offers the support inbox (US-1386)
right there. Someone expecting a reply who never gets one concludes nobody read
it.

`app/src/test/java/com/gradethread/app/testing/MainDispatcherRule.kt` landed with
this story — `viewModelScope` runs on `Dispatchers.Main.immediate`, which does
not exist in a plain JVM test, and the resulting failure reads like a bug in the
code under test rather than in the harness. Pass its `dispatcher` to `runTest`
so the body and the ViewModel share one scheduler.

## Workspace switcher (US-1388)

`workspace/` lists the workspaces a user belongs to (`workspace_members` through
the **anon** client, so RLS scopes it) and switches between them. The row lives
in Settings → Account and shows even with one workspace: "whose inventory am I
looking at" is the question it answers, and hiding it when the answer is "yours"
makes that ambiguous right after a member switches back.

**`WorkspaceSwitcher` is the first production caller of
`SessionScope.switchWorkspace`.** That ordering has been written down since
US-1323 with nothing calling it. It matters: queued edits belong to the OLD
tenant so they flush first, and the epoch bump makes an in-flight pull discard
its merge instead of writing the outgoing workspace's rows on top of the
incoming one's. The scope is set **before** the re-pull, because every read
resolves its tenant through `WorkspaceScope`.

Three rules in `Workspaces` (all pure):

- **Personal is always present and always first**, and stores `null` rather than
  your own id — the edge defaults the tenant to the caller, and a header naming
  yourself is a different server path for the same result.
- **A stale selection is dropped on load.** A membership revoked while the app
  was closed leaves an owner id in preferences that every request then sends as
  `X-Workspace-Owner`.
- **A selection with no matching row resolves to nothing, not to personal.**
  Showing "My workspace" while the header still says otherwise would be wrong on
  screen *and* wrong on the wire.

**Known gap, not fixed here:** `rehomeRealtime` is deliberately a no-op.
`RealtimeService.rehome(ownerId)` exists, but nothing in the app constructs a
`RealtimeService` at all, so there is no channel to re-home. Wiring a fake one
would make the switch look like it re-homes realtime when it does not.

## CSV / Sheets import (US-1389)

`importer/`: pick a file → map columns → **preview** → commit. Reached from
Tools. The parser is a port of the web's `src/lib/csv.ts` rather than a library,
so a sheet that imports cleanly on the web imports identically here.

The preview step is the point of the flow. A migration writes hundreds of rows
that are tedious to undo, so nothing is inserted until the seller has seen what
the mapping actually produced — including which rows are being **skipped** and
why, named individually rather than summarised into "12 skipped".

Rules that exist because of real failure modes:

- **Locale-aware prices.** The naive "strip everything but digits and dots"
  reading turns `1.299,00` into `1.29900` — a hundred-fold error in a cost basis
  that then flows into every profit figure. The right-most `.`/`,` is the
  decimal separator (iOS US-1162). An accounting negative `(5.00)` is negative;
  `$20 (sale)` is not.
- **An unknown value is null, never a guess.** An unrecognised status leaves the
  default rather than mapping "pending" → "listed", which would tell a seller
  stock is live when it isn't. An unparseable price is null, not zero — zero is
  a real claim.
- **A BOM is stripped.** Excel/Sheets "CSV UTF-8" prepends one, whitespace
  trimming doesn't remove it, and auto-mapping would silently miss the first
  column.
- **Duplicate SKUs are skipped, not merged**, matching the web import;
  in-batch collisions resolve in sheet order so the first wins.
- **Row numbers are 1-based and count the header**, so an error points at the
  line the seller can see.

Commit inserts row by row, not in one batch: a single bad row would fail
everything and give no clue which line was at fault. A row that fails **because
the device is offline** is enqueued on the offline mutation queue (the same
insert-then-queue path `CapturePublisher` uses) and reported as "waiting to
send", not as a failure — a migration started on a train finishes itself.

## State restoration (US-1390)

`ui/state/Restorable.kt` holds the rules; the screens hold the wiring. Before
this the module had **zero** `rememberSaveable` and **zero** `SavedStateHandle`,
so a ViewModel survived rotation but nothing survived a process kill.

Wired: the Add sheet (`AppShell`), the inventory filter sheet and multi-select
(`InventoryListScreen`), and stage / sort / view mode / query
(`InventoryListViewModel`) plus the global search query
(`GlobalSearchViewModel`) through `SavedStateHandle`. A restored search query
**re-runs** rather than only repopulating the field — results live in memory and
died with the process, so the box would otherwise show a search with nothing
under it.

Four rules that exist because the failure is invisible until it isn't:

- **Selections are capped at 500 and saved as one string.** Saved state crosses
  a Binder transaction with a shared ~1MB budget; exceeding it throws
  `TransactionTooLargeException`, which on rotation is a *crash*, not a lost
  selection. A string rather than a `List` because `rememberSaveable`'s default
  saver only accepts what a `Bundle` accepts.
- **Restoring prunes ids that are gone.** A process death can be days later, and
  a sync in between may have removed items — a selection carrying ghosts turns
  "delete 12" into a request the server rejects halfway through.
- **Enums save by name, never by ordinal.** An ordinal shifts the moment anyone
  inserts a case, so a saved "Listed" filter would come back as "Sold" after an
  unrelated edit. An unknown name falls back rather than throwing, so a value
  written by a newer build can't crash an older one.
- **A saved route is checked against the graph.** Restoring a renamed
  destination is a crash on launch for anyone whose app was killed on it.

`layoutChanged` exists so a foldable's hinge animation — which reports a width
change per degree — only triggers work on a real compact↔expanded crossing.

## Realtime (US-1321 built it, US-2367 turned it on)

`RealtimeService` has been complete since US-1321 — owner-scoped channel,
off-main decode, catch-up on every re-subscribe — and had **no caller anywhere
in the app**. So the client had no live updates at all, and nobody noticed,
because the failure mode of missing realtime is "the list is a bit stale", which
is indistinguishable from a slow sync.

`RealtimeCoordinator` is the caller: start on sign-in + foreground, pause on
background, tear down on sign-out. Every decision is in `RealtimeLifecycle` so
it can be tested; the coordinator is only plumbing around it.

Four rules worth knowing:

- **Signed-out and the user's toggle are checked before foreground.** A socket
  open under a session being thrown away is authenticated with a token the
  server is about to reject, and racing that close is not a state to be in.
- **SUBSCRIBING and RECONNECTING count as up.** Otherwise a second foreground
  event opens a duplicate channel for the same rows.
- **The socket is torn down FIRST on sign-out** (`SessionScope.Hooks.stopRealtime`),
  before the cache wipe — an event arriving mid-wipe would write the outgoing
  account's rows into a database being emptied.
- **A workspace switch re-homes only when the channel is up**, and only from
  `WorkspaceSwitcher` (after the wipe, so the catch-up pull is scoped to the new
  tenant). The coordinator watches `WorkspaceScope.events` for the *involuntary*
  revoked path only; re-homing on both would fire once too early and once too
  often.

The catch-up hook is the load-bearing argument to the constructor: Postgres
change events emitted while the socket was down are never replayed by the
server, so every transition into SUBSCRIBED must pull or the gap is lost until
someone refreshes by hand.

## Build, signing and CI (US-1391)

**Signing.** `resolveKeystore()` accepts two shapes because CI and a laptop need
different things: `ANDROID_KEYSTORE_BASE64` (a GitHub secret can only carry
text) or `ANDROID_KEYSTORE_PATH`. Neither is ever committed — `*.jks` and
`*.keystore` are gitignored, and committing one hands anyone who can read the
repo the ability to sign an update to the app.

When the material is absent the release build type gets **no** signing config
rather than failing. An unsigned release APK still proves minification, the R8
rules and the manifest merge work, which is what a fork or an outside PR needs;
a hard failure would make the release lane unrunnable for everyone without the
secret.

**`versionCode` comes from CI** (`ANDROID_VERSION_CODE`, the run number),
defaulting to 1 locally. Play rejects a re-used code outright, and hand-bumping
a literal is how a release lane ends up blocked at the worst possible moment.

**`no-ungated-log.py`** is the Android half of the iOS print guard (US-698).
`android.util.Log` is *not* stripped by R8 unless a rule removes it, so "it's
only debug" isn't true by default and an ungated `Log.d(TAG, response)` can put
a session token or a seller's address into logcat. Allowed shapes: inside
`if (BuildConfig.LOGGING_ENABLED)` / `if (AppConfig.loggingEnabled)`, braced or
not, or routed through `Telemetry`, which redacts. Runs in CI and locally with
no SDK: `python3 android/scripts/no-ungated-log.py`.

**The widget/share-target CI check greps the MERGED manifest.** Both are
components of the same module, so a compile failure isn't the risk — a manifest
merge silently dropping one is, and that produces a green build with no widget
in the picker and no entry in the share sheet.

`proguard-rules.pro` carries only what this app's own shape needs: the
kotlinx-serialization keeps (every wire model is `@Serializable`, and R8 cannot
see the reflective `$$serializer` reference, so stripping them turns every
decode into a runtime `SerializationException` that does not exist in debug),
the enum `values`/`valueOf` keeps that US-1390's save-by-name relies on, and
`-dontwarn` for the server-side classes Ktor references but Android never loads.

## Play release (US-1392)

`.github/workflows/android-release.yml` builds a **signed AAB** and uploads it
through fastlane `supply`. Secrets come from Infisical, the same way
`ios-release.yml` gets them — only the three `INFISICAL_*` values live in GitHub
Actions secrets.

**Triggers are an `android-v*` tag or a manual dispatch, deliberately not every
push to main.** The iOS lane can auto-cut a TestFlight build because TestFlight
has no review queue; Play's internal track shares a version-code space with
production, so an upload per merge burns codes and fills the Console with builds
nobody asked for.

Four decisions worth keeping:

- **The service-account JSON is passed as content, never a path.** Writing it to
  disk to satisfy a path argument leaves the Play publishing key on the runner
  filesystem for the rest of the job. The Fastfile parses it up front so a
  truncated secret fails in seconds rather than mid-upload with a message that
  doesn't name the cause.
- **The workflow greps the AAB for a signature before uploading.**
  `bundleRelease` succeeds with no signing config — deliberate for PR builds —
  and Play would otherwise reject the unsigned bundle twenty minutes later with
  an error that never mentions signing.
- **Production uploads as a `draft`.** It is the one track where an automated
  100% rollout is unrecoverable: Play has no un-publish, only a halt that leaves
  the bad build on every device that already took it. A human rolls it out.
- **Changelogs are written text, not `changelog_from_git_commit`.** Play shows
  the changelog to every tester, and raw commit subjects leak internal story ids
  and half-finished work.

The R8 mapping is uploaded to Play *and* kept as a 90-day artifact — without it
every Play Console crash report for that build is unreadable, and it only exists
on the runner.

Metadata lives in `android/fastlane/metadata/android/en-US/` and rides along on
every upload, so the listing can't drift from the binary that's live. Drop
screenshots into `images/phoneScreenshots/` named `1_*.png`, `2_*.png` — they
upload in filename order.

**Operator dependency, not code:** the Play Console app record and the
subscription/SKU catalog still have to be created by hand in the Console,
mirroring the App Store catalog. Nothing in this repo can do that.

### Download size and ABIs (US-2150)

ML Kit's text recogniser is a **native** pipeline
(`libmlkit_google_ocr_pipeline.so`, ~11MB) and the barcode scanner is another
(`libbarhopper_v3.so`, ~5MB). A native library exists once **per ABI**, so
adding text recognition took the universal debug APK from 45MB to 87MB — and
nothing in the build said a word about it. (The Japanese script model is only
~1.8MB of *assets*; dropping it is not the fix, because Latin needs the same
native pipeline.)

Three things hold the size down, and each does a different job:

- **`ndk { abiFilters }` decides what gets built.** `armeabi-v7a`, `arm64-v8a`
  and `x86_64` only. `x86` (32-bit) is gone — no phone has shipped it in a
  decade and the only thing that ran it was an old emulator image. `x86_64`
  **stays**: it is the arch the instrumented lane emulates, and removing it
  would make `connectedDebugAndroidTest` fail to install.
- **The App Bundle decides what gets downloaded.** Play splits the AAB and
  sends each device the one ABI it can run. That is a distribution property; no
  amount of app code can substitute for it, which is why the release artifact is
  `bundleRelease` and never a universal APK.
- **`android/scripts/abi-size-report.py` decides whether anyone notices.** The
  bundle fixed today's download; it does nothing about the next model
  dependency landing the same way. The script reads the AAB as a zip, adds up
  each `lib/<abi>/` slice plus the shared remainder, prints the table into the
  job summary, and **fails the build** against `android/abi-size-budget.json`.
  An ABI that is built but unbudgeted is an error too — an unwatched ABI is the
  hole the script exists to close.

Sizes are measured **compressed**, deflating any entry the bundle stores raw:
native libraries are often STORED in an AAB and recompressed by Play on the way
out, so counting them at their on-disk size would overstate the download by
roughly 2x. They are estimates, deliberately — bundletool would be exact but
needs a jar download and a signing key in CI, and the job here is to catch a
*doubling*, which an estimate that is consistently a few percent off catches
just as well.

```bash
./gradlew bundleRelease
python3 android/scripts/abi-size-report.py
```

Raising a budget is allowed. Do it **in the same commit** as whatever bought
the megabytes, and say in the message what that was.

**The `language` bundle split is deliberately OFF.** The app has an in-app
language picker (`AppLocale.SUPPORTED` + `res/xml/locales_config.xml`); with
language splits on, Play ships only the device's language and every other one
silently falls back to English the moment someone switches. Strings are
kilobytes.

## Localization (US-1393)

**Scoped, not big-bang.** `android/scripts/no-bare-strings.py` enforces
`stringResource` for the files named in its `SCOPE` list, and that list grows as
screens convert. A guard covering all ~90 Compose files today would either fail
everywhere or get switched off, and a switched-off guard protects nothing.
Thirty-nine files are converted and locked. US-1393 did onboarding, referrals, both
support screens, feedback, the workspace switcher and the importer; US-2369 did
sign-in; US-2368 has since done home, money, settings, snap, analytics,
automations, the drafts library, the negotiation inbox, templates, marketplaces,
reconciliation, the publish sheet, repricing, details intake, tools, prospect,
the item canvas, the grade request, the AI-fill sheet, the grade report,
consignors, post-sale, bulk grade, the inventory list, promotions, community
insights, item photos, global search, disclosure, scout and bulk pricing. The guard also fails if a scoped file
is renamed or deleted, so nothing drops out silently.

**The guard reads two shapes, and the second one is the common one.** ktlint
wraps any argument list past 100 columns, so most real call sites look like
`Text(` on one line and `"Copy"` on the next. The original rule only matched the
single-line form, and roughly ninety literals sat undetected inside files it
reported as clean — every one of them wrapped. It now also matches an argument
name or opening paren at end-of-line followed by a literal, skipping comments in
between.

**The sink list includes this project's own composables**, not just Material
ones: `Hint`, `NumberField`, `Field`, `Panel`, `PanelHeader`, `SectionHeader`
and `InfoCard` all take text and render it. A guard that only knew `Text(` would
call a screen clean while every one of its form labels stayed in English.

**`check-string-formats.py` checks the arity nothing else can.** A
`stringResource(R.string.x, a)` call against a resource holding two placeholders
compiles, passes lint, and throws `MissingFormatArgumentException` when that
screen is drawn — in whichever language the extra placeholder lives in. The
script walks every call site, balances the parens, and compares the argument
count to the resource. It also checks that every quantity form of a `<plurals>`
takes the SAME arguments: a translator who adds a `few` form and drops a
placeholder crashes the app in that language only, which is nowhere a test
written in English would ever look. A call with NO format arguments is allowed on purpose: it
reads the raw template so it can be `.format(...)`ed inside a `joinToString`
lambda, which is not a composable scope and so cannot call `stringResource` at
all. The same script also rejects duplicate resource names: aapt2 kills the
build on those, and its message does not name where the second one came from.

**`%%` vs `%` is decided by whether the call passes format arguments.** A
resource read with arguments collapses `%%` to one `%`; a resource read with
none never runs through the formatter, so `%%` reaches the screen literally.
`negotiation_discount` takes an argument and uses `%%`;
`automations_field_margin_floor` takes none and uses a single `%`.

**Plurals are real `<plurals>`, not templates.** `"$n rows"` renders "1 rows",
and every language past English has more than two forms. The specific
construction to look for is `"credit${if (n == 1) "" else "s"}"` — it reads as
careful code and is the exact thing that cannot survive translation. Nine of
these have been replaced so far.

**A bare number format is not copy.** `"%.1f"` has no words in it, so the guard
exempts a literal that is nothing but a format specifier. Moving one into
`strings.xml` does not help anybody translate anything; it just puts a format
string somewhere a translator can edit it.

**The in-app language picker** goes through `AppCompatDelegate.setApplicationLocales`
— the one API that spans Android 13+ (system per-app language store) and below
(AppCompat persists it itself, which is what the `AppLocalesMetadataHolderService`
entry in the manifest is for; without it the choice reverts on the next cold
start and reads as the setting not working). `AppLocale.SUPPORTED`,
`res/xml/locales_config.xml` and the `values-<tag>/` directories move together:
a language offered with no strings behind it is worse than one not offered,
because the picker changes nothing. The row hides itself while only one language
ships.

**Pseudolocales are the debug build type's `isPseudoLocalesEnabled`**, giving
en-XA (accented, ~30% longer) and en-XB (RTL mirror) for clipping QA. Debug only
— they're the real Android mechanism rather than a hand-written `values-xx`, and
shipping them would put them in the Play language list.

One thing deliberately NOT converted: pure copy objects like `WidgetCopy` and
`SoldTodaySummary` build sentences outside a Compose scope and are unit-tested
against their exact wording. Moving them to resources needs a `Context` and
breaks both properties. `Onboarding.primaryLabel` shows the pattern for when it
*is* worth it — it returns a `@StringRes` id, so the rule stays pure and
testable while the words become translatable.

## Tests (US-1395)

**Unit:** 134 JVM test files covering sync/conflict resolution, the mutation
queue and its ordering, delete reconciliation, terminal-error classification,
the Money/Analytics/Dashboard rollups, plan-gate parsing, and the full billing
path against `FakePlayBilling`. Run with `./gradlew testDebugUnitTest`.

**Instrumented:** `app/src/androidTest/` — a real emulator lane, which is the
half that did not exist. `HiltTestRunner` swaps `GradeThreadApp` for
`HiltTestApplication`: the real one validates config, starts sync, opens a
socket, registers for push and schedules work, so a UI test running it would be
an integration test against production and would fail for reasons unrelated to
the diff.

Two tests, both aimed at what no JVM test can reach — **the real Hilt graph**. A
missing `@Binds`, a `@Provides` that throws, a circular dependency or a crash in
a ViewModel `init` all compile perfectly and fail only when Dagger assembles on
a device. `AppLaunchTest` proves the shell mounts and the Add sheet opens;
`SettingsRendersTest` covers the screen with the most injected dependencies
(auth, Supabase, Room, push, background refresh, onboarding, realtime, plus the
feedback and workspace ViewModels).

**The emulator job is `continue-on-error: true` on purpose.** An emulator is
flaky in ways unrelated to the diff — a KVM-less runner, a cold image, an ANR
under load — and a required-but-flaky check trains everyone to re-run until
green, which is worse than not having it. The blocking lane still runs
`assembleDebugAndroidTest`, so a genuinely broken test source fails there rather
than hiding behind a red X people learn to ignore.

`SignInValidationTest` covers the validation path US-1395 named — it became
writable once US-2369 added the screen. Paywall product rendering and the
test-SKU purchase stay covered by `PaywallPricingTest`, `SubscriptionServiceTest`
and `BillingRepositoryTest` against `FakePlayBilling` rather than duplicated on
an emulator.

Anything gated on a **session** cannot be instrumented yet: the emulator has no
credentials, so a signed-in surface would be a flake rather than a check. That
is why `SettingsRendersTest` was removed when the auth gate landed rather than
left failing.

## Sign in (US-2369)

`MainActivity` used to compose `AppShell` **unconditionally**, so the app was
unusable by anyone not already holding a session — and every piece of auth
plumbing underneath (PKCE, the classified `FriendlyAuthError` cases, the OAuth
callback) had no surface to reach it from. It now switches on
`AuthRepository.phase`.

`Loading` renders **nothing**, not the form. The session restores from encrypted
storage in milliseconds, and a sign-in screen that appears and vanishes on every
cold start reads as a bug.

`AuthFormRules` mirrors `src/lib/password-policy.ts` and
`supabase/config.toml` (`minimum_password_length = 10`,
`lower_upper_letters_digits`). Three rules worth naming:

- **The password policy applies on sign-UP only.** Enforcing today's rule
  against an existing password locks out anyone who created their account before
  it tightened, and refuses them with a message about the *rule* rather than
  letting the server say "wrong password".
- **Email validation is deliberately loose.** An RFC-complete pattern rejects
  real addresses, and the server verifies by sending to it — which is the only
  check that proves anything. This catches a missing `@` and a missing dot.
- **Every classified failure that has a next step offers it** as a button:
  resend confirmation, reset password, or switch to sign-in for an address that
  already has an account. "That didn't work" with no next step is where people
  give up. The password reset never says whether the account exists, so the form
  can't be used as an account-existence oracle.

## Non-negotiables carried from iOS (see the plan's "hard parts")

- Offline sync invariants: watermark reset BEFORE row wipe on sign-out;
  create-before-edit replay ordering; deletes reconciled explicitly.
- Every client-minted UUID is **lowercased** at creation (Postgres normalizes;
  case-mismatched ids caused duplicate-item sync bugs on iOS).
- Plan-gate: 402 body + `X-Plan-Warning` header intercepted on EVERY response.
- Photo presence = the `photos` relation, never the denormalized cover URL.
- Only COMPLETED sales count toward any money figure (migration `00111`), and
  every profit number nets through `money/SalePnL.kt` — the one definition shared
  with iOS's `GradeThreadCore/SalePnL.swift` and the web's `src/lib/pnl.ts`.
- Money sums go through `money/Money.kt` (BigDecimal, HALF_UP), never
  `sumOf { }` — float drift passes a cent on the set sizes a real seller has.

### A caution about wiring, learned twice here

Three subsystems were built, unit-tested, and then never called: the sync pull
primitives (US-2151), the mutation-queue drain, and `SessionScope.signOutWipe`.
Each looked complete — the tests passed and the code was right — but nothing in
production invoked them, so Room stayed empty, offline edits never reached the
server, and sign-out left the previous account's data on the device. When you add
a component here, **grep for a production caller before calling it done.**
