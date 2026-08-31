package com.gradethread.app.ui

import android.content.Context
import androidx.annotation.StringRes
import com.gradethread.app.R
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
    // US-2976: an argument may itself be a UiMessage - "Measure: %1$s"
    // wraps a measurement name that is a resource in its own right, and
    // which of the two is the fallback differs per key. `map` is inline,
    // so the nested text() stays in a composable scope.
    val resolved = args.map { if (it is UiMessage) it.text() else it }.toTypedArray()
    val count = quantity ?: return stringResource(res, *resolved)
    return pluralStringResource(res, count, *resolved)
}

/**
 * The same sentence, for a caller with no composition.
 *
 * US-2976: a launcher shortcut label is composed with the app closed and
 * rendered by another process, and a widget and a notification are the same
 * shape - so the type needs a renderer that only wants a Context. The two must
 * stay in lockstep, which is why this one lives beside the composable rather
 * than being hand-rolled wherever a Context happens to be in scope.
 */
fun UiMessage.text(context: Context): String {
    detail?.let { return it }
    val resolved = args.map { if (it is UiMessage) it.text(context) else it }.toTypedArray()
    val count = quantity ?: return context.getString(res, *resolved)
    return context.resources.getQuantityString(res, count, *resolved)
}

/**
 * Several facts on one line, joined by the separator for the reader's language.
 *
 * US-2976: the import summary built its line with `buildString` and a run of
 * `if (x > 0) append(" - N skipped")`. That is not one sentence, it is a LIST,
 * and a list assembled with += cannot be translated: each clause needs its own
 * plural, and the separator itself is a typographic choice a language gets to
 * make. So the clauses stay separate UiMessages and the join is a resource.
 *
 * Up to four parts, which is every caller today. A fifth would need a fifth
 * resource rather than silently dropping one, so [join] throws instead.
 */
fun joinMessages(parts: List<UiMessage>): UiMessage {
    if (parts.isEmpty()) error("joinMessages needs at least one part")
    if (parts.size == 1) return parts[0]
    val res = JOIN_RES.getOrNull(parts.size - 2)
        ?: error("joinMessages joins at most ${JOIN_RES.size + 1} parts, got ${parts.size}")
    return UiMessage(res, args = parts)
}

/** Indexed by `partCount - 2`: adding a fifth means adding a fifth resource. */
private val JOIN_RES = intArrayOf(
    R.string.ui_join_2,
    R.string.ui_join_3,
    R.string.ui_join_4,
)
