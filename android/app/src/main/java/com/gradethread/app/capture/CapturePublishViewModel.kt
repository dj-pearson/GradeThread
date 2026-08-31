package com.gradethread.app.capture

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.ai.AiExtractMessages
import com.gradethread.app.ui.UiMessage
import com.gradethread.app.ai.AiExtractionManager
import com.gradethread.app.sync.ConnectivityMonitor
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1334: the capture screen's "Continue" — publish the session, then hand
 * off to the AI step.
 *
 * The extraction is STARTED here rather than on the AI screen so it begins
 * the instant the uploads are enqueued, instead of a navigation frame later,
 * and so a seller who backs straight out still gets their item filled in.
 */
@HiltViewModel
class CapturePublishViewModel @Inject constructor(
    private val publisher: CapturePublisher,
    private val manager: AiExtractionManager,
    private val profiles: PhotoProfileStore,
    @ApplicationContext private val context: Context,
) : ViewModel() {

    /**
     * US-2498: the server-authoritative photo profile. Camera-first intake has
     * no item and therefore no category yet, so this resolves the DEFAULT
     * clothing profile - but the server's, whose roles are named (brand label,
     * size tag, fabric close-up) instead of the numbered `tag_2` / `detail_2`
     * slots the strip used to offer.
     *
     * Starts on the bundled copy so the first frame renders, and only ever moves
     * forward: a failed fetch leaves the fallback in place rather than emptying
     * the strip.
     */
    private val _profile = MutableStateFlow(PhotoProfile.clothingFallback)
    val profile: StateFlow<PhotoProfile> = _profile.asStateFlow()

    init {
        viewModelScope.launch {
            profiles.loadIfNeeded()
            _profile.value = profiles.profileFor(null, null)
        }
    }

    data class State(
        val publishing: Boolean = false,
        /** Set once; the screen navigates and clears it. */
        val publishedItemId: String? = null,
        val errorMessage: UiMessage? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun publish(session: PhotoIntakeStore.State, profile: PhotoProfile = PhotoProfile.clothingFallback) {
        if (_state.value.publishing) return
        _state.value = State(publishing = true)

        viewModelScope.launch {
            publisher.publish(session, profile)
                .onSuccess { plan ->
                    // Read synchronously off the active network: a cold
                    // offline start must take the OCR branch immediately
                    // rather than wait 180s for uploads that can't happen.
                    val online = ConnectivityMonitor(context).online.value
                    manager.start(
                        itemId = plan.itemId,
                        uploads = plan.uploads,
                        gateSortOrders = plan.gateSortOrders,
                        isOnline = online,
                    )
                    _state.value = State(publishedItemId = plan.itemId)
                }
                .onFailure { error ->
                    _state.value = State(errorMessage = AiExtractMessages.forError(error))
                }
        }
    }

    /** The screen consumed the navigation signal. */
    fun onNavigated() {
        _state.value = _state.value.copy(publishedItemId = null)
    }

    fun dismissError() {
        _state.value = _state.value.copy(errorMessage = null)
    }
}
