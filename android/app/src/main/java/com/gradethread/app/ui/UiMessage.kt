package com.gradethread.app.ui

import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource

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
data class UiMessage(
    @StringRes val res: Int,
    val detail: String? = null,
    /**
     * Format arguments for [res], when it takes any.
     *
     * US-2976: added for the Scout plan wall, whose sentence is ours and whose
     * PLAN NAME comes from the server - "ScoutAI is a Pro feature". A server
     * noun to substitute is not the same thing as a server sentence to prefer,
     * and [detail] is only the latter.
     */
    val args: List<Any> = emptyList(),
    /**
     * The count that picks a plural form, when [res] is a PLURALS resource.
     *
     * US-2976: three screens had each grown their own `res + count` pair
     * within a day of one another. One shape means one renderer, and a
     * screen cannot call stringResource on a plurals id by accident.
     */
    val quantity: Int? = null,
)

/**
 * The sentence to show: the server's when there is one, ours otherwise.
 *
 * The precedence is the whole point of the type, so it belongs here once
 * rather than at every call site - a screen that forgets `detail ?:` throws
 * away the only line saying what actually went wrong.
 */
@Composable
fun UiMessage.text(): String {
    detail?.let { return it }
    val count = quantity ?: return stringResource(res, *args.toTypedArray())
    return pluralStringResource(res, count, *args.toTypedArray())
}
