---
title: iOS traps that only CI can catch
aliases: [curly quote, duplicate version checksums, MainActor constant]
type: learning
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-08-22
tags: [ios, swift, ci, agent]
summary: Swift cannot be compiled on the Windows dev host, so seven specific mistakes cost a full CI cycle each - two actor-isolation shapes, one that bricks launch rather than failing the build, and one that hides every other error behind it.
---

# iOS traps that only CI can catch

**No Swift toolchain exists on the Windows host.** The only local iOS check is a
Python print-guard; macOS CI is the gate for everything else. So each of these
costs a full CI cycle, and grepping for them before pushing is cheaper than
finding out.

## 1. Curly quotes as string *delimiters*

Swift rejects `U+201C`/`U+201D` used as delimiters —
`error: unicode curly quote found` — failing both **iOS CI** and **iOS Release**
at the Archive step.

**Curly quotes *inside* a straight-delimited string are fine**, and this codebase
uses them deliberately in UI copy. Only the opening/closing delimiter breaks. To
keep a real curly quote in displayed text, escape it as `\u{201C}` inside a
straight-quoted string.

Autocorrect and agents reintroduce this periodically. After any bulk edit to
`ios/**/*.swift`:

```bash
grep -rnP '(\(|:\s|==\s|\?\s|,\s)[\x{201C}]|[\x{201D}]\s*(\)|,)' ios/GradeThread --include=*.swift
```

Fix **range-scoped**, so legitimate in-string curly quotes elsewhere survive:

```bash
perl -i -CSD -pe 's/[\x{201C}\x{201D}]/"/g if $. >= START && $. <= END' FILE
```

## 2. A grep hit tells you the file, not the type

`FlipdeskPhotoType` and `PhotoSlotType` live in the **same file**. A hit for a
static reads as belonging to whichever type you had in mind, and the split is
real:

- `PhotoSlotType` — the capture-time KIND (`.tag`, `.defect1`): SF Symbol,
  storage bucket, sensitivity
- `CaptureSlot` (US-2470, `Capture/CaptureSlot.swift`) — a capture-strip
  POSITION: the `(PhotoSlotType, photo_role)` pair plus the profile's label and
  hint. Equality reads only the pair, so `CaptureSlot(.tag) != tag|size`
- `FlipdeskPhotoType` — the persisted server `photo_type` string

Code working from `item_photos` rows wants `FlipdeskPhotoType`. Code holding a
photo the seller is about to take wants `CaptureSlot`; reaching for a bare
`PhotoSlotType` there is how a roled tag shot gets missed (`$0.slot == .tag`
matched none of `tag|brand` / `tag|size` / `tag|care`).

> **Confirm the enclosing `enum`/`struct` of a grep hit, not just the file.** This
> is the Swift instance of a general habit, and it is the one that burns a CI
> cycle because the compiler is elsewhere.

## 3. A plain value type cannot read a constant off an `@MainActor` type

A `struct` referencing a static on a `@MainActor` class is *"main
actor-isolated … cannot be referenced from a nonisolated autoclosure"* — an
**error** under Swift 6, not a warning. It looks like a plain constant read, so
it passes review easily.

### 3a. …and a nonisolated `async` function cannot CALL one either

Same isolation rule, different shape, and the one that actually shipped
(2026-08-17, `Onboarding/UseCaseSync.swift`):

```
error: main actor-isolated static method 'breadcrumb(_:category:)'
       cannot be called from outside of the actor
```

`Telemetry` is `@MainActor` (Telemetry.swift:40), so `Telemetry.breadcrumb` is
reachable only from the main actor. **`Telemetry.backgroundBreadcrumb` is the
nonisolated twin and exists for exactly this** — its own doc comment names the
sync actor and the offline mutation queue as the callers it was written for, and
it logs at `.warning`, which a failure path wants anyway.

Before calling any `@MainActor` helper from an `async` function that is not
itself main-actor, check for a `nonisolated` twin. There were 43 call sites of
the isolated one and 26 of the nonisolated one when this was written, so the
pattern is established and easy to match against.

> [!note] Not worth a grep guard, and that is a considered answer
> Deciding whether a given call site is main-actor-isolated needs real Swift
> scoping — a regex over 43 legitimate call sites and 225 `@MainActor`
> annotations would fire on correct code. A guard that cries wolf on a lane that
> already cannot compile locally gets ignored, which is worse than none.

