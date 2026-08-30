package com.gradethread.app.pricing

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.ui.components.InfoCard
import com.gradethread.app.ui.components.InfoTone
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-1358: standing repricing rules, and the suggestions a scan turns up.
 */
@Composable
fun RepricingScreen(onClose: () -> Unit = {}, viewModel: RepricingViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()
    var editing by remember { mutableStateOf<RuleDraft?>(null) }
    var deleting by remember { mutableStateOf<RepricingRule?>(null) }

    LaunchedEffect(Unit) { viewModel.load() }

    RepricingContent(
        state = state,
        actions = RepricingActions(
            apply = viewModel::apply,
            dismissSuggestion = viewModel::dismiss,
            toggleRule = viewModel::toggleRule,
            // The two dialogs are LOCAL ui state, so the wrapper owns them and
            // the body only asks for them to open or close. That is what lets a
            // screenshot test capture the editor and the delete confirmation -
            // a `remember` inside the body would put both out of reach.
            setEditing = { editing = it },
            setDeleting = { deleting = it },
            saveRule = {
                viewModel.saveRule(it)
                editing = null
            },
            confirmDelete = {
                viewModel.deleteRule(it)
                deleting = null
            },
            scan = viewModel::scan,
            close = onClose,
        ),
        editing = editing,
        deleting = deleting,
    )
}

/** Everything this screen can be asked to do (US-2902 AC3). */
@Immutable
data class RepricingActions(
    val apply: (RepricingSuggestion) -> Unit = {},
    val dismissSuggestion: (RepricingSuggestion) -> Unit = {},
    val toggleRule: (RepricingRule) -> Unit = {},
    /** Open the rule editor on this draft, or close it with null. */
    val setEditing: (RuleDraft?) -> Unit = {},
    /** Open the delete confirmation for this rule, or close it with null. */
    val setDeleting: (RepricingRule?) -> Unit = {},
    val saveRule: (RuleDraft) -> Unit = {},
    val confirmDelete: (RepricingRule) -> Unit = {},
    val scan: () -> Unit = {},
    val close: () -> Unit = {},
)

/**
 * Repricing with no ViewModel attached (US-2902 AC3).
 *
 * ⚠ THIS SCREEN CHANGES LIVE PRICES ON A SCHEDULE, and the seller is not
 * watching when it does. A suggestion card shows the old price, the new one and
 * why; a rule card shows the drop, the interval and the floor. Those numbers
 * are the whole safety story - a floor that stops rendering is a rule that
 * looks like it will keep cutting forever, and the delete dialog's promise that
 * prices already changed STAY changed is the difference between deleting a rule
 * and expecting a refund.
 */
@Composable
fun RepricingContent(
    state: RepricingViewModel.State,
    actions: RepricingActions,
    modifier: Modifier = Modifier,
    editing: RuleDraft? = null,
    deleting: RepricingRule? = null,
) {
    Column(
        modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(stringResource(R.string.repricing_repricing), style = MaterialTheme.typography.titleLarge)

        state.errorMessage?.let {
            InfoCard(stringResource(R.string.repricing_that_didn_t_work), it, tone = InfoTone.Error)
        }
        state.banner?.let { InfoCard(stringResource(R.string.repricing_scan), it, tone = InfoTone.Success) }
        state.caveat?.let { InfoCard(stringResource(R.string.repricing_worth_knowing), it, tone = InfoTone.Warning) }

        LazyColumn(
            Modifier.fillMaxWidth().weight(1f),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            item {
                Text(
                    stringResource(R.string.repricing_suggestions_count, state.suggestions.size),
                    style = MaterialTheme.typography.titleMedium,
                )
            }
            if (state.suggestions.isEmpty()) {
                item {
                    Hint(
                        stringResource(
                            if (state.loading) {
                                R.string.repricing_loading
                            } else {
                                R.string.repricing_no_suggestions
                            },
                        ),
                    )
                }
            }
            items(state.suggestions, key = { it.id }) { suggestion ->
                SuggestionCard(
                    suggestion = suggestion,
                    busy = state.busy,
                    onApply = { actions.apply(suggestion) },
                    onDismiss = { actions.dismissSuggestion(suggestion) },
                )
            }

            item {
                Text(
                    stringResource(R.string.repricing_rules_count, state.rules.size),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(top = Spacing.sm),
                )
            }
            if (state.rules.isEmpty() && !state.loading) {
                item { Hint(stringResource(R.string.repricing_no_rules)) }
            }
            items(state.rules, key = { it.id }) { rule ->
                RuleCard(
                    rule = rule,
                    busy = state.busy,
                    onToggle = { actions.toggleRule(rule) },
                    onEdit = { actions.setEditing(RuleDraft.from(rule)) },
                    onDelete = { actions.setDeleting(rule) },
                )
            }
        }

        BrandPrimaryButton(
            text = stringResource(
                if (state.scanning) R.string.repricing_scanning else R.string.repricing_scan_button,
            ),
            enabled = !state.scanning,
            modifier = Modifier.fillMaxWidth(),
        ) { actions.scan() }

        BrandSecondaryButton(
            text = stringResource(R.string.repricing_new_rule),
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth(),
        ) { actions.setEditing(RuleDraft()) }

        BrandSecondaryButton(text = stringResource(R.string.repricing_back), modifier = Modifier.fillMaxWidth()) {
            actions.close()
        }
    }

    editing?.let { draft ->
        RuleEditorDialog(
            initial = draft,
            busy = state.busy,
            onDismiss = { actions.setEditing(null) },
            onSave = actions.saveRule,
        )
    }

    deleting?.let { rule ->
        AlertDialog(
            onDismissRequest = { actions.setDeleting(null) },
            title = { Text(stringResource(R.string.repricing_delete_rule, rule.name)) },
            text = { Text(stringResource(R.string.repricing_prices_already_changed_stay_as)) },
            confirmButton = {
                TextButton(onClick = { actions.confirmDelete(rule) }) {
                    Text(stringResource(R.string.repricing_delete))
                }
            },
            dismissButton = {
                TextButton(onClick = { actions.setDeleting(null) }) {
                    Text(stringResource(R.string.repricing_cancel))
                }
            },
        )
    }
}

