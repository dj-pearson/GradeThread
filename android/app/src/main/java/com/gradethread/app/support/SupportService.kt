package com.gradethread.app.support

import com.gradethread.app.platform.net.EdgeApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-1386: the support-ticket endpoints.
 *
 * Behind an interface so the list's ordering, the thread's grouping and the
 * validation are all testable without a server.
 */
interface SupportProviding {
    suspend fun tickets(): List<SupportTicket>

    suspend fun thread(ticketId: String): SupportThread

    /** Returns the new ticket's id. */
    suspend fun open(subject: String, body: String): String?

    /** Returns the ticket's status AFTER the reply — a reply can reopen it. */
    suspend fun reply(ticketId: String, body: String): String?
}

@Singleton
class SupportService @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
) : SupportProviding {

    override suspend fun tickets(): List<SupportTicket> =
        Support.sorted(
            json.decodeFromString(SupportTicketList.serializer(), edge.getRaw(BASE)).tickets,
        )

    override suspend fun thread(ticketId: String): SupportThread =
        json.decodeFromString(SupportThread.serializer(), edge.getRaw("$BASE/$ticketId"))

    override suspend fun open(subject: String, body: String): String? {
        // Trimmed and capped HERE as well as on the server: the edge silently
        // slices past its cap, and a reply that lost its last paragraph without
        // saying so is worse than one that was refused.
        val payload = json.encodeToString(
            NewTicket.serializer(),
            NewTicket(
                subject = subject.trim().take(Support.MAX_SUBJECT),
                body = body.trim().take(Support.MAX_BODY),
            ),
        )
        return json.decodeFromString(CreatedTicket.serializer(), edge.postRaw(BASE, payload))
            .ticketId
    }

    override suspend fun reply(ticketId: String, body: String): String? {
        val payload = json.encodeToString(
            NewMessage.serializer(),
            NewMessage(body.trim().take(Support.MAX_BODY)),
        )
        return json.decodeFromString(
            RepliedTicket.serializer(),
            edge.postRaw("$BASE/$ticketId/messages", payload),
        ).status
    }

    companion object {
        const val BASE = "/api/support-tickets"
        private val json = Json { ignoreUnknownKeys = true; isLenient = true }
    }
}

@Serializable
private data class NewTicket(val subject: String, val body: String)

@Serializable
private data class NewMessage(val body: String)