### 3b. A wrapped `await` binds to the wrong expression

Also from that file, also invisible on Windows:

```swift
// WRONG — `await` covers `SupabaseShared.client` (synchronous); the async
// `.session` access ends up outside it.
guard let id = try? await SupabaseShared.client
    .auth.session.user.id.uuidString

// RIGHT — one line, as every other call site in the app writes it.
guard let id = try? await SupabaseShared.client.auth.session.user.id.uuidString
```

The compiler says *"Expression is 'async' but is not marked with 'await'"*,
naming the file and nothing about the cause. Five call sites (ContentView,
ConsignorService, PublishDialog, AutoListerGenerator, ReconciliationService) all
write it flat; matching one of them verbatim is the strongest check available
without a Mac.

## 4. Duplicate schema checksums brick launch, they do not fail the build

SwiftData hashes a `VersionedSchema`'s resolved model graph. Adding a `V2` whose
`models` list references **the same live `@Model` classes** as V1 — i.e. changing
a model in place and re-listing it — produces an **identical checksum**, and
SwiftData aborts at launch on every device:

```
NSInvalidArgumentException … 'Duplicate version checksums detected.'
```

This happens in the store provider **before any UI mounts**, so UI tests report
the app as never running rather than as failing a screen. It shipped once and
bricked launch.

**To add a genuinely new version:** snapshot the OLD model shape as distinct
nested types inside the old `VersionedSchema` so the two hash differently, then
add the migration stage and repoint `current`. **Pre-production, with no deployed
stores, a model change should just ride the single current version.** Never add a
`VN` that re-lists the live classes.

> Note which gate catches it: the **launch-smoke** step and the UI tests do.
> An archive-only run does not — it builds fine and dies on a device.

## 5. A trailing comma in a parameter list is a 5.9 parse error

Swift allows a trailing comma after the last parameter from **6.1**. This target
builds at `SWIFT_VERSION 5.9`, where it is a parse error - and the compiler
reports it as a bare:

```
Unexpected ',' separator
```

with **no file and no line**. The surrounding log lines are whichever files
happened to be compiling, which is worth nothing. It cost a full cycle to place.

Easy to write, because every other language in the same day allows it and no
formatter removes it. Now guarded: `ios/Scripts/no-trailing-comma.py`, in
`npm run verify` and in `iOS CI`, zero baseline across the app.

## 6. Lifting a view body into a method can rebind a shadowed name

`ItemCanvasView` has `@State private var state: ItemCanvasState?` AND a
`private func form(state: ItemCanvasState)` whose parameter shadows it. Any body
written inside `form(state:)` sees the **non-optional** one.

Extracting such a body into a new method - a routine, mechanical refactor -
silently rebinds `state` to the optional property, and nothing but the Swift
compiler notices. It reads identically in review.

**Before extracting a SwiftUI body into a method, check whether the enclosing
function has a parameter that shadows a stored property of the same name.** If
it does, pass it in explicitly rather than relying on scope. No regex finds
this; a scope check that a regex could do would be wrong. The cheap version is
to diff the enclosing function of every body you move.

## 7. Errors stack, so a fixed lane can still be red for an older reason

The compiler reports **one** error and stops. So a pre-existing break sits
invisible behind whatever was written most recently, and clearing your own
mistakes is what exposes it.

On 2026-08-22 the iOS lanes took four fixes in sequence to go green: two fresh
mistakes, then an `@escaping` mismatch that had failed **every run since
19 Aug**, then a test assertion that had been wrong for longer than that.

The last one is the part to remember. **A suite that cannot run makes a wrong
test look green.** `DisputeFilingTests` searched an encoded body for
`data:image/jpeg;base64,AAA` while `JSONEncoder` writes
`data:image\/jpeg;base64,AAA`. The request was always correct and the assertion
never was; it simply had no opportunity to fail while the app did not compile.

So when a lane goes red after a long red spell, **do not assume the newest
commit owns every error in it.** Check whether the run before yours failed on
the same line - `gh run view <id> --log-failed` on the prior run answers it in
one command, and it is what proved the `@escaping` break was two days old.

## Related

- [[ralph-ios-log]] — other iOS gotchas from the loop
- [[ios-photo-upload]] — the upload pipeline's own hard-won rules
- [[reading-a-red-ci]] — how to read the lane that reports these
- [[INDEX]]
