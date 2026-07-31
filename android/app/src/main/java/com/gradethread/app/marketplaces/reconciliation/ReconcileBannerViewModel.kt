package com.gradethread.app.marketplaces.reconciliation

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1356: the shell-wide banner's state.
 *
 * Lives above the tabs because the queue does not belong to one of them: a
 * seller who reconciles from the Money tab shouldn't have to know the feature
 * hides under Marketplaces.
 */
@HiltViewModel
class ReconcileBannerViewModel @Inject constructor(
    @ApplicationContext context: Context,
    service: ReconciliationService,
) : ViewModel() {

    private val store = ReconcileBadgeStore(context, service)

    private val _state = MutableStateFlow(ReconcileBadgeState())
    val state: StateFlow<ReconcileBadgeState> = _state.asStateFlow()

    fun refresh() {
        viewModelScope.launch {
            val snoozedUntil = store.snoozedUntil.first()
            val baseline = store.snoozeBaseline.first()
            // A failed read keeps the previous count. A network blip is not
            // "you've reconciled everything", and blinking the banner away
            // would say exactly that.
            val count = store.refresh() ?: _state.value.count
            _state.value = ReconcileBadgeState(
                count = count,
                snoozedUntilMs = snoozedUntil,
                snoozeBaseline = baseline,
            )
        }
    }

    /** Hide it for a day, unless more unmatched listings turn up meanwhile. */
    fun snooze() {
        val count = _state.value.count
        viewModelScope.launch {
            store.snooze(count)
            _state.value = _state.value.copy(
                snoozedUntilMs = System.currentTimeMillis() +
                    ReconcileBadgeState.SNOOZE_WINDOW_MS,
                snoozeBaseline = count.value,
            )
        }
    }
}
