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
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.inventory.EbayAspect
import com.gradethread.app.money.Money
import com.gradethread.app.templates.ListingTemplate
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
        PublishSheetContent(
            state = state,
            actions = PublishActions(
                onBackToComposer = viewModel::backToComposer,
                onApplyTemplate = viewModel::applyTemplate,
                onEditTitle = viewModel::editTitle,
                onEditCondition = viewModel::editCondition,
                onEditConditionDescription = viewModel::editConditionDescription,
                onEditPrice = viewModel::editPrice,
                onSetSpecific = viewModel::setSpecific,
                onValidate = viewModel::validate,
                onPublishNow = viewModel::publishNow,
            ),
            onOpenListing = onOpenListing,
            onDismiss = onDismiss,
        )
    }
}

/**
 * US-2902 AC3: every action this sheet can take, in one place.
 *
 * WHY AN OBJECT AND NOT NINE LAMBDA PARAMETERS. GradeReportContent takes its
 * four callbacks loose, which is the right call at four. Nine is where the
 * signature stops being readable and a caller starts passing them positionally
 * by accident, and two of these take a String while three more take one value
 * each, so a swap would compile.
 *
 * @Immutable is load-bearing rather than decorative: a data class of function
 * types is UNSTABLE to the Compose compiler by default, so without it every
 * recomposition of the sheet would recompose the whole composer beneath it.
 * The defaults exist for screenshot tests, which want the layout and none of
 * the behaviour.
 */
@Immutable
data class PublishActions(
    val onBackToComposer: () -> Unit = {},
    val onApplyTemplate: (ListingTemplate) -> Unit = {},
    val onEditTitle: (String) -> Unit = {},
    val onEditCondition: (EbayCondition) -> Unit = {},
    val onEditConditionDescription: (String) -> Unit = {},
    val onEditPrice: (String) -> Unit = {},
    val onSetSpecific: (EbayAspect, List<String>) -> Unit = { _, _ -> },
    val onValidate: () -> Unit = {},
    val onPublishNow: () -> Unit = {},
)

/**
 * The sheet with no ViewModel in it, and deliberately WITHOUT the
 * ModalBottomSheet wrapper.
 *
 * The wrapper renders into its own dialog window, which a Robolectric capture
 * cannot reach. Everything a seller reads and taps is in here, so the golden
 * gets the whole surface and the wrapper stays where it belongs.
 */
@Composable
internal fun PublishSheetContent(
    state: PublishViewModel.State,
    actions: PublishActions,
    onOpenListing: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = Spacing.md)
            .padding(bottom = Spacing.lg),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Text(
            stringResource(
                if (state.relist) R.string.publish_relist_title else R.string.publish_list_title,
            ),
            style = MaterialTheme.typography.titleLarge,
        )
        if (state.relist) {
            Text(
                stringResource(R.string.publish_relist_note),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        state.errorMessage?.let {
            InfoCard(stringResource(R.string.publish_check_this_first), it, tone = InfoTone.Warning)
        }

        when (val phase = state.phase) {
            is PublishPhase.Published -> PublishedPanel(phase.result, onOpenListing, onDismiss)
            is PublishPhase.PlanLimit -> InfoCard(
                stringResource(R.string.publish_ve_hit_plan_limit),
                phase.message,
                tone = InfoTone.Warning,
            )

            is PublishPhase.Failed -> {
                InfoCard(stringResource(R.string.publish_publish_failed), phase.message, tone = InfoTone.Error)
                BrandSecondaryButton(
                    text = stringResource(R.string.publish_back_composer),
                    modifier = Modifier.fillMaxWidth(),
                ) { actions.onBackToComposer() }
            }

            else -> Composer(state, actions)
        }
    }
}

