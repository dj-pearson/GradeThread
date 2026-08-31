package com.gradethread.app.speech

import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * US-1331: a lifecycle-safe wrapper over [SpeechRecognizer] (iOS
 * `SpeechDictation`).
 *
 * Two hard-won iOS behaviors are carried over deliberately:
 *
 *  - the FINAL transcript is published separately from partials. `stop()`
 *    flips listening off in the same turn the final result arrives, so a
 *    handler guarded on "am I still listening?" drops the last words;
 *  - `stop()` is IDEMPOTENT and only releases what it actually acquired.
 *    Abandoning audio focus we never requested leaves other apps ducked.
 *
 * SpeechRecognizer is main-thread-only — every method here must be called
 * from the main thread, which the Compose call sites satisfy.
 */
class DictationController(private val context: Context) {

    sealed class State {
        object Idle : State()

        /** Listening; [transcript] is the latest partial. */
        data class Listening(val transcript: String = "") : State()

        data class Failed(val error: DictationError) : State()
    }

    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state.asStateFlow()

    /** The final transcript of the last session, consumed once by the caller. */
    private val _finalTranscript = MutableStateFlow<String?>(null)
    val finalTranscript: StateFlow<String?> = _finalTranscript.asStateFlow()

    private var recognizer: SpeechRecognizer? = null
    private val audioManager: AudioManager? =
        context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

    private var focusRequest: AudioFocusRequest? = null

    /** True only for focus WE hold — see the idempotent-release note above. */
    private var holdsFocus = false

    /**
     * Whether dictation can run at all. Gate the mic button on this rather
     * than letting a tap fail: a device with no recognition service should
     * not show an affordance that can only error.
     */
    fun isAvailable(): Boolean = SpeechRecognizer.isRecognitionAvailable(context)

    fun start() {
        if (_state.value is State.Listening) return // already running
        if (!isAvailable()) {
            _state.value = State.Failed(DictationError.RecognizerUnavailable)
            return
        }
        _finalTranscript.value = null

        val created = runCatching { SpeechRecognizer.createSpeechRecognizer(context) }.getOrNull()
        if (created == null) {
            _state.value = State.Failed(DictationError.RecognizerUnavailable)
            return
        }
        recognizer = created
        created.setRecognitionListener(listener)

        requestFocus()

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(
                RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
            )
            // The whole point: stream words as they're heard.
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
        }
        _state.value = State.Listening()
        runCatching { created.startListening(intent) }.onFailure {
            _state.value = State.Failed(DictationError.EngineFailure(it.message.orEmpty()))
            teardown()
        }
    }

    /** Idempotent: safe to call when never started, or twice. */
    fun stop() {
        val active = recognizer
        if (active != null) {
            runCatching { active.stopListening() }
        }
        if (_state.value is State.Listening) _state.value = State.Idle
        teardown()
    }

    /** [stop] plus clearing the transcript — the iOS `reset()`. */
    fun reset() {
        stop()
        _finalTranscript.value = null
        _state.value = State.Idle
    }

    /** The caller acknowledges the final transcript so it isn't re-applied. */
    fun consumeFinal() {
        _finalTranscript.value = null
    }

    fun permissionDenied() {
        _state.value = State.Failed(DictationError.MicrophonePermissionDenied)
        teardown()
    }

    private fun teardown() {
        recognizer?.let { r ->
            runCatching { r.cancel() }
            runCatching { r.destroy() }
        }
        recognizer = null
        releaseFocus()
    }

    private fun requestFocus() {
        val manager = audioManager ?: return
        // TRANSIENT_MAY_DUCK: dictation is short; other audio ducks rather
        // than stopping, and resumes at full volume when we abandon focus.
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .build()
        focusRequest = request
        holdsFocus = runCatching {
            manager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        }.getOrDefault(false)
    }

    private fun releaseFocus() {
        // Only abandon focus we actually hold, or we leave other apps ducked.
        if (!holdsFocus) return
        val manager = audioManager ?: return
        focusRequest?.let { runCatching { manager.abandonAudioFocusRequest(it) } }
        holdsFocus = false
        focusRequest = null
    }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) = Unit
        override fun onBeginningOfSpeech() = Unit
        override fun onRmsChanged(rmsdB: Float) = Unit
        override fun onBufferReceived(buffer: ByteArray?) = Unit
        override fun onEndOfSpeech() = Unit
        override fun onEvent(eventType: Int, params: Bundle?) = Unit

        override fun onPartialResults(partialResults: Bundle?) {
            val text = partialResults.firstTranscript() ?: return
            // Only while listening — a late partial after stop must not
            // resurrect the listening state.
            if (_state.value is State.Listening) _state.value = State.Listening(text)
        }

        override fun onResults(results: Bundle?) {
            val text = results.firstTranscript()
            // Published even though we're about to go Idle — the iOS lesson.
            if (!text.isNullOrEmpty()) _finalTranscript.value = text
            _state.value = State.Idle
            teardown()
        }

        override fun onError(error: Int) {
            _state.value = State.Failed(DictationError.from(error))
            teardown()
        }
    }

    private fun Bundle?.firstTranscript(): String? =
        this?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
}

/** Typed dictation failures (iOS `DictationError`). */
sealed class DictationError(val message: UiMessage) {

    object MicrophonePermissionDenied : DictationError(
        UiMessage(R.string.dictation_mic_denied),
    )

    object RecognizerUnavailable : DictationError(
        UiMessage(R.string.dictation_unavailable),
    )

    object NoSpeechHeard : DictationError(UiMessage(R.string.dictation_no_speech))

    object Network : DictationError(UiMessage(R.string.dictation_network))

    class EngineFailure(detail: String) :
        DictationError(
            // US-2976: the engine's text is an ARGUMENT, not a `detail` override.
            // "Dictation failed: X" is our sentence WRAPPING the engine's words,
            // and the wrapper translates even though X does not.
            if (detail.isBlank()) {
                UiMessage(R.string.dictation_stopped)
            } else {
                UiMessage(R.string.dictation_failed_detail, args = listOf(detail))
            },
        )

    /** Only permission failures are Settings-recoverable (the iOS US-1201 split). */
    val isSettingsRecoverable: Boolean get() = this is MicrophonePermissionDenied

    companion object {
        fun from(errorCode: Int): DictationError = when (errorCode) {
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> MicrophonePermissionDenied
            SpeechRecognizer.ERROR_NETWORK,
            SpeechRecognizer.ERROR_NETWORK_TIMEOUT,
            -> Network
            SpeechRecognizer.ERROR_NO_MATCH,
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT,
            -> NoSpeechHeard
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY,
            SpeechRecognizer.ERROR_SERVER,
            -> EngineFailure("the recognizer was busy")
            else -> EngineFailure("")
        }
    }
}
