package com.gradethread.app.marketplaces.postsale

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.money.Money
import com.gradethread.app.sync.db.SaleEntity
import com.gradethread.app.ui.components.InfoCard
import com.gradethread.app.ui.components.InfoTone
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-1357: after the sale — what still needs posting, and who to thank.
 */
@Composable
fun PostSaleScreen(
    onClose: () -> Unit = {},
    viewModel: PostSaleViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    val toShip by viewModel.toShip.collectAsState(initial = emptyList())
    val toThank by viewModel.toThank.collectAsState(initial = emptyList())
    var shipping by remember { mutableStateOf<SaleEntity?>(null) }
    var thanking by remember { mutableStateOf<SaleEntity?>(null) }

    LaunchedEffect(Unit) { viewModel.refresh() }

    Column(
        Modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text("After the sale", style = MaterialTheme.typography.titleLarge)

        state.errorMessage?.let { InfoCard("That didn't work", it, tone = InfoTone.Error) }
        state.banner?.let { InfoCard("Done", it, tone = InfoTone.Success) }

        LazyColumn(
            Modifier.fillMaxWidth().weight(1f),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            item {
                Text("To post (${toShip.size})", style = MaterialTheme.typography.titleMedium)
            }
            if (toShip.isEmpty()) {
                item { Hint("Nothing waiting to be posted.") }
            }
            items(toShip, key = { "ship-${it.id}" }) { sale ->
                SaleCard(
                    sale = sale,
                    actionLabel = "Mark shipped",
                    busy = state.busy,
                    onAction = { shipping = sale },
                )
            }

            item {
                Text(
                    "Feedback (${toThank.size})",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(top = Spacing.sm),
                )
            }
            if (toThank.isEmpty()) {
                item { Hint("Nobody waiting on feedback.") }
            }
            items(toThank, key = { "thank-${it.id}" }) { sale ->
                SaleCard(
                    sale = sale,
                    actionLabel = "Leave feedback",
                    busy = state.busy,
                    onAction = { thanking = sale },
                )
            }
        }

        BrandSecondaryButton(text = "Back", modifier = Modifier.fillMaxWidth()) { onClose() }
    }

    shipping?.let { sale ->
        var tracking by remember(sale.id) { mutableStateOf(sale.trackingNumber.orEmpty()) }
        var carrier by remember(sale.id) { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { shipping = null },
            title = { Text("Mark shipped") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                    OutlinedTextField(
                        value = tracking,
                        onValueChange = { tracking = it },
                        label = { Text("Tracking number") },
                        singleLine = true,
                    )
                    OutlinedTextField(
                        value = carrier,
                        onValueChange = { carrier = it },
                        label = { Text("Carrier (optional)") },
                        singleLine = true,
                    )
                    Text(
                        "This tells eBay and the buyer. Sending the same tracking twice " +
                            "is safe.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            },
            confirmButton = {
                TextButton(
                    enabled = PostSale.trackingNumber(tracking) != null && !state.busy,
                    onClick = {
                        viewModel.markShipped(sale, tracking, carrier)
                        shipping = null
                    },
                ) { Text("Mark shipped") }
            },
            dismissButton = { TextButton(onClick = { shipping = null }) { Text("Cancel") } },
        )
    }

    thanking?.let { sale ->
        var comment by remember(sale.id) { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { thanking = null },
            title = { Text("Leave feedback for ${sale.buyerUsername ?: "the buyer"}") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                    OutlinedTextField(
                        value = comment,
                        onValueChange = { comment = it },
                        label = { Text("Note (optional)") },
                    )
                    Text(
                        "eBay only lets sellers leave positive feedback, so there's no " +
                            "rating to pick.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            },
            confirmButton = {
                TextButton(
                    enabled = !state.busy,
                    onClick = {
                        viewModel.leaveFeedback(sale, comment.takeIf { it.isNotBlank() })
                        thanking = null
                    },
                ) { Text("Leave it") }
            },
            dismissButton = { TextButton(onClick = { thanking = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun SaleCard(
    sale: SaleEntity,
    actionLabel: String,
    busy: Boolean,
    onAction: () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Text(
            sale.buyerUsername ?: "Order ${sale.platformOrderId ?: sale.id.take(8)}",
            style = MaterialTheme.typography.bodyLarge,
            fontWeight = FontWeight.SemiBold,
        )
        Row {
            Text(Money.format(sale.salePrice), style = MaterialTheme.typography.bodyMedium)
            sale.trackingNumber?.takeIf { it.isNotBlank() }?.let {
                Text(
                    "   $it",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        BrandPrimaryButton(
            text = actionLabel,
            enabled = !busy,
            modifier = Modifier.fillMaxWidth(),
        ) { onAction() }
    }
}

@Composable
private fun Hint(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}