@Composable
private fun Composer(state: PublishViewModel.State, actions: PublishActions) {
    val bullet = stringResource(R.string.publish_bullet_prefix)
    // US-1373: renders nothing when the seller has no templates, so the composer
    // stays exactly as it was for everyone who doesn't use them.
    if (state.templates.isNotEmpty()) {
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(Spacing.xxs),
        ) {
            state.templates.forEach { template ->
                AssistChip(
                    onClick = { actions.onApplyTemplate(template) },
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
        onValueChange = actions.onEditTitle,
        label = { Text(stringResource(R.string.publish_listing_title)) },
        enabled = !state.busy,
        modifier = Modifier.fillMaxWidth(),
    )
    LabeledDropdown(
        label = stringResource(R.string.publish_condition),
        selected = state.condition,
        options = EbayCondition.entries,
        optionLabel = { it.label },
        onSelect = actions.onEditCondition,
        enabled = !state.busy,
        modifier = Modifier.fillMaxWidth(),
    )
    OutlinedTextField(
        value = state.conditionDescription,
        onValueChange = actions.onEditConditionDescription,
        label = { Text(stringResource(R.string.publish_condition_notes_optional)) },
        enabled = !state.busy,
        modifier = Modifier.fillMaxWidth(),
    )
    OutlinedTextField(
        value = state.priceText,
        onValueChange = actions.onEditPrice,
        label = { Text(stringResource(R.string.publish_price)) },
        prefix = { Text(stringResource(R.string.drafts_currency_prefix)) },
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
    SpecificsSection(state, actions.onSetSpecific)
    if (state.specificBlockers.isNotEmpty()) {
        InfoCard(
            stringResource(R.string.publish_still_needed_this_category),
            state.specificBlockers.joinToString("\n") { bullet + it },
            tone = InfoTone.Error,
        )
    }

    val phase = state.phase
    if (phase is PublishPhase.Review) {
        if (phase.blockers.isNotEmpty()) {
            InfoCard(
                stringResource(R.string.publish_fix_these_before_publishing),
                phase.blockers.joinToString("\n") { bullet + it },
                tone = InfoTone.Error,
            )
        }
        if (phase.warnings.isNotEmpty()) {
            // Warnings never block. Naming them as suggestions keeps a seller
            // from reading an advisory as a stop sign.
            InfoCard(
                stringResource(R.string.publish_worth_look),
                phase.warnings.joinToString("\n") { bullet + it },
                tone = InfoTone.Warning,
            )
        }
        phase.summary?.let { SummaryPanel(it) }
    }

    BrandSecondaryButton(
        text = stringResource(
            if (phase is PublishPhase.Validating) {
                R.string.publish_checking
            } else {
                R.string.publish_save_and_check
            },
        ),
        enabled = !state.busy,
        modifier = Modifier.fillMaxWidth(),
    ) { actions.onValidate() }

    BrandPrimaryButton(
        text = when {
            phase is PublishPhase.Pushing -> stringResource(R.string.publish_publishing)
            state.relist -> stringResource(R.string.publish_relist_title)
            else -> stringResource(R.string.publish_to_ebay)
        },
        enabled = state.canPublish,
        modifier = Modifier.fillMaxWidth(),
    ) { actions.onPublishNow() }

    if (!state.canPublish && !state.busy && phase !is PublishPhase.Composing) {
        Text(
            stringResource(R.string.publish_publishing_stays_off_until_blockers),
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
                stringResource(R.string.publish_est_net_profit),
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            Text(
                stringResource(
                    R.string.publish_net_and_margin,
                    Money.format(profit.netCents),
                    profit.marginPctCents(price).roundToInt(),
                ),
                style = MaterialTheme.typography.titleMedium,
            )
        }
        Text(
            stringResource(
                R.string.publish_fees_and_costs,
                Money.format(profit.feesCents),
                Money.format(profit.costs),
            ),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (state.costBasis == null) {
            // Say WHY the number looks generous rather than letting a seller
            // read a no-cost-basis estimate as real profit.
            Text(
                stringResource(R.string.publish_no_cost_basis_this_item),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** What the server would actually send to eBay. */
@Composable
private fun SummaryPanel(summary: PublishSummary) {
    // Read once, formatted inside the listOfNotNull lambdas below — those are
    // not composable scopes.
    val priceFormat = stringResource(R.string.publish_price_with_currency)
    val qtyFormat = stringResource(R.string.publish_quantity)
    val defaultCurrency = stringResource(R.string.publish_default_currency)
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Text(stringResource(R.string.publish_ready_publish), style = MaterialTheme.typography.bodyLarge)
        Text(summary.title, style = MaterialTheme.typography.bodyMedium)
        val condition = EbayCondition.displayLabel(summary.condition)
        Text(
            listOfNotNull(
                summary.priceValue.takeIf { it.isNotBlank() }
                    ?.let { priceFormat.format(summary.currency ?: defaultCurrency, it) },
                condition,
                summary.quantity?.let { qtyFormat.format(it) },
            ).joinToString(" · "),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun PublishedPanel(result: PushResponse, onOpenListing: (String) -> Unit, onDismiss: () -> Unit) {
    InfoCard(
        stringResource(R.string.publish_s_live_ebay),
        if (result.syncPending) {
            // US-783: live, but the local mirror hasn't caught up. Saying
            // "syncing" beats a listing that looks like it failed.
            stringResource(R.string.publish_done_syncing)
        } else {
            stringResource(R.string.publish_done_synced)
        },
        tone = InfoTone.Success,
    )
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Text(
            stringResource(R.string.publish_listing_id, result.listingId),
            style = MaterialTheme.typography.bodySmall,
        )
        if (result.offerId.isNotBlank()) {
            Text(
                stringResource(R.string.publish_offer_id, result.offerId),
                style = MaterialTheme.typography.bodySmall,
            )
        }
        if (result.sku.isNotBlank()) {
            Text(
                stringResource(R.string.publish_sku, result.sku),
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
    if (result.listingUrl.isNotBlank()) {
        BrandPrimaryButton(text = stringResource(R.string.publish_view_ebay), modifier = Modifier.fillMaxWidth()) {
            onOpenListing(result.listingUrl)
        }
    }
    BrandSecondaryButton(
        text = stringResource(R.string.publish_done),
        modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
    ) { onDismiss() }
}
