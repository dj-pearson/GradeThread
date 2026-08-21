package com.gradethread.app.settings

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import com.gradethread.app.platform.net.EdgeApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * US-2776: in-app account deletion, which Google Play requires and Android did
 * not have.
 *
 * The cases worth pinning are the ones that turn a policy requirement into a
 * working button: the exact confirmation phrase the SERVER checks for, the
 * password that is asked for only when the server asks, and the OAuth account
 * that must be able to delete without one.
 */
@RunWith(RobolectricTestRunner::class)
class AccountDeletionTest {

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

    private fun service() = AccountDeletionService(
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

    private fun bodyOf(raw: String): JsonObject = Json.parseToJsonElement(raw) as JsonObject

    @Test
    fun `an OAuth account deletes in one call, with no password`() = runTest {
        respond(200, """{"deleted":true}""")

        val outcome = service().delete(null)

        assertEquals(AccountDeletionService.Outcome.Deleted, outcome)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals(AccountDeletionService.DELETE_PATH, request.path)
        val sent = bodyOf(request.body.readUtf8())
        // The phrase the server compares against, verbatim. A translated or
        // trimmed variant is rejected server-side, so it is a protocol constant
        // and not UI copy.
        assertEquals("DELETE MY ACCOUNT", sent["confirm"]!!.jsonPrimitive.content)
        // No password key at all, rather than an empty one: an account with no
        // password has none to send, and the server exempts it.
        assertNull(sent["password"])
        // No user id anywhere. The subject comes from the bearer token, on the
        // one endpoint where a caller-supplied id would destroy someone else's
        // account.
        assertFalse(sent.containsKey("user_id"))
        assertTrue(request.getHeader("Authorization")!!.startsWith("Bearer "))
    }

    @Test
    fun `the server, not the client, decides that a password is needed`() = runTest {
        respond(400, """{"error":"Enter your password to confirm deleting your account.","code":"password_required"}""")

        val outcome = service().delete(null)

        assertEquals(AccountDeletionService.Outcome.PasswordRequired, outcome)
    }

    @Test
    fun `the retry carries the password`() = runTest {
        respond(400, """{"error":"Enter your password.","code":"password_required"}""")
        respond(200, """{"deleted":true}""")

        assertEquals(AccountDeletionService.Outcome.PasswordRequired, service().delete(null))
        assertEquals(AccountDeletionService.Outcome.Deleted, service().delete("hunter2"))

        server.takeRequest()
        val retry = bodyOf(server.takeRequest().body.readUtf8())
        assertEquals("hunter2", retry["password"]!!.jsonPrimitive.content)
    }

    @Test
    fun `a wrong password is a failure, not a password prompt`() = runTest {
        // Same status as the prompt above and a different code. Keying on the
        // status alone would loop the seller through the password field forever
        // with no message saying why.
        respond(400, """{"error":"That password is incorrect.","code":"password_invalid"}""")

        val outcome = service().delete("wrong")

        assertTrue(outcome is AccountDeletionService.Outcome.Failed)
        assertEquals(
            "That password is incorrect.",
            (outcome as AccountDeletionService.Outcome.Failed).message,
        )
    }

    @Test
    fun `a refused deletion says nothing was removed`() = runTest {
        // The retention precondition returns 503, and the sentence matters: a
        // seller who believes a failed deletion partially happened will report
        // data we still hold, and they would be right to. A 5xx on a POST is not
        // retried, so one response is one attempt.
        respond(
            503,
            """{"error":"We could not complete the deletion right now. Nothing was removed """ +
                """from your account. Please try again in a few minutes.",""" +
                """"code":"retention_precondition_failed"}""",
        )

        val outcome = service().delete(null)

        assertTrue(outcome is AccountDeletionService.Outcome.Failed)
        assertTrue(
            (outcome as AccountDeletionService.Outcome.Failed).message
                .contains("Nothing was removed"),
        )
    }

    @Test
    fun `the confirmation gate matches the phrase exactly, ignoring surrounding space`() {
        fun gate(typed: String) = SettingsViewModel.State(deleteConfirmText = typed).deleteConfirmed

        assertTrue(gate("DELETE MY ACCOUNT"))
        assertTrue(gate("  DELETE MY ACCOUNT  "))
        // Lowercase is not "close enough": the server compares the literal, so
        // enabling the button here would send a request that is refused.
        assertFalse(gate("delete my account"))
        assertFalse(gate("DELETE MY ACCOUNT!"))
        assertFalse(gate(""))
    }
}
