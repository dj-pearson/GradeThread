package com.gradethread.app.support

import androidx.annotation.StringRes
import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * US-1386 (edge `routes/support-tickets.ts`): the support inbox wire contract.
 *
 * Note what is NOT here: `is_internal_note` and the agent's identity. The edge
 * strips both before the row ever leaves the server, and modelling them would
 * invite a client that asks for them.
 */
@Serializable
data class SupportTicket(
    val id: String = "",
    val subject: String = "",
    val status: String = "open",
    val priority: String = "normal",
    @SerialName("last_message_at") val lastMessageAt: String? = null,
    @SerialName("resolved_at") val resolvedAt: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
)

@Serializable
data class SupportTicketList(val tickets: List<SupportTicket> = emptyList())

@Serializable
data class SupportMessage(
    val id: String = "",
    /** "you" or "support" — never an agent's name. */
    val author: String = "support",
    val body: String = "",
    @SerialName("created_at") val createdAt: String? = null,
) {
    val fromMe: Boolean get() = author == "you"
}

@Serializable
data class SupportThread(val ticket: SupportTicket = SupportTicket(), val messages: List<SupportMessage> = emptyList())

@Serializable
data class CreatedTicket(val ok: Boolean = false, @SerialName("ticket_id") val ticketId: String? = null)

@Serializable
data class RepliedTicket(val ok: Boolean = false, val status: String? = null)

/**
 * US-1386: the rules the support surface runs on.
 *
 * Pure, because the limits here are the server's — a client that lets someone
 * type 6,000 characters and then silently truncates to 4,000 loses the end of
 * what they were trying to say, in the one place where being understood is the
 * whole point.
 */
object Support {

    /** Both mirror the edge's own caps exactly. */
    const val MAX_SUBJECT = 200
    const val MAX_BODY = 4000

    /**
     * US-2976: the two "too long" messages carry the CAP, which is the whole
     * point of them - a limit the seller cannot see is one they cannot work to.
     * It travels as an argument so a change to MAX_SUBJECT or MAX_BODY cannot
     * leave the sentence quoting a number the server stopped enforcing.
     */
    fun subjectError(subject: String): UiMessage? = when {
        subject.isBlank() -> UiMessage(R.string.support_subject_required)
        subject.length > MAX_SUBJECT ->
            UiMessage(R.string.support_subject_too_long, args = listOf(MAX_SUBJECT))

        else -> null
    }

    fun bodyError(body: String): UiMessage? = when {
        body.isBlank() -> UiMessage(R.string.support_body_required)
        body.length > MAX_BODY ->
            UiMessage(R.string.support_body_too_long, args = listOf(MAX_BODY))

        else -> null
    }

    fun canOpen(subject: String, body: String, busy: Boolean): Boolean =
        !busy && subjectError(subject) == null && bodyError(body) == null

    fun canReply(body: String, busy: Boolean): Boolean = !busy && bodyError(body) == null

    /** Statuses the seller still has something to wait for. */
    private val openStatuses = setOf("open", "pending", "in_progress", "awaiting_support")

    fun isOpen(ticket: SupportTicket): Boolean = ticket.status.lowercase() in openStatuses

    /**
     * What a status says in words.
     *
     * An unknown status reads as its own raw value rather than as "open": the
     * server can add one, and quietly calling it open would tell a seller their
     * closed ticket is still being worked.
     */
    fun statusLabel(status: String): UiMessage = when (status.lowercase()) {
        "open" -> UiMessage(R.string.support_status_open)
        "pending", "awaiting_support" -> UiMessage(R.string.support_status_with_support)
        "in_progress" -> UiMessage(R.string.support_status_in_progress)
        "resolved" -> UiMessage(R.string.support_status_resolved)
        "closed" -> UiMessage(R.string.support_status_closed)
        // US-2976: a status the server added and this build has not been
        // taught rides as `detail` - it is the server's own word, tidied up
        // and shown untranslated, which still beats calling a closed ticket
        // open.
        else -> UiMessage(
            R.string.support_status_unknown,
            detail = status.replace('_', ' ').replaceFirstChar { it.uppercase() },
        )
    }

    /**
     * Inbox order: open tickets first, then by most recent activity.
     *
     * The server orders by activity alone, which buries an open ticket under a
     * pile of resolved ones the moment support closes a few in a batch.
     */
    fun sorted(tickets: List<SupportTicket>): List<SupportTicket> = tickets.sortedWith(
        compareByDescending<SupportTicket> { isOpen(it) }
            .thenByDescending { it.lastMessageAt ?: it.createdAt ?: "" },
    )

    /**
     * What a reply will do to a resolved ticket.
     *
     * Said BEFORE they send it. The edge reopens a resolved or closed ticket on
     * any user reply, and someone adding "thanks, that worked" deserves to know
     * they are about to put it back in the queue.
     */
    @StringRes
    fun replyReopensNotice(ticket: SupportTicket): Int? =
        if (ticket.status.lowercase() in setOf("resolved", "closed")) {
            R.string.support_reply_reopens
        } else {
            null
        }

    /** The empty inbox, said in a way that offers the next step. */
    @StringRes
    val EMPTY: Int = R.string.support_no_requests
}
