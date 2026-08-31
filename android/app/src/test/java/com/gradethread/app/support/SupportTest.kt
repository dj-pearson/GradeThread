package com.gradethread.app.support

import kotlinx.serialization.json.Json
import com.gradethread.app.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1386: the support surface's rules and wire shape.
 *
 * Support is where someone goes when the rest of the app has already let them
 * down, so the failure modes here are the expensive ones: a message silently
 * truncated, a closed ticket that reads as open, or the one open request buried
 * under a pile of resolved ones.
 */
class SupportTest {

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    private fun ticket(id: String, status: String = "open", lastMessageAt: String? = null) =
        SupportTicket(id = id, subject = "Subject $id", status = status, lastMessageAt = lastMessageAt)

    // ── Validation ───────────────────────────────────────────────────────────

    @Test
    fun `an empty subject or body is refused, with words`() {
        assertEquals(
            R.string.support_subject_required,
            Support.subjectError("   ")?.res,
        )
        assertEquals(R.string.support_body_required, Support.bodyError("")?.res)
        assertNull(Support.subjectError("Grade stuck"))
        assertNull(Support.bodyError("It's been spinning for an hour."))
    }

    @Test
    fun `the caps match the server exactly`() {
        // The edge SLICES past its cap rather than refusing, so a client that
        // allowed more would lose the end of what someone wrote without
        // telling them. These numbers have to stay in step.
        assertEquals(200, Support.MAX_SUBJECT)
        assertEquals(4000, Support.MAX_BODY)

        assertNull(Support.bodyError("x".repeat(Support.MAX_BODY)))
        assertNull(Support.subjectError("s".repeat(Support.MAX_SUBJECT)))

        // US-2976: the message carries the CAP, which is the point of it - a
        // limit the seller cannot see is one they cannot work to. Asserting the
        // argument is what keeps the sentence and the constant in step.
        val longBody = Support.bodyError("x".repeat(Support.MAX_BODY + 1))!!
        assertEquals(R.string.support_body_too_long, longBody.res)
        assertEquals(listOf<Any>(Support.MAX_BODY), longBody.args)

        val longSubject = Support.subjectError("s".repeat(Support.MAX_SUBJECT + 1))!!
        assertEquals(R.string.support_subject_too_long, longSubject.res)
        assertEquals(listOf<Any>(Support.MAX_SUBJECT), longSubject.args)
    }

    @Test
    fun `sending is gated on both fields and on not already sending`() {
        assertTrue(Support.canOpen("Subject", "Body", busy = false))
        assertFalse(Support.canOpen("Subject", "", busy = false))
        assertFalse(Support.canOpen("", "Body", busy = false))
        assertFalse(Support.canOpen("Subject", "Body", busy = true))

        assertTrue(Support.canReply("Body", busy = false))
        assertFalse(Support.canReply("  ", busy = false))
        assertFalse(Support.canReply("Body", busy = true))
    }

    // ── Status ───────────────────────────────────────────────────────────────

    @Test
    fun `statuses read as words`() {
        assertEquals(R.string.support_status_open, Support.statusLabel("open").res)
        assertEquals(R.string.support_status_with_support, Support.statusLabel("pending").res)
        assertEquals(
            R.string.support_status_in_progress,
            Support.statusLabel("in_progress").res,
        )
        assertEquals(R.string.support_status_resolved, Support.statusLabel("resolved").res)
        assertEquals(R.string.support_status_closed, Support.statusLabel("closed").res)
    }

    @Test
    fun `an unknown status is shown, never quietly called open`() {
        // The server can add one. Calling it "Open" would tell a seller their
        // closed ticket is still being worked.
        // US-2976: the server's own word, tidied and shown as `detail`. It is
        // NOT the open resource, which is the whole point of the branch.
        val unknown = Support.statusLabel("needs_info")
        assertEquals("Needs info", unknown.detail)
        assertNotEquals(R.string.support_status_open, unknown.res)
        assertFalse(Support.isOpen(ticket("t", status = "needs_info")))
    }

    @Test
    fun `open covers every status the seller is still waiting on`() {
        listOf("open", "pending", "in_progress", "awaiting_support").forEach {
            assertTrue(it, Support.isOpen(ticket("t", status = it)))
        }
        listOf("resolved", "closed").forEach {
            assertFalse(it, Support.isOpen(ticket("t", status = it)))
        }
    }

