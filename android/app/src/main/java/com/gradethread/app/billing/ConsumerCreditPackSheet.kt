package com.gradethread.app.billing

import androidx.compose.foundation.background
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.R
import com.gradethread.app.ui.theme.Spacing

/**
 * US-2830: the credit packs, inside the consumer photo-grade flow.
 *
 * IN-FLOW ON PURPOSE, for the reason US-1338 gives about the FlipDesk sheet and
 * which is stronger here: by this point the seller has already chosen a garment,
 * filled in its details, taken or picked every required photo and waited through
 * an upload. Sending them somewhere else to buy is asking them to abandon all of
 * that and find their way back.
 *
 * Before this existed the flow simply stopped. `Step.NeedsCredits` rendered a
 * notice reading "You are out of grades" and a pack size, with no control of any
 * kind — a price quoted and no way to pay it.
 *
 * @param onPurchase hand back to `ConsumerGradeFlow.creditsPurchased()`. This
 *   sheet never concludes the submission is paid; the pay route decides, and it
 *   is idempotent per submission so asking again is safe.
 */
@Composable
fun ConsumerCreditPackSheet(
    onPurchase: suspend () -> Unit,
    modifier: Modifier = Modifier,
    viewModel: ConsumerCreditTopUpViewModel = hiltViewModel(),
) {
    val context = LocalContext.current
    val state by viewModel.state.collectAsState()

    // Loads the price list AND settles anything already bought — see the view
    // model's `open`. A purchase paid for but never verified is otherwise
    // invisible and the buyer is out the money.
    LaunchedEffect(Unit) { viewModel.open(onPurchase) }

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
        if (state.purchasing) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
            ) {
                CircularProgressIndicator(Modifier.padding(Spacing.xxs))
                Text(
                    stringResource(R.string.credits_opening_play),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        } else {
            state.offers.forEach { offer ->
                PackRow(
                    offer = offer,
                    enabled = true,
                    onClick = {
                        context.findActivity()?.let { activity ->
                            viewModel.purchase(activity, offer.pack, onPurchase)
                        }
                    },
                )
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
