package com.gradethread.app.speech

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.gradethread.app.ui.text
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

import android.speech.SpeechRecognizer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1331: the dictation lifecycle and error taxonomy. Robolectric supplies
 * the framework classes; the recognizer itself is unavailable in the shadow
 * environment, which is exactly the "unavailable device" path worth proving.
 */
@RunWith(RobolectricTestRunner::class)
class DictationControllerTest {

    private val context = ApplicationProvider.getApplicationContext<Context>()

    private fun controller() = DictationController(context)

    @Test
    fun stopIsIdempotent_whenNeverStarted() {
        val c = controller()
        // Must not throw, and must not abandon audio focus it never took —
        // that would leave another app permanently ducked.
        c.stop()
        c.stop()
        assertEquals(DictationController.State.Idle, c.state.value)
    }

    @Test
    fun resetClearsStateAndTranscript() {
        val c = controller()
        c.reset()
        assertEquals(DictationController.State.Idle, c.state.value)
        assertNull(c.finalTranscript.value)
    }

    @Test
    fun startOnAnUnavailableRecognizer_failsTypedRatherThanCrashing() {
        val c = controller()
        c.start()
        // Robolectric ships no recognition service, so this is the
        // no-speech-engine device path.
        val state = c.state.value
        assertTrue(state is DictationController.State.Failed)
        assertEquals(
            DictationError.RecognizerUnavailable,
            (state as DictationController.State.Failed).error,
        )
    }

    @Test
    fun permissionDenied_surfacesTheSettingsRecoverableError() {
        val c = controller()
        c.permissionDenied()
        val state = c.state.value as DictationController.State.Failed
        assertEquals(DictationError.MicrophonePermissionDenied, state.error)
        // Only permission failures offer an "Open Settings" affordance.
        assertTrue(state.error.isSettingsRecoverable)
    }

    @Test
    fun errorCodesMapToTheUserFacingTaxonomy() {
        assertEquals(
            DictationError.MicrophonePermissionDenied,
            DictationError.from(SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS),
        )
        assertEquals(
            DictationError.Network,
            DictationError.from(SpeechRecognizer.ERROR_NETWORK_TIMEOUT),
        )
        // "Didn't catch that" is a retry prompt, not a failure banner.
        assertEquals(
            DictationError.NoSpeechHeard,
            DictationError.from(SpeechRecognizer.ERROR_NO_MATCH),
        )
        assertEquals(
            DictationError.NoSpeechHeard,
            DictationError.from(SpeechRecognizer.ERROR_SPEECH_TIMEOUT),
        )
        assertTrue(
            DictationError.from(SpeechRecognizer.ERROR_CLIENT) is DictationError.EngineFailure,
        )
    }

    @Test
    fun onlyPermissionErrorsAreSettingsRecoverable() {
        assertTrue(DictationError.MicrophonePermissionDenied.isSettingsRecoverable)
        // Sending someone to Settings for a network blip is a dead end.
        assertTrue(!DictationError.Network.isSettingsRecoverable)
        assertTrue(!DictationError.RecognizerUnavailable.isSettingsRecoverable)
        assertTrue(!DictationError.NoSpeechHeard.isSettingsRecoverable)
    }

    @Test
    fun everyErrorCarriesANonEmptyUserFacingMessage() {
        val errors = listOf(
            DictationError.MicrophonePermissionDenied,
            DictationError.RecognizerUnavailable,
            DictationError.NoSpeechHeard,
            DictationError.Network,
            DictationError.EngineFailure(""),
            DictationError.EngineFailure("boom"),
        )
        // US-2976: RENDERED, not asserted as resource ids. "carries a non-empty
        // message" is a claim about what a seller reads, and an id is non-empty
        // whether or not the resource behind it says anything.
        for (e in errors) assertTrue(e.message.text(context).isNotBlank())
        // A blank detail must not produce a dangling "Dictation failed: ".
        assertEquals(
            "Dictation stopped unexpectedly.",
            DictationError.EngineFailure("").message.text(context),
        )
        assertEquals(
            "Dictation failed: boom",
            DictationError.EngineFailure("boom").message.text(context),
        )
    }
}
