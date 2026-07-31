# GradeThread Android

Native Kotlin/Compose client, **partway through** the US-1299 conversion backlog.
The iOS app is the behavioural source of truth.
Reference: [`vault/90-archive/android-conversion-plan.md`](../vault/90-archive/android-conversion-plan.md).

## Status — read this before estimating (US-2015)

**This client is NOT at iOS parity.** It previously said it was, next to a package
map for directories that contained no code; both are corrected below. iOS has
~578 Swift files across ~60 feature areas, Android ~250 Kotlin files across ~12.

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
| Glance widgets, onboarding, referrals, feedback, workspaces, CSV import | US-1379–1389 |
| Localization (`values-*`, plurals, locale selector) | US-1393 |

Nothing in that table has an Android implementation — do not treat any of it as
"nearly done" because the offline-sync foundation underneath it is solid.

## Stack (pinned in `gradle/libs.versions.toml`)

Kotlin 2.1.20 · AGP 8.9.2 · Gradle 8.13 (wrapper) · JDK 17 ·
Jetpack Compose (BOM 2025.04) + Material 3 · Hilt · Room · DataStore ·
Navigation-Compose · Coroutines/Flow. minSdk 26, target/compileSdk 35.

## Build

```bash
# Windows dev machines (this repo's loop host): toolchain via scoop —
#   scoop bucket add java && scoop install temurin17-jdk gradle
# local.properties (gitignored) points sdk.dir at the local Android SDK.
./gradlew assembleDebug testDebugUnitTest lintDebug
```

CI: `.github/workflows/android-ci.yml` runs assembleDebug + unit tests + lint
on every push/PR touching `android/**` (ubuntu image ships the SDK).

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
