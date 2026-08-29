package com.gradethread.app.ui

/**
 * US-2902 AC4: stable handles for UI tests, so a test does not depend on copy.
 *
 * WHY THIS EXISTS. There were zero `testTag` calls in this app, so the only way
 * to find a node from an instrumented test was `onNodeWithText("Sign in")` —
 * the English display string. Two things make that a trap here rather than
 * merely fragile:
 *
 *  1. The copy is actively moving. US-2908, US-2976 and the unlocalized-copy
 *     ratchet are converting literals to string resources across the app, and a
 *     resource can be re-worded without anyone thinking about a test.
 *  2. The app ships Spanish. A test matching an English string asserts on the
 *     device locale as much as on the screen.
 *
 * A tag is neither. It is invisible to a person, unaffected by translation, and
 * changing one is an obvious edit to a test-facing constant rather than a
 * side effect of rewording a button.
 *
 * KEPT IN MAIN, NOT androidTest, ON PURPOSE. Both the screen and the test have
 * to agree, and a constant either side of that boundary is two constants. This
 * costs a handful of strings in the release binary and removes the only failure
 * mode that matters — the screen tagging one thing while the test looks for
 * another, which fails as "element not found" and reads as a broken app.
 *
 * Tags are only worth adding where a test needs a handle. This is not a list of
 * every element; it grows when a test needs it to.
 */
object TestTags {

    /** The signed-out landing surface (`AuthScreen`). */
    object Auth {
        /** The root, so "did the app get here at all" is one assertion. */
        const val SCREEN = "auth:screen"
        const val EMAIL = "auth:email"
        const val PASSWORD = "auth:password"

        /** The submit control — Sign in or Create account, per mode. */
        const val SUBMIT = "auth:submit"

        /** The sign-in / sign-up mode switch beneath it. */
        const val TOGGLE = "auth:toggle"
    }
}
