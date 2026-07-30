package com.gradethread.app.marketplaces.publish

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AssistChip
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.money.Money
import com.gradethread.app.ui.components.InfoCard
import com.gradethread.app.ui.components.InfoTone
import com.gradethread.app.ui.components.LabeledDropdown
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle
import kotlin.math.roundToInt

/**
 * US-1352: the publish composer sheet — title, condition and price with a live
 * profit estimate, pre-flight review, then publish or relist.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PublishSheet(
    itemId: String,
    onDismiss: () -> Unit,
    onOpenListing: (String) -> Unit,
    viewModel: PublishViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    LaunchedEffect(itemId) { viewModel.bind(itemId) }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Spacing.md)
                .padding(bottom = Spacing.lg),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            Text(
                if (state.relist) "Relist on eBay" else "List on eBay",
                style = MaterialTheme.typography.titleLarge,
            )
            if (state.relist) {
                Text(
                    "This item has been listed before. Publishing ends the old listing " +
                        "first, then creates a new one.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            state.errorMessage?.let {
                InfoCard("Check this first", it, tone = InfoTone.Warning)
            }

            when (val phase = state.phase) {
                is PublishPhase.Published -> PublishedPanel(phase.result, onOpenListing, onDismiss)
                is PublishPhase.PlanLimit -> InfoCard(
                    "You've hit a plan limit",
                    phase.message,
                    tone = InfoTone.Warning,
                )

                is PublishPhase.Failed -> {
                    InfoCard("Publish failed", phase.message, tone = InfoTone.Error)
                    BrandSecondaryButton(
                        text = "Back to the composer",
                        modifier = Modifier.fillMaxWidth(),
                    ) { viewModel.backToComposer() }
                }

                else -> Composer(state, viewModel)
            }
        }
    }
}

@Composable
private fun Composer(state: PublishViewModel.State, viewModel: PublishViewModel) {
    // US-1373: renders nothing when the seller has no templates, so the composer
    // stays exactly as it was for everyone who doesn't use them.
    if (state.templates.isNotEmpty()) {
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(Spacing.xxs),
        ) {
            state.templates.forEach { template ->
                AssistChip(
                    onClick = { viewModel.applyTemplate(template) },
                    enabled = !state.busy,
                    label = { Text(template.name) },
                )
            }
        }
        state.templateMessage?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
    OutlinedTextField(
        value = state.title,
        onValueChange = viewModel::editTitle,
        label = { Text("Listing title") },
        enabled = !state.busy,
        modifier = Modifier.fillMaxWidth(),
    )
    LabeledDropdown(
        label = "Condition",
        selected = state.condition,
        options = EbayCondition.entries,
        optionLabel = { it.label },
        onSelect = viewModel::editCondition,
        enabled = !state.busy,
        modifier = Modifier.fillMaxWidth(),
    )
    OutlinedTextField(
        value = state.conditionDescription,
        onValueChange = viewModel::editConditionDescription,
        label = { Text("Condition notes (optional)") },
        enabled = !state.busy,
        modifier = Modifier.fillMaxWidth(),
    )
    OutlinedTextField(
        value = state.priceText,
        onValueChange = viewModel::editPrice,
        label = { Text("Price") },
        prefix = { Text("$") },
        singleLine = true,
        enabled = !state.busy,
        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
            keyboardType = KeyboardType.Decimal,
        ),
        modifier = Modifier.fillMaxWidth(),
    )

    ProfitEstimate(state)

    // US-1353: the category's specifics, edited here so they are on the draft
    // before pre-flight runs.
    SpecificsSection(state, viewModel::setSpecific)
    if (state.specificBlockers.isNotEmpty()) {
        InfoCard(
            "Still needed for this category",
            state.specificBlockers.joinToString("\n") { "• $it" },
            tone = InfoTone.Error,
        )
    }

    val phase = state.phase
    if (phase is PublishPhase.Review) {
        if (phase.blockers.isNotEmpty()) {
            InfoCard(
                "Fix these before publishing",
                phase.blockers.joinToString("\n") { "• $it" },
                tone = InfoTone.Error,
            )
        }
        if (phase.warnings.isNotEmpty()) {
            // Warnings never block. Naming them as suggestions keeps a seller
            // from reading an advisory as a stop sign.
            InfoCard(
                "Worth a look",
                phase.warnings.joinToString("\n") { "• $it" },
                tone = InfoTone.Warning,
            )
        }
        phase.summary?.let { SummaryPanel(it) }
    }

    BrandSecondaryButton(
        text = if (phase is PublishPhase.Validating) "Checking…" else "Save and check",
        enabled = !state.busy,
        modifier = Modifier.fillMaxWidth(),
    ) { viewModel.validate() }

    BrandPrimaryButton(
        text = when {
            phase is PublishPhase.Pushing -> "Publishing…"
            state.relist -> "Relist on eBay"
            else -> "Publish to eBay"
        },
        enabled = state.canPublish,
        modifier = Modifier.fillMaxWidth(),
    ) { viewModel.publishNow() }

    if (!state.canPublish && !state.busy && phase !is PublishPhase.Composing) {
        Text(
            "Publishing stays off until the blockers above are cleared.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** The live estimate. Named as an estimate everywhere — it is not a quote. */
