package com.gradethread.app.plangate

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.platform.net.PlanGateNotifier
import com.gradethread.app.platform.telemetry.Telemetry
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1367: subscribes the shell to the plan-gate signals.
 *
 * All the judgement lives in [PlanGatePresentation]; this only collects and
 * stores. Both flows are collected in separate coroutines because they are
 * independent — a warning must not wait behind a dialog nobody has read yet.
 */
@HiltViewModel
class PlanGateViewModel @Inject constructor() : ViewModel() {

    private val _state = MutableStateFlow(PlanGatePresentation.State())
    val state: StateFlow<PlanGatePresentation.State> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            PlanGateNotifier.gates.collect { gate ->
                Telemetry.event(
                    "plan_gate.blocked",
                    mapOf("cap" to gate.cap, "feature" to gate.feature, "plan" to gate.plan),
                )
                _state.value = PlanGatePresentation.onGate(_state.value, gate)
            }
        }
        viewModelScope.launch {
            PlanGateNotifier.warnings.collect { warning ->
                _state.value = PlanGatePresentation.onWarning(_state.value, warning)
            }
        }
    }

    fun dismissWarning() {
        _state.value = PlanGatePresentation.dismissWarning(_state.value)
    }

    fun dismissGate() {
        _state.value = PlanGatePresentation.dismissGate(_state.value)
    }
}
