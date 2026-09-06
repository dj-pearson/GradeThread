package com.gradethread.app.ui

import android.content.Context
import androidx.annotation.PluralsRes
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
@ConsistentCopyVisibility
data class UiMessage private constructor(
    /**
     * A string id when [quantity] is null, a plurals id when it is not.
     *
     * ⚠ DELIBERATELY UNANNOTATED, AND THE CONSTRUCTOR IS PRIVATE BECAUSE OF IT
     * (US-3115). This field held `@StringRes` until the type was documented to
     * carry either kind of id, which made lint right and the class wrong in
     * both directions at once: every plurals caller was an `Expected resource
     * of type string` error, and [text] calling `pluralStringResource(res, …)`
     * was an `Expected resource of type plurals` error on the very same field.
     * 31 errors, and `:app:lintDebug` red on main for anyone.
     *
     * An annotation cannot describe a union, so the checking moved OUT to the
     * two factories below, where each id is checked as its own kind. That is
     * why nothing may construct this directly: a public constructor here is an
     * unchecked back door around both.
     */
    val res: Int,
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
     * The count that picks a plural form. Non-null exactly when [res] is a
     * plurals id, which is what [plural] guarantees and [text] relies on.
     */
    val quantity: Int? = null,
) {
    companion object {
        /**
         * A message from a STRING resource.
         *
         * `operator invoke` rather than a named factory so the 260-odd
         * existing `UiMessage(R.string.x, …)` call sites keep reading the way
         * they always did while gaining the check they never had.
         */
        operator fun invoke(@StringRes res: Int, detail: String? = null, args: List<Any> = emptyList()): UiMessage =
            UiMessage(res, detail, args, null)

        /**
         * A message from a PLURALS resource.
         *
         * [quantity] is required, not defaulted: a plurals id with no count is
         * the bug this split exists to make unrepresentable.
         */
        fun plural(
            @PluralsRes res: Int,
            quantity: Int,
            args: List<Any> = emptyList(),
            detail: String? = null,
        ): UiMessage = UiMessage(res, detail, args, quantity)
    }
}

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