@Composable
private fun ProfitEstimate(state: PublishViewModel.State) {
    val price = ListingDraftService.validatedPrice(state.priceText) ?: 0.0
    val profit = state.profit
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Est. net profit",
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            Text(
                "${Money.format(profit.netCents)} · " +
                    "${profit.marginPctCents(price).roundToInt()}% margin",
                style = MaterialTheme.typography.titleMedium,
            )
        }
        Text(
            "eBay fees ~${Money.format(profit.feesCents)} · " +
                "your costs ${Money.format(profit.costs)}",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (state.costBasis == null) {
            // Say WHY the number looks generous rather than letting a seller
            // read a no-cost-basis estimate as real profit.
            Text(
                "No cost basis on this item, so this is revenue after fees — not profit.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** What the server would actually send to eBay. */
@Composable
private fun SummaryPanel(summary: PublishSummary) {
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Text("Ready to publish", style = MaterialTheme.typography.bodyLarge)
        Text(summary.title, style = MaterialTheme.typography.bodyMedium)
        val condition = EbayCondition.displayLabel(summary.condition)
        Text(
            listOfNotNull(
                summary.priceValue.takeIf { it.isNotBlank() }
                    ?.let { "${summary.currency ?: "USD"} $it" },
                condition,
                summary.quantity?.let { "Qty $it" },
            ).joinToString(" · "),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun PublishedPanel(
    result: PushResponse,
    onOpenListing: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    InfoCard(
        "It's live on eBay",
        if (result.syncPending) {
            // US-783: live, but the local mirror hasn't caught up. Saying
            // "syncing" beats a listing that looks like it failed.
            "The listing is up. Its details will finish syncing here shortly."
        } else {
            "The listing is up and synced."
        },
        tone = InfoTone.Success,
    )
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Text("Listing ${result.listingId}", style = MaterialTheme.typography.bodySmall)
        if (result.offerId.isNotBlank()) {
            Text("Offer ${result.offerId}", style = MaterialTheme.typography.bodySmall)
        }
        if (result.sku.isNotBlank()) {
            Text("SKU ${result.sku}", style = MaterialTheme.typography.bodySmall)
        }
    }
    if (result.listingUrl.isNotBlank()) {
        BrandPrimaryButton(text = "View on eBay", modifier = Modifier.fillMaxWidth()) {
            onOpenListing(result.listingUrl)
        }
    }
    BrandSecondaryButton(
        text = "Done",
        modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
    ) { onDismiss() }
}
