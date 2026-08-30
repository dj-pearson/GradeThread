package com.gradethread.app.feedback

import com.gradethread.app.R

import com.gradethread.app.testing.MainDispatcherRule
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * US-1387: the feedback sheet's rules.
 *
 * Two failure modes are the expensive ones and both are covered here: a message
 * silently truncated by the server, and a draft thrown away by the client.
 */
class FeedbackTest {

    @get:Rule
    val mainDispatcher = MainDispatcherRule()

    // ── Validation ───────────────────────────────────────────────────────────

    @Test
    fun `an empty message is refused with words, not a dead button alone`() {
        // US-2976: the id, not the words. Asserting the English here would have
        // made the test the second place the copy lives, and the one that
        // silently disagrees with strings.xml.
        assertEquals(R.string.feedback_error_empty, Feedback.error("   "))
        assertNull(Feedback.error("The grade never came back."))
    }

    @Test
    fun `the cap holds at the boundary`() {
        assertNull(Feedback.error("x".repeat(Feedback.MAX_MESSAGE)))
        assertEquals(
            R.string.feedback_error_too_long,
            Feedback.error("x".repeat(Feedback.MAX_MESSAGE + 1)),
        )
    }

    @Test
    fun `sending is gated on the message and on not already sending`() {
        assertTrue(Feedback.canSend("Something", sending = false))
        assertFalse(Feedback.canSend("Something", sending = true))
        assertFalse(Feedback.canSend("", sending = false))
    }

    // ── Composing ────────────────────────────────────────────────────────────

    @Test
    fun `the category rides in the message, because the endpoint has nowhere else`() {
        // A picker whose value the client drops on the floor is a picker that
        // does nothing. This puts it where a human triaging the row reads it.
        assertEquals(
            "[Something's broken] The grade never came back.",
            Feedback.compose(Feedback.Category.BUG, "  The grade never came back.  "),
        )
        assertEquals(
            "[I wish it did…] Bulk relist.",
            Feedback.compose(Feedback.Category.IDEA, "Bulk relist."),
        )
    }

    @Test
    fun `the composed message is capped before it is sent`() {
        // The server slices at its own cap without saying so, and losing the
        // end of a bug report gets reported as another bug.
        val long = "x".repeat(Feedback.MAX_MESSAGE + 500)
        val composed = Feedback.compose(Feedback.Category.OTHER, long)

        assertTrue(composed.endsWith("x".repeat(10)))
        assertEquals(
            Feedback.MAX_MESSAGE,
            composed.removePrefix("[${Feedback.Category.OTHER.triage}] ").length,
        )
    }

    @Test
    fun `every category has its own prompt`() {
        // The same placeholder under four different chips makes the chips look
        // decorative.
        val hints = Feedback.Category.entries.map { it.hint }
        assertEquals(hints.size, hints.toSet().size)
        // A resource id of 0 is what an unresolved R reference compiles to, so
        // this is the id-level version of "the string is not blank".
        Feedback.Category.entries.forEach {
            assertTrue(it.name, it.label != 0)
            assertTrue(it.name, it.hint != 0)
            assertTrue(it.name, it.triage.isNotBlank())
        }
    }

    @Test
    fun `source stays the platform`() {
        // Support groups on it; folding the category in here would break that.
        assertEquals("android", Feedback.SOURCE)
    }

    // ── The sheet's state ────────────────────────────────────────────────────

    private class FakeSender(var fail: Boolean = false) : FeedbackSending {
        var sent: Pair<Feedback.Category, String>? = null

        override suspend fun send(category: Feedback.Category, message: String) {
            if (fail) error("network down")
            sent = category to message
        }
    }

    @Test
    fun `dismissing keeps the draft`() = runTest(mainDispatcher.dispatcher) {
        // AC3. Closing the sheet to go and check a version number, an order id
        // or the exact wording of an error must not lose what was typed.
        val vm = FeedbackViewModel(FakeSender())
        vm.open()
        vm.setMessage("Half a bug report")
        vm.dismiss()

        assertFalse(vm.state.value.open)
        assertEquals("Half a bug report", vm.state.value.message)

        vm.open()
        assertEquals("Half a bug report", vm.state.value.message)
    }

    @Test
    fun `a successful send clears the form and confirms first`() = runTest(mainDispatcher.dispatcher) {
        val sender = FakeSender()
        val vm = FeedbackViewModel(sender)
        vm.open()
        vm.setCategory(Feedback.Category.PRAISE)
        vm.setMessage("The tag reader is great")
        vm.send()
        advanceUntilIdle()

        assertEquals(Feedback.Category.PRAISE to "The tag reader is great", sender.sent)
        assertEquals("", vm.state.value.message)
        // Closed only AFTER the confirmation delay — closing instantly reads as
        // nothing having happened, which is how people send it three times.
        assertFalse(vm.state.value.open)
        assertNull(vm.state.value.error)
    }

    @Test
    fun `a failed send keeps every word`() = runTest(mainDispatcher.dispatcher) {
        val vm = FeedbackViewModel(FakeSender(fail = true))
        vm.open()
        vm.setMessage("A long and careful bug report")
        vm.send()
        advanceUntilIdle()

        assertEquals("A long and careful bug report", vm.state.value.message)
        assertTrue(vm.state.value.open)
        assertFalse(vm.state.value.sending)
        assertEquals("Couldn't send that. Try again in a moment.", vm.state.value.error)
        // And it is retryable.
        assertTrue(vm.state.value.canSend)
    }

    @Test
    fun `an error clears as soon as they start editing again`() = runTest(mainDispatcher.dispatcher) {
        val vm = FeedbackViewModel(FakeSender(fail = true))
        vm.open()
        vm.setMessage("first try")
        vm.send()
        advanceUntilIdle()
        assertTrue(vm.state.value.error != null)

        vm.setMessage("first try, with more detail")
        assertNull(vm.state.value.error)
    }
}
