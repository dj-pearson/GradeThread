package com.gradethread.app.disclosure

import android.content.Context
import android.graphics.Bitmap
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import coil.imageLoader
import coil.request.ImageRequest
import com.gradethread.app.platform.telemetry.Telemetry
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import javax.inject.Inject

/**
 * US-1360: annotate the flaw photos, then push the disclosure into the live
 * listing.
 */
@HiltViewModel
class DisclosureViewModel @Inject constructor(
    @ApplicationContext private val context: Context,
    private val service: DisclosureService,
) : ViewModel() {

    data class State(
        val itemId: String = "",
        val loading: Boolean = true,
        val data: DisclosureData? = null,
        /** The photo being annotated, and its rendered composite. */
        val selected: DisclosurePhoto? = null,
        val preview: Bitmap? = null,
        val rendering: Boolean = false,
        val busy: Boolean = false,
        val banner: String? = null,
        val errorMessage: String? = null,
    ) {
        /** Photos that actually carry callouts — the rest have nothing to burn in. */
        val annotatable: List<DisclosurePhoto>
            get() = data?.photos.orEmpty().filter { it.annotations.isNotEmpty() }

        val hasDefects: Boolean get() = data?.disclosure?.hasDefects == true

        val defectCount: Int get() = data?.disclosure?.defectCount ?: 0
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun bind(itemId: String) {
        if (_state.value.itemId == itemId && !_state.value.loading) return
        _state.value = State(itemId = itemId)
        viewModelScope.launch {
            runCatching { service.disclosure(itemId) }
                .onSuccess { data ->
                    _state.value = _state.value.copy(loading = false, data = data)
                    // Pre-select the first photo with callouts: it's the one the
                    // seller came here for.
                    _state.value.annotatable.firstOrNull()?.let { select(it) }
                }
                .onFailure {
                    _state.value = _state.value.copy(
                        loading = false,
                        errorMessage = service.message(it),
                    )
                }
        }
    }

    /** Render the composite for one photo, so the seller sees what will upload. */
    fun select(photo: DisclosurePhoto) {
        _state.value = _state.value.copy(selected = photo, rendering = true, preview = null)
        viewModelScope.launch {
            val bitmap = loadBitmap(photo.url)
            if (bitmap == null) {
                _state.value = _state.value.copy(
                    rendering = false,
                    errorMessage = "Couldn't load that photo to annotate.",
                )
                return@launch
            }
            // Compositing is pixel work — off the main thread, or a large photo
            // drops frames on the screen that's showing it.
            val composite = withContext(Dispatchers.Default) {
                DisclosureRenderer.render(bitmap, photo)
            }
            _state.value = _state.value.copy(preview = composite, rendering = false)
        }
    }

    /**
     * Upload the composite for the selected photo.
     *
     * The image is encoded off the main thread too: a 900px PNG plus base64 is
     * a few megabytes of work, and doing it inline would freeze the sheet
     * mid-tap.
     */
    fun saveAnnotated() {
        val state = _state.value
        val photo = state.selected ?: return
        val preview = state.preview ?: return
        if (state.busy) return
        _state.value = state.copy(busy = true, errorMessage = null, banner = null)

        viewModelScope.launch {
            val dataUrl = withContext(Dispatchers.Default) { DisclosureRenderer.toDataUrl(preview) }
            runCatching { service.saveAnnotated(state.itemId, photo.imageType, dataUrl) }
                .onSuccess {
                    Telemetry.event("disclosure_photo_saved", emptyMap())
                    _state.value = _state.value.copy(
                        busy = false,
                        banner = "Annotated photo saved to this item.",
                    )
                }
                .onFailure {
                    _state.value = _state.value.copy(
                        busy = false,
                        errorMessage = service.message(it),
                    )
                }
        }
    }

    /**
     * Push the disclosure into the live listing.
     *
     * The server's own verdict is reported, not assumed: `applied: false` means
     * nothing changed on eBay, and calling that a success would leave a seller
     * believing a buyer can see a disclosure that isn't there.
     */
    fun applyToListing() {
        val state = _state.value
        if (state.busy || state.itemId.isBlank()) return
        _state.value = state.copy(busy = true, errorMessage = null, banner = null)

        viewModelScope.launch {
            runCatching { service.applyToListing(state.itemId) }
                .onSuccess { response ->
                    _state.value = _state.value.copy(
                        busy = false,
                        banner = when {
                            response.alreadyPresent == true ->
                                "The listing already showed this disclosure."

                            response.applied -> "Added to the live eBay description."
                            else -> null
                        },
                        errorMessage = if (!response.applied && response.alreadyPresent != true) {
                            "eBay didn't take the change. The listing description is unchanged."
                        } else {
                            null
                        },
                    )
                }
                .onFailure {
                    _state.value = _state.value.copy(
                        busy = false,
                        errorMessage = service.message(it),
                    )
                }
        }
    }

    fun dismissMessages() {
        _state.value = _state.value.copy(banner = null, errorMessage = null)
    }

    private suspend fun loadBitmap(url: String): Bitmap? = runCatching {
        val request = ImageRequest.Builder(context)
            .data(url)
            .allowHardware(false) // a hardware bitmap can't be drawn into a Canvas
            .build()
        val result = context.imageLoader.execute(request)
        (result.drawable as? android.graphics.drawable.BitmapDrawable)?.bitmap
    }.getOrNull()
}
