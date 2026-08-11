package com.gradethread.app.workspace

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * US-2407: the membership writes, against a real HTTP server.
 *
 * The refusal cases are the point. Every workspace guard the edge enforces —
 * the role cap, owner immunity, the last-admin rule — comes back as a 403 or a
 * 409 carrying a sentence, and the seller has to see THAT sentence rather than
 * a generic failure or, worse, a sign-in prompt.
 */
class TeamServiceTest {

    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun service() = TeamService(
        EdgeApi(
            baseUrl = server.url("/").toString().removeSuffix("/"),
            client = OkHttpClient(),
            tokenProvider = { "tk_1" },
            tokenRefresher = { null },
            sleeper = { /* no real sleeping in tests */ },
        ),
    )

    private fun respond(code: Int, body: String) {
        server.enqueue(
            MockResponse().setResponseCode(code)
                .setHeader("Content-Type", "application/json")
                .setBody(body),
        )
    }

    // ── invite ───────────────────────────────────────────────────────────

    @Test
    fun `invite posts a normalized email and the wire role`() = runTest {
        respond(
            200,
            """{"id":"inv1","email":"sam@example.com","role":"listing_manager",
               "accept_url":"https://gradethread.com/accept-invite?token=t","email_sent":true}""",
        )
        val created = service().invite("  Sam@Example.COM ", WorkspaceRole.LISTING_MANAGER)

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/workspace/invitations", request.path)
        val sent = request.body.readUtf8()
        assertTrue(sent.contains("\"email\":\"sam@example.com\""))
        assertTrue(sent.contains("\"role\":\"listing_manager\""))
        assertTrue(created.emailSent)
        assertEquals("inv1", created.id)
    }

    @Test
    fun `an invite whose email never left is still a success carrying the link`() = runTest {
        // The server sends the email best-effort and says so. Treating this as
        // a failure would hide the only route the teammate has in.
        respond(
            200,
            """{"id":"inv1","email":"sam@example.com","role":"member",
               "accept_url":"https://gradethread.com/accept-invite?token=abc","email_sent":false}""",
        )
        val created = service().invite("sam@example.com", WorkspaceRole.MEMBER)
        assertFalse(created.emailSent)
        assertEquals("https://gradethread.com/accept-invite?token=abc", created.acceptUrl)
    }

    @Test
    fun `a duplicate invitation surfaces the server's own sentence`() = runTest {
        respond(409, """{"error":"There's already a pending invitation for that email"}""")
        val error = runCatching { service().invite("sam@example.com", WorkspaceRole.MEMBER) }.exceptionOrNull()
        assertTrue(error is EdgeApiError.BadRequest)
        assertEquals(
            "There's already a pending invitation for that email",
            (error as EdgeApiError).userMessage(),
        )
    }

    // ── role change ──────────────────────────────────────────────────────

    @Test
    fun `changing a role PATCHes the member route with the wire role`() = runTest {
        respond(200, """{"ok":true,"role":"admin"}""")
        service().updateRole("m1", WorkspaceRole.ADMIN)

        val request = server.takeRequest()
        assertEquals("PATCH", request.method)
        assertEquals("/api/workspace/members/m1/role", request.path)
        assertEquals("""{"role":"admin"}""", request.body.readUtf8())
    }

    @Test
    fun `a role refusal reads as the rule that was broken, not as a dead session`() = runTest {
        // This is the case US-2407 added EdgeApiError.Forbidden for: folded
        // into Unauthorized it said "your session expired", pointing an admin
        // at a sign-out that could not possibly help.
        respond(403, """{"error":"You cannot assign a role higher than your own"}""")
        val error = runCatching { service().updateRole("m1", WorkspaceRole.ADMIN) }.exceptionOrNull()
        assertTrue(error is EdgeApiError.Forbidden)
        assertEquals("You cannot assign a role higher than your own", (error as EdgeApiError).userMessage())
    }

    @Test
    fun `the last-admin guard comes back whole`() = runTest {
        respond(409, """{"error":"Appoint another admin before stepping down from admin."}""")
        val error = runCatching { service().updateRole("self", WorkspaceRole.VIEWER) }.exceptionOrNull()
        assertTrue(error is EdgeApiError.BadRequest)
        assertEquals("Appoint another admin before stepping down from admin.", (error as EdgeApiError).userMessage())
    }

    // ── remove ───────────────────────────────────────────────────────────

    @Test
    fun `remove posts to the member's remove route`() = runTest {
        respond(200, """{"ok":true}""")
        service().remove("m1")

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/workspace/members/m1/remove", request.path)
    }

    @Test
    fun `removing the owner is refused with the server's reason`() = runTest {
        respond(403, """{"error":"The workspace owner can't be removed"}""")
        val error = runCatching { service().remove("owner-1") }.exceptionOrNull()
        assertTrue(error is EdgeApiError.Forbidden)
        assertEquals("The workspace owner can't be removed", (error as EdgeApiError).userMessage())
    }

    @Test
    fun `removing someone who is already gone reports not found`() = runTest {
        respond(404, """{"error":"Member not found in this workspace"}""")
        assertTrue(runCatching { service().remove("ghost") }.exceptionOrNull() is EdgeApiError.NotFound)
    }

    // ── resend ───────────────────────────────────────────────────────────

    @Test
    fun `resend reports whether the email actually left`() = runTest {
        respond(200, """{"email_sent":false,"accept_url":"https://gradethread.com/accept-invite?token=z"}""")
        val result = service().resend("inv1")

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/workspace/invitations/inv1/resend", request.path)
        assertFalse(result.emailSent)
        assertEquals("https://gradethread.com/accept-invite?token=z", result.acceptUrl)
    }

    @Test
    fun `resending an expired invitation says to make a new one`() = runTest {
        respond(400, """{"error":"Invitation has expired — create a new one"}""")
        val error = runCatching { service().resend("inv1") }.exceptionOrNull()
        assertTrue(error is EdgeApiError.BadRequest)
        assertEquals("Invitation has expired — create a new one", (error as EdgeApiError).userMessage())
    }
}
