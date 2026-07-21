package com.gradethread.app.billing

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.grading.GradeTier
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1338: the credit-pack paywall, rendered INSIDE the grade sheet.
 *
 * In-flow on purpose: a seller who has to leave the grading flow to buy credits
 * and then find their way back is a seller who mostly doesn't come back.
 *
 * @param creditBalance the balance the grade sheet already validated — passed
 *   in rather than re-fetched so the poll baseline is the number the seller is
 *   actually looking at.
 * @param onGranted re-validate; the server decides whether submit unblocks.
 */
@Composable
fun CreditPackSheet(
    itemId: String,
    tier: GradeTier,
    creditsRequired: Int,
    creditBalance: Int,
    onGranted: suspend () -> Unit,
    modifier: Modifier = Modifier,
    /** "single" or "bulk" — keeps the two funnels distinguishable. */
    surface: String = "single",
    viewModel: CreditTopUpViewModel = hiltViewModel(),
) {
    val context = LocalContext.current
    val state by viewModel.state.collectAsState()

    LaunchedEffect(itemId, tier) { viewModel.open(itemId, tier, creditsRequired, surface) }
    LaunchedEffect(creditBalance) { viewModel.observedBalance(creditBalance) }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(
                MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.5f),
                RoundedCornerShape(12.dp),
            )
            .padding(Spacing.sm),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(
            "This grade needs $creditsRequired credits and you have $creditBalance.",
            style = MaterialTheme.typography.bodyMedium,
        )

        when (val phase = state.phase) {
            is CreditTopUpFlow.State.Granted -> Text(
                "Credits added — you now have ${phase.balance}.",
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
            )

            CreditTopUpFlow.State.AwaitingGrant, CreditTopUpFlow.State.Purchasing -> Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
            ) {
                CircularProgressIndicator(Modifier.padding(Spacing.xxs))
                Text(
                    if (phase == CreditTopUpFlow.State.Purchasing) {
                        "Opening Google Play…"
                    } else {
                        "Adding your credits…"
                    },
                    style = MaterialTheme.typography.bodySmall,
                )
            }

            CreditTopUpFlow.State.TimedOut -> Column {
                Text(
                    "Google Play took the payment but the credits haven't landed yet. " +
                        "They will — this is usually a short delay.",
                    style = MaterialTheme.typography.bodySmall,
                )
                BrandSecondaryButton(text = "Check again", modifier = Modifier.fillMaxWidth()) {
                    viewModel.recheck(onGranted)
                }
            }

            else -> {
                state.offers.forEach { offer ->
                    PackRow(
                        offer = offer,
                        enabled = !state.busy,
                        onClick = {
                            context.findActivity()?.let { activity ->
                                viewModel.purchase(activity, offer.pack, onGranted)
                            }
                        },
                    )
                }
            }
        }

        state.errorMessage?.let { message ->
            Text(
                message,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}

@Composable
private fun PackRow(offer: CreditPackOffer, enabled: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = Spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            offer.pack.label,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f),
        )
        Text(offer.priceLabel, style = MaterialTheme.typography.labelLarge)
    }
}

/**
 * Play's purchase flow needs the hosting Activity, and a Compose `LocalContext`
 * is frequently a ContextWrapper rather than the Activity itself.
 */
private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
