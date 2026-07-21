package com.gradethread.app.snap

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.capture.PhotoProcessor
import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.platform.telemetry.Telemetry
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.File
import javax.inject.Inject

/**
 * US-1335: Snap-to-Value state (iOS `SnapStore`).
 *
 * Every free snap costs the account one of a bounded monthly allowance, so
 * this is stricter about double-firing than a normal load: the disabled button
 * is the affordance, the re-entry guard is the guarantee.
 */
@HiltViewModel
class SnapViewModel @Inject constructor(
    private val service: SnapService,
    @ApplicationContext private val context: Context,
) : ViewModel() {

    data class State(
        /** The processed (downsized, EXIF-stripped) photo to send. */
        val photo: File? = null,
        val brand: String = "",
        val keyword: String = "",
        val loading: Boolean = false,
        val result: SnapResponse? = null,
        val errorMessage: String? = null,
        /** True when the failure is a plan wall — offer upgrade, not retry. */
        val isUpgradePrompt: Boolean = false,
    ) {
        val canEvaluate: Boolean get() = photo != null && !loading
        val hasHints: Boolean get() = brand.isNotBlank() || keyword.isNotBlank()
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /**
     * Accept a captured or picked photo.
     *
     * Processing happens here, not at send time: [PhotoProcessor.process]
     * downsizes to the 2048px cap and re-encodes, which is what strips EXIF —
     * so a photo carrying GPS never reaches the wire, even though the edge
     * strips it again server-side. Defense in depth, and it keeps the payload
     * from being a 12MP original.
     */
    fun setPhoto(source: File) {
        viewModelScope.launch {
            val processed = runCatching {
                PhotoProcessor.process(source, File(context.cacheDir, "snap"))
            }.getOrNull()
            _state.value = if (processed == null) {
                _state.value.copy(
                    errorMessage = "Couldn't read that photo. Try another.",
                    isUpgradePrompt = false,
                )
            } else {
                // A new photo invalidates the previous verdict — leaving the
                // old grade on screen next to a new picture would read as if
                // we'd graded the new one.
                _state.value.copy(
                    photo = processed.file,
                    result = null,
                    errorMessage = null,
                    isUpgradePrompt = false,
                )
            }
        }
    }

    fun setBrand(value: String) {
        _state.value = _state.value.copy(brand = value)
    }

    fun setKeyword(value: String) {
        _state.value = _state.value.copy(keyword = value)
    }

    fun evaluate() {
        val current = _state.value
        // Synchronous re-entry guard behind the disabled button (iOS US-1497):
        // a double-tap must not spend two of a bounded monthly allowance.
        if (current.loading) return
        val photo = current.photo ?: return

        _state.value = current.copy(loading = true, errorMessage = null, isUpgradePrompt = false)
        viewModelScope.launch {
            runCatching { service.snap(photo, current.brand, current.keyword) }
                .onSuccess { response ->
                    _state.value = _state.value.copy(loading = false, result = response)
                    Telemetry.event(
                        "snap_evaluated",
                        mapOf(
                            "score" to response.grade.overallScore,
                            "tier" to response.grade.gradeTier,
                            "valued" to (response.value?.sufficient == true),
                            "had_hints" to current.hasHints,
                        ),
                    )
                }
                .onFailure { error ->
                    val upgrade = (error as? EdgeApiError)?.isUpgradePrompt == true
                    _state.value = _state.value.copy(
                        loading = false,
                        // The stale result is cleared: a failed re-run must not
                        // leave the previous grade looking like this one's.
                        result = null,
                        errorMessage = (error as? EdgeApiError)?.userMessage()
                            ?: error.message ?: "Something went wrong. Please try again.",
                        isUpgradePrompt = upgrade,
                    )
                }
        }
    }
}
