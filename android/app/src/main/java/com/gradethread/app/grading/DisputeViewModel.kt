package com.gradethread.app.grading

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.sync.SyncTrigger
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1340: the dispute form's state.
 */
@HiltViewModel
class DisputeViewModel @Inject constructor(
    private val service: DisputeService,
    private val syncTrigger: SyncTrigger,
) : ViewModel() {

    data class State(
        val gradeReportId: String? = null,
        val reason: DisputeReason = DisputeReason.GRADE_TOO_LOW,
        val details: String = "",
        val submitting: Boolean = false,
        /** Set the moment the filing succeeds — the badge flips before sync. */
        val filed: DisputeRow? = null,
        /** A dispute that already existed when the sheet opened. */
        val existing: DisputeRow? = null,
        val errorMessage: String? = null,
        val evidenceFailures: Int = 0,
    ) {
        val canSubmit: Boolean
            get() = !submitting &&
                filed == null &&
                existing == null &&
                DisputeComposer.canSubmit(reason, details)

        /** The composed text that will be stored, shown back before filing. */
        val preview: String get() = DisputeComposer.compose(reason, details)

        val needsDetails: Boolean get() = reason == DisputeReason.OTHER
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun bind(gradeReportId: String) {
        if (_state.value.gradeReportId == gradeReportId) return
        _state.value = State(gradeReportId = gradeReportId)
        viewModelScope.launch {
            // The re-file gate. Nothing at the server or database layer blocks a
            // duplicate, so a second dispute on the same grade would simply
            // land as a second row in the reviewer's queue.
            _state.value = _state.value.copy(existing = service.existing(gradeReportId))
        }
    }

    fun setReason(reason: DisputeReason) {
        _state.value = _state.value.copy(reason = reason, errorMessage = null)
    }

    fun setDetails(details: String) {
        _state.value = _state.value.copy(details = details, errorMessage = null)
    }

    fun submit() {
        val current = _state.value
        val reportId = current.gradeReportId ?: return
        if (!current.canSubmit) return

        _state.value = current.copy(submitting = true, errorMessage = null)
        viewModelScope.launch {
            runCatching { service.file(reportId, current.preview) }
                .onSuccess { response ->
                    _state.value = _state.value.copy(
                        submitting = false,
                        filed = response.dispute,
                        evidenceFailures = response.evidenceFailures,
                    )
                    Telemetry.event(
                        "grade.dispute_filed",
                        mapOf("reason" to current.reason.wire),
                    )
                    // The submission flipped to `disputed` server-side; pull so
                    // the row's badge matches without waiting for the next cycle.
                    runCatching { syncTrigger.refresh() }
                }
                .onFailure { error ->
                    _state.value = _state.value.copy(
                        submitting = false,
                        errorMessage = (error as? EdgeApiError)?.userMessage()
                            ?: error.message
                            ?: "Couldn't file that dispute. Please try again.",
                    )
                }
        }
    }
}