    // ── Ordering ─────────────────────────────────────────────────────────────

    @Test
    fun `open tickets sort above resolved ones, whatever the activity`() {
        // The server orders by activity alone, so closing a batch of old
        // tickets buries the one thing the seller is waiting on.
        val sorted = Support.sorted(
            listOf(
                ticket("resolved-recent", status = "resolved", lastMessageAt = "2026-07-31T10:00:00Z"),
                ticket("open-old", status = "open", lastMessageAt = "2026-07-01T10:00:00Z"),
                ticket("open-recent", status = "open", lastMessageAt = "2026-07-30T10:00:00Z"),
            ),
        )

        assertEquals(listOf("open-recent", "open-old", "resolved-recent"), sorted.map { it.id })
    }

    @Test
    fun `a ticket with no activity timestamp still sorts, on its creation date`() {
        val sorted = Support.sorted(
            listOf(
                SupportTicket(id = "b", status = "open", createdAt = "2026-07-01T00:00:00Z"),
                SupportTicket(id = "a", status = "open", createdAt = "2026-07-20T00:00:00Z"),
            ),
        )

        assertEquals(listOf("a", "b"), sorted.map { it.id })
    }

    // ── Reopening ────────────────────────────────────────────────────────────

    @Test
    fun `a reply to a closed ticket warns before it is sent`() {
        // The edge reopens on any user reply. Someone adding "thanks, that
        // worked" deserves to know it goes back in the queue.
        assertEquals(
            R.string.support_reply_reopens,
            Support.replyReopensNotice(ticket("t", status = "resolved")),
        )
        assertEquals(
            R.string.support_reply_reopens,
            Support.replyReopensNotice(ticket("t", status = "closed")),
        )
        assertNull(Support.replyReopensNotice(ticket("t", status = "open")))
    }

    // ── The wire ─────────────────────────────────────────────────────────────

    @Test
    fun `a thread decodes, and authorship reduces to you or support`() {
        val thread = json.decodeFromString(
            SupportThread.serializer(),
            """
            {
              "ticket": {
                "id": "t1", "subject": "Grade stuck", "status": "in_progress",
                "priority": "normal", "last_message_at": "2026-07-31T10:00:00Z",
                "resolved_at": null, "created_at": "2026-07-30T09:00:00Z"
              },
              "messages": [
                { "id": "m1", "author": "you", "body": "It's been an hour.",
                  "created_at": "2026-07-30T09:00:00Z" },
                { "id": "m2", "author": "support", "body": "Looking now.",
                  "created_at": "2026-07-31T10:00:00Z" }
              ]
            }
            """.trimIndent(),
        )

        assertEquals("t1", thread.ticket.id)
        assertTrue(thread.messages[0].fromMe)
        assertFalse(thread.messages[1].fromMe)
    }

    @Test
    fun `an author value nobody expected is not treated as the seller`() {
        // The projection is the server's, but if it ever changed, defaulting an
        // unrecognised author to "you" would show an agent's words as the
        // seller's own.
        val message = json.decodeFromString(
            SupportMessage.serializer(),
            """{ "id": "m1", "author": "agent-42", "body": "hi" }""",
        )

        assertFalse(message.fromMe)
    }

    @Test
    fun `an empty inbox decodes rather than throwing`() {
        val list = json.decodeFromString(SupportTicketList.serializer(), """{ "tickets": [] }""")
        assertTrue(list.tickets.isEmpty())

        val missing = json.decodeFromString(SupportTicketList.serializer(), """{}""")
        assertTrue(missing.tickets.isEmpty())
    }

    @Test
    fun `the create response carries the new ticket id`() {
        val created = json.decodeFromString(
            CreatedTicket.serializer(),
            """{ "ok": true, "ticket_id": "t9" }""",
        )
        assertEquals("t9", created.ticketId)
    }

    @Test
    fun `the reply response reports the status after the reply`() {
        val replied = json.decodeFromString(
            RepliedTicket.serializer(),
            """{ "ok": true, "status": "open" }""",
        )
        assertEquals("open", replied.status)
    }
}
