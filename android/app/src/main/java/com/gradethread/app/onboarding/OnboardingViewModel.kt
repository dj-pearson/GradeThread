package com.gradethread.app.onboarding

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.auth.AuthRepository
import com.gradethread.app.marketplaces.MarketplaceConnectionRepository
import com.gradethread.app.platform.push.PushPermission
import com.gradethread.app.platform.telemetry.Telemetry
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1384: the first-run flow.
 *
 * Shown once, to a signed-in seller, before anything else in the shell. It
 * ends by routing to a first ACTION rather than a dashboard — someone who
 * just signed up has no data yet, so an empty dashboard is the app teaching
 * them it is empty.
 */
@HiltViewModel
class OnboardingViewModel @Inject constructor(
    @ApplicationContext private val context: Context,
    private val store: OnboardingStore,
    private val auth: AuthRepository,
    private val connections: MarketplaceConnectionRepository,
) : ViewModel() {

    data class State(
        val visible: Boolean = false,
        val step: Onboarding.Step = Onboarding.Step.CAROUSEL,
        val pageIndex: Int = 0,
        val useCase: OnboardingUseCase? = null,
        val checklist: List<ActivationChecklist.Row> = emptyList(),
        /** Set when finishing; the host consumes it and navigates. */
        val navigateTo: String? = null,
    ) {
        @get:androidx.annotation.StringRes
        val primaryLabel: Int get() = Onboarding.primaryLabel(step, pageIndex)
        val progress: ActivationChecklist.Progress?
            get() = ActivationChecklist.progress(checklist)
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            auth.phase.collect { phase ->
                val signedIn = phase is AuthRepository.Phase.SignedIn
                val show = Onboarding.shouldShow(signedIn, store.completedNow())
                _state.value = _state.value.copy(visible = show)
                if (show) Telemetry.event("onboarding_started", emptyMap())
            }
        }
    }

    fun next() {
        val current = _state.value
        if (current.step == Onboarding.Step.ACTIVATION) {
            finish(current.useCase)
            return
        }
        val (step, page) = Onboarding.advance(current.step, current.pageIndex)
        _state.value = current.copy(step = step, pageIndex = page)
        if (step == Onboarding.Step.ACTIVATION) refreshChecklist()
    }

    fun setPage(index: Int) {
        _state.value = _state.value.copy(pageIndex = index)
    }

    fun pick(useCase: OnboardingUseCase) {
        _state.value = _state.value.copy(useCase = useCase)
    }

    /**
     * Skip.
     *
     * Records completion with NO use case, which is a real answer rather than a
     * missing one — the first-action nudge still fires, it just isn't tailored.
     */
    fun skip() {
        Telemetry.event("onboarding_skipped", mapOf("step" to _state.value.step.name))
        finish(useCase = null)
    }

    private fun finish(useCase: OnboardingUseCase?) {
        viewModelScope.launch {
            store.complete(useCase)
            Telemetry.event("onboarding_completed", mapOf("use_case" to (useCase?.wire ?: "none")))
            _state.value = _state.value.copy(
                visible = false,
                // Null when skipped: the shell lands on Home and nudges rather
                // than shoving someone into a camera they didn't ask for.
                navigateTo = useCase?.firstActionRoute,
            )
        }
    }

    fun onNavigated() {
        _state.value = _state.value.copy(navigateTo = null)
    }

    /** Re-read after the permission dialog or an eBay round trip. */
    fun refreshChecklist() {
        viewModelScope.launch {
            val ebay = runCatching { connections.list() }.getOrDefault(emptyList())
            _state.value = _state.value.copy(
                checklist = ActivationChecklist.rows(
                    notificationsRequired = PushPermission.required,
                    notificationsGranted = PushPermission.granted(context),
                    notificationsAsked = store.notificationsAsked(),
                    ebayConnected = ebay.any { !it.needsReconnect },
                ),
            )
        }
    }

    /** The one system dialog we get; never put up twice. */
    fun markNotificationsAsked() {
        viewModelScope.launch {
            store.markNotificationsAsked()
            refreshChecklist()
        }
    }
}
