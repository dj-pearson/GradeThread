package com.gradethread.app.money

import androidx.annotation.StringRes
import androidx.compose.runtime.Immutable

/**
 * Something to tell the seller, from a class that cannot reach a Context.
 *
 * ⚠ TWO SOURCES OF COPY, AND ONLY ONE OF THEM IS OURS. [res] is a string we
 * wrote, so it lives in strings.xml and translates. [detail] is the SERVER's
 * sentence: we did not write it, cannot localize it, and must not swallow it,
 * because it is often the only thing that says what actually went wrong.
 *
 * The renderer shows detail when there is one and the resource otherwise, so a
 * server that says nothing still produces a sentence rather than a blank
 * banner. android/scripts/no-unlocalized-copy.py is what makes this necessary:
 * a ViewModel returning English reaches a Spanish seller untranslated.
 */
@Immutable
data class UiMessage(@StringRes val res: Int, val detail: String? = null)