@Composable
private fun SuggestionCard(
    suggestion: RepricingSuggestion,
    busy: Boolean,
    onApply: () -> Unit,
    onDismiss: () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Text(
            suggestion.title,
            style = MaterialTheme.typography.bodyLarge,
            fontWeight = FontWeight.SemiBold,
        )
        Text(Repricing.changeSummary(suggestion), style = MaterialTheme.typography.titleMedium)
        Text(
            Repricing.reasonLabel(suggestion.reasonCode),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        // The evidence, not just the verdict: "based on 2 listings" is something
        // a seller can weigh for themselves.
        Repricing.evidenceSummary(suggestion)?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        suggestion.message?.takeIf { it.isNotBlank() }?.let {
            Text(it, style = MaterialTheme.typography.bodySmall)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            BrandPrimaryButton(
                text = stringResource(R.string.repricing_apply),
                enabled = !busy,
                modifier = Modifier.weight(1f),
            ) { onApply() }
            BrandSecondaryButton(
                text = stringResource(R.string.repricing_dismiss),
                enabled = !busy,
                modifier = Modifier.weight(1f),
            ) { onDismiss() }
        }
    }
}

@Composable
private fun RuleCard(
    rule: RepricingRule,
    busy: Boolean,
    onToggle: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                rule.name,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            Switch(checked = rule.enabled, onCheckedChange = { onToggle() }, enabled = !busy)
        }
        Text(Repricing.actionSummary(rule), style = MaterialTheme.typography.bodyMedium)
        Text(
            Repricing.scopeSummary(rule),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Repricing.floorWarning(rule)?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }
        Row {
            TextButton(onClick = onEdit, enabled = !busy) { Text(stringResource(R.string.repricing_edit)) }
            TextButton(onClick = onDelete, enabled = !busy) {
                Text(stringResource(R.string.repricing_delete), color = MaterialTheme.colorScheme.error)
            }
        }
    }
}

@Composable
private fun RuleEditorDialog(initial: RuleDraft, busy: Boolean, onDismiss: () -> Unit, onSave: (RuleDraft) -> Unit) {
    var draft by remember(initial.id) { mutableStateOf(initial) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                stringResource(
                    if (initial.id == null) {
                        R.string.automations_new_rule
                    } else {
                        R.string.automations_edit_rule
                    },
                ),
            )
        },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(Spacing.xs),
            ) {
                OutlinedTextField(
                    value = draft.name,
                    onValueChange = { draft = draft.copy(name = it) },
                    label = { Text(stringResource(R.string.repricing_name)) },
                    singleLine = true,
                )
                NumberField(stringResource(R.string.repricing_field_drop_pct), draft.dropPct.toString()) {
                    draft = draft.copy(dropPct = it.toDoubleOrNull() ?: draft.dropPct)
                }
                NumberField(
                    stringResource(R.string.repricing_field_interval),
                    draft.intervalDays.toString(),
                ) {
                    draft = draft.copy(intervalDays = it.toIntOrNull() ?: draft.intervalDays)
                }
                OutlinedTextField(
                    value = draft.floorPriceText,
                    onValueChange = { draft = draft.copy(floorPriceText = it) },
                    label = { Text(stringResource(R.string.repricing_never_below)) },
                    prefix = { Text(stringResource(R.string.drafts_currency_prefix)) },
                    singleLine = true,
                )
                Text(
                    stringResource(R.string.repricing_floor_warning),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    value = draft.filterBrand,
                    onValueChange = { draft = draft.copy(filterBrand = it) },
                    label = { Text(stringResource(R.string.repricing_only_this_brand_optional)) },
                    singleLine = true,
                )
                NumberField(
                    stringResource(R.string.repricing_field_min_age),
                    draft.minAgeDays.toString(),
                ) {
                    draft = draft.copy(minAgeDays = it.toIntOrNull() ?: draft.minAgeDays)
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.repricing_auto_accept_offers), modifier = Modifier.weight(1f))
                    Switch(
                        checked = draft.autoAcceptEnabled,
                        onCheckedChange = { draft = draft.copy(autoAcceptEnabled = it) },
                    )
                }
                Repricing.validationError(draft)?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = Repricing.isValid(draft) && !busy,
                onClick = { onSave(draft) },
            ) { Text(stringResource(R.string.repricing_save)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.repricing_cancel)) } },
    )
}

@Composable
private fun NumberField(label: String, value: String, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        singleLine = true,
        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
            keyboardType = KeyboardType.Decimal,
        ),
    )
}

@Composable
private fun Hint(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}
