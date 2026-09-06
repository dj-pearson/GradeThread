package com.gradethread.app.scout

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.inventory.CategorySuggestion
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1374: ScoutAI.
 */
@HiltViewModel
class ScoutViewModel @Inject constructor(private val service: ScoutScanning) : ViewModel() {

    data class State(
        val keyword: String = "",
        val brand: String = "",
        val sort: ScoutSort = ScoutSort.MARGIN,
        val actionableOnly: Boolean = false,
        val scanning: Boolean = false,
        val response: ScoutScanResponse? = null,
        /** The category the last scan actually used; null means the fallback. */
        val resolvedCategory: CategorySuggestion? = null,
        val errorMessage: UiMessage? = null,
        /**
         * Set when the failure was a plan wall. The shell is already showing
         * the upgrade dialog, so this screen hides its retry.
         */
        val planWall: ScoutError? = null,
    ) {
        val candidates: List<ScoutCandidate>
            get() = ScoutDisplay.display(response?.candidates.orEmpty(), sort, actionableOnly)

        val canScan: Boolean get() = ScoutDisplay.canScan(keyword, brand, scanning)

        val categoryLabel: String
            get() = resolvedCategory?.categoryName ?: ScoutDisplay.APPAREL_ROOT_NAME

        val summary: UiMessage
            get() = ScoutDisplay.summary(response, candidates.size)

        /** A retry can only help when the wall isn't the plan. */
        val canRetry: Boolean get() = errorMessage != null && planWall == null
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun setKeyword(value: String) {
        _state.value = _state.value.copy(keyword = value)
    }

    fun setBrand(value: String) {
        _state.value = _state.value.copy(brand = value)
    }

    fun setSort(value: ScoutSort) {
        _state.value = _state.value.copy(sort = value)
    }

    fun toggleActionableOnly() {
        _state.value = _state.value.copy(actionableOnly = !_state.value.actionableOnly)
    }

    fun scan() {
        val current = _state.value
        if (!current.canScan) return
        val keyword = current.keyword.trim()
        val brand = current.brand.trim()

        _state.value = current.copy(scanning = true, errorMessage = null, planWall = null)
        Telemetry.event("scout.scan_started")

        viewModelScope.launch {
            // Resolve a sharper category first. A failure is deliberately
            // non-fatal: falling back to the apparel root gives broader results,
            // which beats refusing to scan at all.
            val suggestion = service.suggestCategory(ScoutDisplay.categoryProbe(keyword, brand))
            val categoryId = suggestion?.categoryId ?: ScoutDisplay.APPAREL_ROOT_ID

            runCatching {
                service.scan(
                    categoryId = categoryId,
                    q = keyword.takeIf { it.isNotEmpty() },
                    brand = brand.takeIf { it.isNotEmpty() },
                    limit = ScoutDisplay.SCAN_LIMIT,
                )
            }.fold(
                onSuccess = { response ->
                    Telemetry.event(
                        "scout.scan_completed",
                        mapOf(
                            "scanned" to response.scanned,
                            "actionable" to response.candidates.count { it.actionable },
                        ),
                    )
                    _state.value = _state.value.copy(
                        scanning = false,
                        response = response,
                        resolvedCategory = suggestion,
                    )
                },
                onFailure = { error ->
                    val wall = ScoutError.from(error)
                    if (wall != null) Telemetry.event("scout.plan_wall")
                    _state.value = _state.value.copy(
                        scanning = false,
                        // The previous results stay on screen. They were valid
                        // when they arrived and a failed re-scan doesn't
                        // un-find the deals.
                        resolvedCategory = suggestion,
                        planWall = wall,
                        errorMessage = errorMessage(wall, error, R.string.scout_scan_failed),
                    )
                },
            )
        }
    }

    fun dismissError() {
        _state.value = _state.value.copy(errorMessage = null, planWall = null)
    }
}
