package com.gradethread.app.automations

import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.R
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.ui.UiMessage
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/** US-1362: the automations screen. */
@HiltViewModel
class AutomationsViewModel @Inject constructor(private val service: AutomationsService) : ViewModel() {

    data class State(
        val loading: Boolean = true,
        val rules: List<AutomationRule> = emptyList(),
        /** The rule whose dry run is on screen, and its result. */
        val dryRunFor: String? = null,
        val dryRun: AutomationDryRunResult? = null,
        val actions: List<AutomationActionRow> = emptyList(),
        /** How many changes never reached eBay; the screen picks the plural. */
        val unsyncedCount: Int? = null,
        val busy: Boolean = false,
        val banner: UiMessage? = null,
        val warning: UiMessage? = null,
        val errorMessage: UiMessage? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun load() {
        _state.value = _state.value.copy(loading = true, errorMessage = null)
        viewModelScope.launch {
            runCatching { service.rules() }
                .onSuccess { _state.value = _state.value.copy(rules = it, loading = false) }
                .onFailure {
                    _state.value = _state.value.copy(
                        loading = false,
                        errorMessage = service.message(it),
                    )
                }
        }
    }

    fun save(draft: AutomationDraft) {
        Automations.validationError(draft)?.let {
            _state.value = _state.value.copy(errorMessage = it)
            return
        }
        act(if (draft.id == null) R.string.automation_saved else R.string.automation_updated) {
            if (draft.id == null) service.create(draft) else service.update(draft.id, draft)
            Telemetry.event(
                "automation_rule_saved",
                mapOf("action" to draft.actionType, "scope" to draft.scopeMode),
            )
        }
        // A filter whose clauses were all incomplete becomes "all listings".
        // Saying so at save time is the only moment it can still surprise them.
        if (Automations.scopeSilentlyWidened(draft)) {
            _state.value = _state.value.copy(
                warning = UiMessage(R.string.automation_scope_widened),
            )
        }
    }

    fun setActive(rule: AutomationRule, isActive: Boolean) =
        act(if (isActive) R.string.automation_turned_on else R.string.automation_turned_off) {
            service.setActive(rule.id, isActive)
        }

    fun delete(rule: AutomationRule) = act(R.string.automation_deleted) { service.delete(rule.id) }

    /**
     * Show what a rule would do, without doing it.
     *
     * Worth its own action: these rules cut prices and end listings on a timer,
     * and a dry run is the only way to see the blast radius before the cron
     * does it for real.
     */
    fun dryRun(rule: AutomationRule) {
        if (_state.value.busy) return
        _state.value = _state.value.copy(
            busy = true,
            dryRunFor = rule.id,
            dryRun = null,
            errorMessage = null,
            banner = null,
        )
        viewModelScope.launch {
            runCatching { service.dryRun(rule.id) }
                .onSuccess {
                    _state.value = _state.value.copy(
                        busy = false,
                        dryRun = it,
                        banner = Automations.dryRunSummary(it),
                    )
                }
                .onFailure {
                    _state.value = _state.value.copy(
                        busy = false,
                        dryRunFor = null,
                        errorMessage = service.message(it),
                    )
                }
        }
    }

    fun loadActions(rule: AutomationRule) {
        viewModelScope.launch {
            runCatching { service.actions(rule.id) }
                .onSuccess {
                    _state.value = _state.value.copy(
                        actions = it,
                        // A change that never reached eBay is the one worth
                        // interrupting for: the buyer still sees the old value.
                        unsyncedCount = Automations.unsyncedCount(it),
                    )
                }
                .onFailure { /* the feed is supporting detail; the rules still load */ }
        }
    }

    fun runNow() = act(null) {
        val result = service.runNow()
        _state.value = _state.value.copy(banner = Automations.runSummary(result))
    }

    fun closeDryRun() {
        _state.value = _state.value.copy(dryRunFor = null, dryRun = null)
    }

    fun dismissMessages() {
        _state.value = _state.value.copy(banner = null, warning = null, errorMessage = null)
    }

    private fun act(@StringRes successMessage: Int?, action: suspend () -> Unit) {
        if (_state.value.busy) return
        _state.value = _state.value.copy(busy = true, errorMessage = null, banner = null)
        viewModelScope.launch {
            runCatching { action() }
                .onSuccess {
                    successMessage?.let {
                        _state.value = _state.value.copy(banner = UiMessage(it))
                    }
                    _state.value = _state.value.copy(busy = false)
                    load()
                }
                .onFailure {
                    _state.value = _state.value.copy(
                        busy = false,
                        errorMessage = service.message(it),
                    )
                }
        }
    }
}
