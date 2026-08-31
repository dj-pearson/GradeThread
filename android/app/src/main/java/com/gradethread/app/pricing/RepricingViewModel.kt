package com.gradethread.app.pricing

import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.sync.SyncService
import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/** US-1358: rules, suggestions, and the scan that fills them. */
@HiltViewModel
class RepricingViewModel @Inject constructor(private val service: RepricingService, private val sync: SyncService) :
    ViewModel() {

    data class State(
        val loading: Boolean = true,
        val rules: List<RepricingRule> = emptyList(),
        val suggestions: List<RepricingSuggestion> = emptyList(),
        val actions: List<RepricingAction> = emptyList(),
        val busy: Boolean = false,
        val scanning: Boolean = false,
        val banner: UiMessage? = null,
        val caveat: List<UiMessage> = emptyList(),
        val errorMessage: UiMessage? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun load() {
        _state.value = _state.value.copy(loading = true, errorMessage = null)
        viewModelScope.launch {
            val rules = runCatching { service.rules() }
            val suggestions = runCatching { service.suggestions() }
            val actions = runCatching { service.actions() }
            _state.value = _state.value.copy(
                loading = false,
                rules = rules.getOrDefault(_state.value.rules),
                suggestions = suggestions.getOrDefault(_state.value.suggestions),
                actions = actions.getOrDefault(_state.value.actions),
                // One failed section shouldn't blank the other two — they are
                // separate reads, and rules still matter when comps are down.
                errorMessage = listOfNotNull(
                    rules.exceptionOrNull(),
                    suggestions.exceptionOrNull(),
                    actions.exceptionOrNull(),
                ).firstOrNull()?.let { service.message(it) },
            )
        }
    }

    // ── rules ────────────────────────────────────────────────────────────────

    fun saveRule(draft: RuleDraft) {
        Repricing.validationError(draft)?.let {
            _state.value = _state.value.copy(errorMessage = it)
            return
        }
        act(if (draft.id == null) R.string.repricing_rule_saved else R.string.repricing_rule_updated) {
            if (draft.id == null) service.createRule(draft) else service.updateRule(draft.id, draft)
            Telemetry.event("repricing_rule_saved", mapOf("new" to (draft.id == null)))
        }
    }

    fun deleteRule(rule: RepricingRule) = act(R.string.repricing_rule_deleted) { service.deleteRule(rule.id) }

    fun toggleRule(rule: RepricingRule) {
        val draft = RuleDraft.from(rule).copy(enabled = !rule.enabled)
        act(if (draft.enabled) R.string.repricing_rule_on else R.string.repricing_rule_off) {
            service.updateRule(rule.id, draft)
        }
    }

    // ── suggestions ──────────────────────────────────────────────────────────

    /**
     * Look for new suggestions now.
     *
     * Kept separate from [load] and given its own flag: a scan calls eBay for
     * every listing it checks, so it is slow enough that a shared spinner would
     * read as the whole screen hanging.
     */
    fun scan() {
        if (_state.value.scanning) return
        _state.value = _state.value.copy(
            scanning = true,
            errorMessage = null,
            banner = null,
            caveat = emptyList(),
        )
        viewModelScope.launch {
            runCatching { service.scan() }
                .onSuccess { result ->
                    _state.value = _state.value.copy(
                        scanning = false,
                        banner = Repricing.scanSummary(result),
                        // What the scan couldn't check is reported too, so a
                        // quiet "nothing to change" can't hide a fixable gap.
                        caveat = Repricing.scanCaveat(result),
                        suggestions = runCatching { service.suggestions() }
                            .getOrDefault(_state.value.suggestions),
                    )
                }
                .onFailure {
                    _state.value = _state.value.copy(
                        scanning = false,
                        errorMessage = service.message(it),
                    )
                }
        }
    }

    fun apply(suggestion: RepricingSuggestion) {
        act(R.string.repricing_applied) {
            service.apply(suggestion.id)
            Telemetry.event("repricing_suggestion_applied", mapOf("reason" to suggestion.reasonCode))
            // Applying moves a live price; pull so the listing row on this
            // device isn't still showing the old one.
            sync.pull()
        }
        drop(suggestion)
    }

    fun dismiss(suggestion: RepricingSuggestion) {
        act(null) { service.dismiss(suggestion.id) }
        drop(suggestion)
    }

    /** Take it off the list straight away — either way it's no longer pending. */
    private fun drop(suggestion: RepricingSuggestion) {
        _state.value = _state.value.copy(
            suggestions = _state.value.suggestions.filterNot { it.id == suggestion.id },
        )
    }

    fun dismissMessages() {
        _state.value =
            _state.value.copy(banner = null, caveat = emptyList(), errorMessage = null)
    }

    private fun act(@StringRes successMessage: Int?, action: suspend () -> Unit) {
        if (_state.value.busy) return
        _state.value = _state.value.copy(busy = true, errorMessage = null, banner = null)
        viewModelScope.launch {
            runCatching { action() }
                .onSuccess {
                    _state.value = _state.value.copy(
                        busy = false,
                        banner = successMessage?.let { UiMessage(it) },
                    )
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
