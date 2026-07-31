package com.gradethread.app.feedback

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

    enum class Category(val label: String, val hint: String) {
        BUG("Something's broken", "What were you doing when it went wrong?"),
        IDEA("I wish it did…", "What would you want it to do instead?"),
        PRAISE("This worked well", "What helped? We'd like to keep it."),
        OTHER("Something else", "Tell us whatever's on your mind."),
    }

    fun error(message: String): String? = when {
        message.isBlank() -> "Write a line or two so we know what you mean."
        message.length > MAX_MESSAGE ->
            "That's longer than we can send — keep it under $MAX_MESSAGE characters."
        else -> null
    }

    fun canSend(message: String, sending: Boolean): Boolean =
        !sending && error(message) == null

    /**
     * The message as it will be stored.
     *
     * The category is a PREFIX, not a separate field, because the endpoint has
     * nowhere to put one. Trimmed and capped here as well, since the server
     * truncates silently and losing the last paragraph of a bug report is
     * exactly the kind of thing that gets reported as another bug.
     */
    fun compose(category: Category, message: String): String =
        "[${category.label}] ${message.trim().take(MAX_MESSAGE)}"

    /**
     * Feedback is one-way, and the sheet says so.
     *
     * Someone who expects a reply and never gets one concludes nobody read it.
     * The escalation to a support ticket (US-1386) is offered right there.
     */
    const val ONE_WAY_NOTE =
        "Feedback is one-way. Open a support request if you'd like a reply you can track."

    const val SENT = "Sent — thanks. We read every one."

    /** How long the confirmation stays up before the sheet closes itself. */
    const val CONFIRM_MS = 1_200L
}
