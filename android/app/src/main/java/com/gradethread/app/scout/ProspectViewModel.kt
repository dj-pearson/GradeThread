package com.gradethread.app.scout

import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.capture.CurrencyAmount
import com.gradethread.app.platform.di.IoDispatcher
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import javax.inject.Inject

/**
 * US-1374: in-store prospecting.
 *
 * Someone is stood in a shop deciding whether to hand over money. Every state
 * here is written on the assumption that a confident-sounding wrong answer
 * costs them cash.
 */
@HiltViewModel
class ProspectViewModel @Inject constructor(
    private val service: ScoutScanning,
    // US-3027: injected rather than reached for inline. See [IoDispatcher] -
    // the inline form is why four of this screen's tests sat red on main
    // describing a bug that was not in the code they were testing.
    @IoDispatcher private val io: CoroutineDispatcher,
) : ViewModel() {

    data class State(
        /**
         * At most one photo per role, held in role order (US-3027).
         *
         * A list of PAIRS rather than a list of files plus a list of roles: the
         * role is a property of the picture, and the two are never separated on
         * this side of the wire.
         */
        val photos: List<ProspectPhoto> = emptyList(),
        val costText: String = "",
        val running: Boolean = false,
        val response: ProspectResponse? = null,
        val buying: Boolean = false,
        val boughtItemId: String? = null,
        val errorMessage: UiMessage? = null,
        val planWall: ScoutError? = null,
    ) {
        val costCents: Int? get() = CurrencyAmount.parseCents(costText)?.toInt()

        val canRun: Boolean get() = photos.isNotEmpty() && !running

        /** The photo in a slot, or null when that slot is still empty. */
        fun photoFor(role: ProspectPhotoRole): File? = photos.firstOrNull { it.role == role }?.file

        val canBuy: Boolean
            get() = ProspectDisplay.canBuy(response) && !buying && boughtItemId == null

        val canRetry: Boolean get() = errorMessage != null && planWall == null

        @get:StringRes
        val verdict: Int get() = ProspectDisplay.verdictLabel(response?.decision)

        val caveat: UiMessage? get() = response?.let { ProspectDisplay.caveat(it) }
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /**
     * Fill one named slot: the item photo, or the brand tag.
     *
     * Re-shooting a slot REPLACES it rather than adding a third picture, and the
     * result is re-sorted into role order so the wire is deterministic whichever
     * slot the seller filled first.
     */
    fun setPhoto(role: ProspectPhotoRole, file: File) {
        val current = _state.value
        _state.value = current.copy(
            photos = (current.photos.filterNot { it.role == role } + ProspectPhoto(role, file))
                .sortedBy { it.role.ordinal },
            // A new photo invalidates the old read. Keeping the previous verdict
            // on screen next to a different picture is how someone buys the
            // wrong thing.
            response = null,
            boughtItemId = null,
            errorMessage = null,
            planWall = null,
        )
    }

    /**
     * A photo could not be processed, so no photo was taken.
     *
     * Separate from a failed SCAN: nothing left the phone, and the seller's
     * next move is to shoot it again rather than to retry a request.
     */
    fun photoUnreadable() {
        _state.value = _state.value.copy(
            errorMessage = UiMessage(R.string.prospect_photos_unreadable),
        )
    }

    fun removePhoto(role: ProspectPhotoRole) {
        _state.value = _state.value.copy(
            photos = _state.value.photos.filterNot { it.role == role },
            response = null,
            boughtItemId = null,
        )
    }

    fun setCost(value: String) {
        // The verdict depends on the cost, so an edited cost invalidates it
        // rather than leaving a "buy" that was computed against a different
        // price.
        _state.value = _state.value.copy(costText = value, response = null, boughtItemId = null)
    }

    fun run() {
        val current = _state.value
        if (!current.canRun) return
        _state.value = current.copy(running = true, errorMessage = null, planWall = null)
        Telemetry.event(
            "prospect.started",
            mapOf(
                "photos" to current.photos.size,
                // Which slots were filled decides whether the edge can use visual
                // search at all, so it is the number worth having when someone
                // asks why a scan spent an AI action.
                "roles" to current.photos.joinToString(",") { it.role.wire },
            ),
        )

        viewModelScope.launch {
            val bytes = withContext(io) {
                // mapNotNull over the PAIR: a photo that will not read off disk
                // takes its role with it. Reading the files and the roles as two
                // separate lists is what would slide the tag's role onto the
                // front photo the moment one of them failed.
                current.photos.mapNotNull { photo ->
                    runCatching { ProspectPhotoBytes(photo.role, photo.file.readBytes()) }.getOrNull()
                }
            }
            if (bytes.isEmpty()) {
                _state.value = _state.value.copy(
                    running = false,
                    errorMessage = UiMessage(R.string.prospect_photos_unreadable),
                )
                return@launch
            }

            runCatching { service.prospect(bytes, current.costCents) }.fold(
                onSuccess = { response ->
                    Telemetry.event(
                        "prospect.completed",
                        mapOf(
                            "identified" to response.identified,
                            "recommendation" to (response.decision?.recommendation ?: "none"),
                        ),
                    )
                    _state.value = _state.value.copy(running = false, response = response)
                },
                onFailure = { error -> _state.value = failed(error) },
            )
        }
    }

    /**
     * Commit it to inventory at `sourced`.
     *
     * [untitled] is R.string.prospect_untitled_item, resolved by the screen.
     * The title is stored on the row and read back later, so it has to be in
     * the seller's language and this class has no Context to resolve it.
     */
    fun buy(untitled: String) {
        val current = _state.value
        val response = current.response ?: return
        if (!current.canBuy) return
        _state.value = current.copy(buying = true, errorMessage = null)

        viewModelScope.launch {
            runCatching {
                service.buy(
                    ProspectBuyRequest(
                        title = ProspectDisplay.buyTitle(response.item) ?: untitled,
                        brand = response.item.brand,
                        costCents = current.costCents,
                        // The going rate becomes the target price — it is the
                        // number the comp pipeline actually stands behind.
                        targetCents = response.stats?.medianCents,
                        gradeValue = response.grade?.value,
                        gradeLabel = response.grade?.tier,
                    ),
                )
            }.fold(
                onSuccess = { bought ->
                    Telemetry.event("prospect.bought")
                    _state.value = _state.value.copy(buying = false, boughtItemId = bought.id)
                },
                onFailure = { error ->
                    _state.value = failed(error).copy(buying = false)
                },
            )
        }
    }

    fun reset() {
        _state.value = State()
    }

    fun dismissError() {
        _state.value = _state.value.copy(errorMessage = null, planWall = null)
    }

    private fun failed(error: Throwable): State {
        val wall = ScoutError.from(error)
        if (wall != null) Telemetry.event("prospect.plan_wall")
        return _state.value.copy(
            running = false,
            buying = false,
            planWall = wall,
            errorMessage = errorMessage(wall, error, R.string.prospect_retry_failed),
        )
    }
}
