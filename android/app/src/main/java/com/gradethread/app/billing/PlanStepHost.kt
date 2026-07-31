package com.gradethread.app.billing

import android.app.Activity
import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.R
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1367 AC2: the plan step a new seller sees once, and never again.
 *
 * Deliberately skippable. Someone who has just signed up has not seen the app
 * do anything yet, and a wall between them and the product is the single
 * easiest way to lose them — the step exists to make the plans KNOWN, not to
 * make them mandatory.
 */
@HiltViewModel
class PlanStepViewModel @Inject constructor(
    @ApplicationContext context: Context,
    private val subscriptions: SubscriptionService,
    private val plans: AccountPlanReader,
) : ViewModel() {

    data class State(
        val visible: Boolean = false,
        val rows: List<PaywallPricing.TierRow> = emptyList(),
        val purchasing: Boolean = false,
        val errorMessage: String? = null,
    )

    private val store = PlanStepStore(context)
    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    private val userId: String? get() = plans.signedInUserId()

    /** Decide whether to show the step, then load prices only if we will. */
    fun evaluate() {
        viewModelScope.launch {
            val id = userId
            val seen = store.seen.first()
            // The plan comes from the SERVER, not from what Play told this
            // device: someone who subscribed on the web has never seen this step
            // and must not be sold their own plan back.
            if (!PlanStep.shouldShow(id, seen, plans.current())) return@launch

            Telemetry.event("plan_step.shown")
            subscriptions.refresh()
            val subs = subscriptions.state.value
            _state.value = State(
                visible = true,
                // Yearly, because that is the plan a seller who is going to
                // subscribe should be looking at, and it is the cheaper one.
                rows = PaywallPricing.rows(
                    subs.offers,
                    SubscriptionInterval.YEARLY,
                    currentPlan = null,
                ),
            )
        }
    }

    fun choose(activity: Activity, row: PaywallPricing.TierRow) {
        if (!row.purchasable) return
        _state.value = _state.value.copy(purchasing = true, errorMessage = null)
        viewModelScope.launch {
            val launched = subscriptions.purchase(activity, row.offer)
            _state.value = _state.value.copy(
                purchasing = false,
                errorMessage = if (launched) null else subscriptions.state.value.errorMessage,
            )
            // Dismissed on LAUNCH, not on a completed purchase: Play owns the
            // dialog from here, the process-wide listener applies whatever comes
            // back, and holding this screen open behind Play's sheet would strand
            // anyone who backs out.
            if (launched) dismiss(purchased = true)
        }
    }

    /** "Continue on Free" — always dismisses, and never asks again. */
    fun continueOnFree() {
        Telemetry.event("plan_step.continued_free")
        dismiss(purchased = false)
    }

    private fun dismiss(purchased: Boolean) {
        _state.value = _state.value.copy(visible = false)
        val id = userId ?: return
        viewModelScope.launch {
            // Marked seen either way. Choosing free is a decision; asking again
            // tomorrow would treat it as an accident.
            store.markSeen(id)
            if (purchased) Telemetry.event("plan_step.chose_plan")
        }
    }
}

/**
 * The step itself, rendered over the shell.
 *
 * A full-height Surface rather than a dialog: it is the first thing a new seller
 * sees, and a dialog with six plan rows in it is a scroll trap on a small phone.
 */
@Composable
fun PlanStepHost(viewModel: PlanStepViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()
    val context = LocalContext.current
    val activity = context as? Activity
    LaunchedEffect(Unit) { viewModel.evaluate() }

    if (!state.visible) return

    Surface(Modifier.fillMaxSize()) {
        Column(
            Modifier.fillMaxSize().padding(Spacing.md),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            Text(
                stringResource(R.string.planstep_title),
                style = MaterialTheme.typography.titleLarge,
            )
            Text(
                stringResource(R.string.planstep_subtitle),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            state.errorMessage?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            LazyColumn(
                Modifier.fillMaxWidth().weight(1f),
                verticalArrangement = Arrangement.spacedBy(Spacing.sm),
            ) {
                items(state.rows, key = { it.offer.product.productId }) { row ->
                    Column(
                        Modifier.fillMaxWidth().cardStyle(),
                        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
                    ) {
                        Text(row.plan.label, style = MaterialTheme.typography.titleMedium)
                        Text(
                            PaywallPricing.priceLine(row),
                            style = MaterialTheme.typography.bodyLarge,
                        )
                        row.savingsPercent?.let {
                            Text(
                                stringResource(R.string.planstep_savings, it),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.primary,
                            )
                        }
                        val blocked = PaywallPricing.blockedReason(row)
                        if (blocked != null) {
                            Text(
                                blocked,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        } else {
                            BrandPrimaryButton(
                                text = stringResource(R.string.planstep_choose, row.plan.label),
                                enabled = !state.purchasing,
                                modifier = Modifier.fillMaxWidth(),
                            ) { activity?.let { viewModel.choose(it, row) } }
                        }
                    }
                }
            }

            BrandSecondaryButton(
                text = stringResource(R.string.planstep_continue_free),
                modifier = Modifier.fillMaxWidth(),
            ) { viewModel.continueOnFree() }
        }
    }
}
