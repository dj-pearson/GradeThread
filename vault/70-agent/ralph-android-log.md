---
title: Ralph Android working log
type: learning
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-08-09
tags: [agent, ralph, android]
summary: Traps from the Android conversion backlog (US-1299…US-1396); read when a story touches android/.
---

> [!info] Read ON DEMAND, not every iteration.
> Split out of [[ralph-learnings]] by US-2445, which had grown to 892 lines
> against its own 800-line rule. Nothing here was deleted or reworded — it is
> the same text, one hop away instead of on every loop iteration.
>
> Read this when your story touches `android/`. The web verify lanes never
> exercise Kotlin, so they are not evidence for these stories.

# Android conversion backlog (US-1299…US-1396)

- The Android client is REAL and this host CAN build it. `android/` is tracked
  (100+ `*.kt`, Gradle wrapper, `android-ci.yml`) and the Windows loop host has
  the toolchain (scoop temurin17-jdk + gradle; `local.properties` → `sdk.dir`).
  US-1300+ stories ARE implementable and verifiable here — US-1321…US-1328 each
  landed real `feat(android)` code. The "Device/Android-toolchain-gated" tag in
  the story `notes` predates the scaffold and is NOT a reason to refuse a story.
  (This supersedes the old "no `android/` dir, no SDK/Gradle" note, which was
  true only before 2026-06 — do not restore it without re-checking `git ls-files
  android`.)
- Verify Android work from `android/` with
  `./gradlew assembleDebug testDebugUnitTest lintDebug` (mirrors android-ci.yml).
  The web steps (tsc/build:locked/vitest) NEVER exercise Kotlin, so they are not
  sufficient evidence for these stories.
- A build script that does not COMPILE hides every other defect behind it, and
  the Kotlin DSL has one trap that produces exactly that: inside
  `build.gradle.kts` the identifier `java` resolves to the JavaPluginExtension
  accessor, so a fully-qualified `java.util.Base64` fails with `Unresolved
  reference: util` and takes the WHOLE android module down. Import the class
  instead. US-2150 found this on `main`, and behind it: 16 Kotlin errors (9 of
  them `stringResource` inside a `Modifier.semantics { }` lambda, which is not a
  composable scope — hoist it to a `val` above the call), 10 failing unit tests
  and a lint error, none of which any lane could report while configuration was
  broken. So: when an Android story's first build fails in CONFIGURATION, expect
  the compile/test/lint state underneath to be unknown rather than green, and
  budget for finding out.
- `check-string-formats.py` counts a `stringResource(...)` call's arguments by
  LINE, so a `//` comment written between the resource id and the arguments is
  counted as an argument and the call is reported as passing more than the
  resource declares. Put the explanation above the call, not inside it.
- Still genuinely ungated-able: emulator/device-only ACs (e.g. US-1396
  accessibility audit) presuppose a running app on a device. Don't fabricate an
  audit/test result — leave a note and stop without emitting STORY_DONE.
- A drift guard between the two CODE copies of a product catalog leaves the third
  copy, the STORE CONSOLE, pinned only by the operator doc someone types from.
  US-3138 added four Action Credit packs to `ANDROID_CATALOG` and `CreditPacks.kt`,
  `android-catalog-drift_test` stayed green, and both Play operator docs went on
  saying ten products. Play omits an id it does not have from the catalog response
  instead of erroring (`PlayBilling`: "Missing ids are simply absent"), so the
  consequence is an empty top-up sheet on a signed release with every lane green.
  Pin the operator TABLE to the catalog: US-2913's
  `play-console-product-doc_test.ts` does it as pure functions over markdown text,
  so the sabotage cases are string literals. **The iOS twin still has this gap** —
  `ios/APP_STORE_SUBMISSION.md` §6 lists the subscriptions and grade credits and
  has never listed `com.gradethread.actions.*`.

## Related

- [[ralph-learnings]] — the always-read playbook
- [[ios-traps-only-ci-catches]] — the same shape on the iOS side
- [[INDEX]]
