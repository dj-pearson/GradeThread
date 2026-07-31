package com.gradethread.app.support

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
data class SupportThread(
    val ticket: SupportTicket = SupportTicket(),
    val messages: List<SupportMessage> = emptyList(),
)

@Serializable
data class CreatedTicket(
    val ok: Boolean = false,
    @SerialName("ticket_id") val ticketId: String? = null,
)

@Serializable
data class RepliedTicket(
    val ok: Boolean = false,
    val status: String? = null,
)

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

    fun subjectError(subject: String): String? = when {
        subject.isBlank() -> "Give it a subject so we know what it's about."
        subject.length > MAX_SUBJECT -> "That subject is too long — keep it under $MAX_SUBJECT characters."
        else -> null
    }

    fun bodyError(body: String): String? = when {
        body.isBlank() -> "Tell us what's happening."
        body.length > MAX_BODY -> "That's longer than we can send — keep it under $MAX_BODY characters."
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
    fun statusLabel(status: String): String = when (status.lowercase()) {
        "open" -> "Open"
        "pending", "awaiting_support" -> "With support"
        "in_progress" -> "Being worked on"
        "resolved" -> "Resolved"
        "closed" -> "Closed"
        else -> status.replace('_', ' ').replaceFirstChar { it.uppercase() }
    }

    /**
     * Inbox order: open tickets first, then by most recent activity.
     *
     * The server orders by activity alone, which buries an open ticket under a
     * pile of resolved ones the moment support closes a few in a batch.
     */
    fun sorted(tickets: List<SupportTicket>): List<SupportTicket> =
        tickets.sortedWith(
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
    fun replyReopensNotice(ticket: SupportTicket): String? =
        if (ticket.status.lowercase() in setOf("resolved", "closed")) {
            "Replying will reopen this request."
        } else {
            null
        }

    /** The empty inbox, said in a way that offers the next step. */
    const val EMPTY = "No requests yet. Open one and we'll get back to you by email too."
}
