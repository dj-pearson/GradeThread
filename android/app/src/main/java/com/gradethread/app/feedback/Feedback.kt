package com.gradethread.app.feedback

import androidx.annotation.StringRes
import com.gradethread.app.R

/**
 * US-1387 (iOS `FeedbackSheet`): what a feedback message is, before it is sent.
 *
 * Pure. The interesting rule is [compose]: the server has no category column,
 * so a category the client invents and then drops on the floor would be a
 * picker that does nothing. It goes into the message text, where a human
 * triaging the row will actually read it.
 */
object Feedback {

    /** The server caps at 4000 and SLICES; this is well under, deliberately. */
    const val MAX_MESSAGE = 2000

    /** `source` stays the platform, so support's existing grouping keeps working. */
    const val SOURCE = "android"

    /**
     * US-2976: THREE fields where there were two, and the split is the point.
     *
     * [label] and [hint] are what the seller reads and are string resources.
     * [triage] is what goes in front of the stored message for whoever reads
     * the row, and it stays ENGLISH on purpose - see [compose]. Making the
     * label a resource without adding this would have quietly started filing
     * Spanish bug reports under "[Algo no funciona]", which support cannot
     * group and nobody would notice for months.
     */
    enum class Category(val triage: String, @StringRes val label: Int, @StringRes val hint: Int) {
        BUG("Something's broken", R.string.feedback_category_bug, R.string.feedback_category_bug_hint),
        IDEA("I wish it did…", R.string.feedback_category_idea, R.string.feedback_category_idea_hint),
        PRAISE("This worked well", R.string.feedback_category_praise, R.string.feedback_category_praise_hint),
        OTHER("Something else", R.string.feedback_category_other, R.string.feedback_category_other_hint),
    }

    /**
     * Why this message cannot be sent, as a string resource, or null.
     *
     * The too-long message no longer names the cap. It used to read "keep it
     * under 2000 characters", which needed a format argument for one string and
     * put the number two lines above the live "1998 / 2000" counter that says
     * the same thing better.
     */
    @StringRes
    fun error(message: String): Int? = when {
        message.isBlank() -> R.string.feedback_error_empty
        message.length > MAX_MESSAGE -> R.string.feedback_error_too_long
        else -> null
    }

    fun canSend(message: String, sending: Boolean): Boolean = !sending && error(message) == null

    /**
     * The message as it will be stored.
     *
     * The category is a PREFIX, not a separate field, because the endpoint has
     * nowhere to put one. Trimmed and capped here as well, since the server
     * truncates silently and losing the last paragraph of a bug report is
     * exactly the kind of thing that gets reported as another bug.
     */
    fun compose(category: Category, message: String): String =
        "[${category.triage}] ${message.trim().take(MAX_MESSAGE)}"

    /**
     * Feedback is one-way, and the sheet says so.
     *
     * Someone who expects a reply and never gets one concludes nobody read it.
     * The escalation to a support ticket (US-1386) is offered right there.
     */
    @StringRes
    val ONE_WAY_NOTE: Int = R.string.feedback_one_way_note

    @StringRes
    val SENT: Int = R.string.feedback_sent

    /** How long the confirmation stays up before the sheet closes itself. */
    const val CONFIRM_MS = 1_200L
}
