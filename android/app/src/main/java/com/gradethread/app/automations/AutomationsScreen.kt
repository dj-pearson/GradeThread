package com.gradethread.app.automations

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
import androidx.compose.material3.FilterChip
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
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.ui.components.InfoCard
import com.gradethread.app.ui.components.InfoTone
import com.gradethread.app.ui.components.LabeledDropdown
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-1362: rules that fire on a condition — and can end listings — so every
 * screen here leads with what would happen, not just what was configured.
 */
@Composable
fun AutomationsScreen(onClose: () -> Unit = {}, viewModel: AutomationsViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()
    var editing by remember { mutableStateOf<AutomationDraft?>(null) }
    var deleting by remember { mutableStateOf<AutomationRule?>(null) }

    LaunchedEffect(Unit) { viewModel.load() }

    AutomationsContent(
        state,
        AutomationsActions(
            setActive = viewModel::setActive,
            dryRun = viewModel::dryRun,
            closeDryRun = viewModel::closeDryRun,
            setEditing = { editing = it },
            setDeleting = { deleting = it },
            save = {
                viewModel.save(it)
                editing = null
            },
            confirmDelete = {
                viewModel.delete(it)
                deleting = null
            },
            runNow = viewModel::runNow,
            close = onClose,
        ),
        editing = editing,
        deleting = deleting,
    )
}

/** Everything this screen can be asked to do (US-2902 AC3). */
@Immutable
data class AutomationsActions(
    val setActive: (AutomationRule, Boolean) -> Unit = { _, _ -> },
    val dryRun: (AutomationRule) -> Unit = {},
    val closeDryRun: () -> Unit = {},
    /** Open the rule editor on this draft, or close it with null. */
    val setEditing: (AutomationDraft?) -> Unit = {},
    /** Open the delete confirmation for this rule, or close it with null. */
    val setDeleting: (AutomationRule?) -> Unit = {},
    val save: (AutomationDraft) -> Unit = {},
    val confirmDelete: (AutomationRule) -> Unit = {},
    val runNow: () -> Unit = {},
    val close: () -> Unit = {},
)

/**
 * Automations with no ViewModel attached (US-2902 AC3).
 *
 * ⚠ THE DRY RUN IS THE SAFETY FEATURE, and it is a dialog, so only a capture
 * can check it. These rules run on the SERVER on their own schedule - the
 * screen's own subtitle says so - which means a seller cannot watch them work
 * and cannot undo what they did. "What this rule would do" is the one chance to
 * see the blast radius before switching it on.
 *
 * ⚠ AND IT NEVER TRUNCATES SILENTLY. Twenty matches are listed and the rest are
 * counted in a line that says how many were hidden. A dry run that showed
 * twenty of two hundred without saying so would be worse than no dry run: it
 * would read as a small, safe rule.
 *
 * ⚠ THE DELETE DIALOG PROMISES THE SAME THING REPRICING'S DOES: changes already
 * made stay made. A seller who reads "delete rule" as "undo it" deletes it and
 * waits for prices to come back.
 */
@Composable
fun AutomationsContent(
    state: AutomationsViewModel.State,
    actions: AutomationsActions,
    modifier: Modifier = Modifier,
    editing: AutomationDraft? = null,
    deleting: AutomationRule? = null,
) {
    Column(
        modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(stringResource(R.string.automations_automations), style = MaterialTheme.typography.titleLarge)
        Text(
            stringResource(R.string.automations_rules_server_applies_its_own),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        state.errorMessage?.let {
            InfoCard(stringResource(R.string.automations_that_didn_t_work), it, tone = InfoTone.Error)
        }
        state.warning?.let { InfoCard(stringResource(R.string.automations_worth_knowing), it, tone = InfoTone.Warning) }
        state.banner?.let { InfoCard(stringResource(R.string.common_done), it, tone = InfoTone.Success) }

        when {
            state.loading -> Hint(stringResource(R.string.automations_loading))
            state.rules.isEmpty() -> Hint(stringResource(R.string.automations_no_rules_yet))

            else -> LazyColumn(
                Modifier.fillMaxWidth().weight(1f),
                verticalArrangement = Arrangement.spacedBy(Spacing.sm),
            ) {
                items(state.rules, key = { it.id }) { rule ->
                    RuleCard(
                        rule = rule,
                        busy = state.busy,
                        onToggle = { actions.setActive(rule, !rule.isActive) },
                        onEdit = { actions.setEditing(AutomationDraft.from(rule)) },
                        onDryRun = { actions.dryRun(rule) },
                        onDelete = { actions.setDeleting(rule) },
                    )
                }
            }
        }

        BrandSecondaryButton(
            text = stringResource(R.string.automations_new_rule),
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth(),
        ) { actions.setEditing(AutomationDraft()) }

        BrandSecondaryButton(
            text = stringResource(R.string.automations_run_all_rules_now),
            enabled = !state.busy && state.rules.any { it.isActive },
            modifier = Modifier.fillMaxWidth(),
        ) { actions.runNow() }

        BrandSecondaryButton(
            text = stringResource(R.string.common_back),
            modifier = Modifier.fillMaxWidth(),
        ) { actions.close() }
    }

    state.dryRun?.let { result ->
        AlertDialog(
            onDismissRequest = actions.closeDryRun,
            title = { Text(stringResource(R.string.automations_what_this_rule_would_do)) },
            text = {
                Column(
                    Modifier.verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
                ) {
                    Text(Automations.dryRunSummary(result))
                    result.matches.take(20).forEach { match ->
                        Text(
                            stringResource(
                                R.string.automations_match_row,
                                match.displayTitle,
                                Automations.matchSummary(match),
                            ),
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    if (result.matches.size > 20) {
                        // Never a silent truncation: the count says what's hidden.
                        Text(
                            stringResource(
                                R.string.automations_and_more,
                                result.matches.size - 20,
                            ),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = actions.closeDryRun) {
                    Text(stringResource(R.string.automations_close))
                }
            },
        )
    }

    editing?.let { draft ->
        RuleEditorDialog(
            initial = draft,
            busy = state.busy,
            onDismiss = { actions.setEditing(null) },
            onSave = actions.save,
        )
    }

    deleting?.let { rule ->
        AlertDialog(
            onDismissRequest = { actions.setDeleting(null) },
            title = { Text(stringResource(R.string.automations_delete_rule, rule.name)) },
            text = { Text(stringResource(R.string.automations_changes_already_made_stay_as)) },
            confirmButton = {
                TextButton(onClick = { actions.confirmDelete(rule) }) {
                    Text(stringResource(R.string.automations_delete))
                }
            },
            dismissButton = {
                TextButton(onClick = { actions.setDeleting(null) }) {
                    Text(stringResource(R.string.automations_cancel))
                }
            },
        )
    }
}

@Composable
private fun RuleCard(
    rule: AutomationRule,
    busy: Boolean,
    onToggle: () -> Unit,
    onEdit: () -> Unit,
    onDryRun: () -> Unit,
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
            Switch(checked = rule.isActive, onCheckedChange = { onToggle() }, enabled = !busy)
        }
        Text(Automations.sentence(rule), style = MaterialTheme.typography.bodyMedium)
        Text(
            pluralStringResource(
                R.plurals.automations_cooldown,
                rule.trigger.cooldownDays,
                rule.trigger.cooldownDays,
            ),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Automations.scopeWarning(rule)?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }
        Row {
            TextButton(onClick = onDryRun, enabled = !busy) { Text(stringResource(R.string.automations_preview)) }
            TextButton(onClick = onEdit, enabled = !busy) { Text(stringResource(R.string.automations_edit)) }
            TextButton(onClick = onDelete, enabled = !busy) {
                Text(stringResource(R.string.automations_delete), color = MaterialTheme.colorScheme.error)
            }
        }
    }
}

@Composable
private fun RuleEditorDialog(
    initial: AutomationDraft,
    busy: Boolean,
    onDismiss: () -> Unit,
    onSave: (AutomationDraft) -> Unit,
) {
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
                    label = { Text(stringResource(R.string.automations_name)) },
                    singleLine = true,
                )

                Text(stringResource(R.string.automations_when), style = MaterialTheme.typography.titleSmall)
                LabeledDropdown(
                    label = stringResource(R.string.automations_trigger),
                    selected = draft.triggerType,
                    options = Automations.triggerTypes.map { it.first },
                    optionLabel = { Automations.label(Automations.triggerTypes, it) },
                    onSelect = { draft = draft.copy(triggerType = it) },
                    modifier = Modifier.fillMaxWidth(),
                )
                NumberField(stringResource(R.string.automations_field_days), draft.triggerDays.toString()) {
                    draft = draft.copy(triggerDays = it.toIntOrNull() ?: draft.triggerDays)
                }
                if (draft.triggerType == "watchers_lt_after_days") {
                    NumberField(
                        stringResource(R.string.automations_field_watchers),
                        draft.triggerWatchers.toString(),
                    ) {
                        draft = draft.copy(
                            triggerWatchers = it.toIntOrNull() ?: draft.triggerWatchers,
                        )
                    }
                }
                NumberField(
                    stringResource(R.string.automations_field_cooldown),
                    draft.cooldownDays.toString(),
                ) {
                    draft = draft.copy(cooldownDays = it.toIntOrNull() ?: draft.cooldownDays)
                }

                Text(stringResource(R.string.automations_then), style = MaterialTheme.typography.titleSmall)
                LabeledDropdown(
                    label = stringResource(R.string.automations_action),
                    selected = draft.actionType,
                    options = Automations.actionTypes.map { it.first },
                    optionLabel = { Automations.label(Automations.actionTypes, it) },
                    onSelect = { draft = draft.copy(actionType = it) },
                    modifier = Modifier.fillMaxWidth(),
                )
                if (draft.actionType != "end_listing") {
                    NumberField(
                        stringResource(R.string.automations_field_percent),
                        Automations.formatPct(draft.actionPct),
                    ) {
                        draft = draft.copy(actionPct = it.toDoubleOrNull() ?: draft.actionPct)
                    }
                }
                if (draft.actionType == "price_drop_pct") {
                    NumberField(
                        stringResource(R.string.automations_field_margin_floor),
                        draft.marginFloorPct.toString(),
                    ) {
                        draft = draft.copy(
                            marginFloorPct = it.toIntOrNull() ?: draft.marginFloorPct,
                        )
                    }
                }

                Text(stringResource(R.string.automations_which_listings), style = MaterialTheme.typography.titleSmall)
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
                    val scopeLabels = listOf(
                        "all" to stringResource(R.string.automations_scope_all),
                        "filter" to stringResource(R.string.automations_scope_filter),
                    )
                    scopeLabels.forEach { (key, label) ->
                        FilterChip(
                            selected = draft.scopeMode == key,
                            onClick = { draft = draft.copy(scopeMode = key) },
                            label = { Text(label) },
                        )
                    }
                }
                if (draft.scopeMode == "filter") {
                    draft.scopeRules.forEachIndexed { index, rule ->
                        ScopeRuleRow(
                            rule = rule,
                            onChange = { updated ->
                                draft = draft.copy(
                                    scopeRules = draft.scopeRules.toMutableList().also {
                                        it[index] = updated
                                    },
                                )
                            },
                            onRemove = {
                                draft = draft.copy(
                                    scopeRules = draft.scopeRules.filterIndexed { i, _ ->
                                        i != index
                                    },
                                )
                            },
                        )
                    }
                    TextButton(onClick = {
                        draft = draft.copy(scopeRules = draft.scopeRules + ScopeRuleDraft())
                    }) { Text(stringResource(R.string.automations_add_filter)) }
                    if (Automations.scopeSilentlyWidened(draft)) {
                        // Empty clauses would quietly turn a filtered rule into
                        // one that touches everything.
                        Text(
                            stringResource(R.string.automations_scope_widened),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                }

                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.automations_active), modifier = Modifier.weight(1f))
                    Switch(
                        checked = draft.isActive,
                        onCheckedChange = { draft = draft.copy(isActive = it) },
                    )
                }
                Automations.validationError(draft)?.let {
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
                enabled = Automations.isValid(draft) && !busy,
                onClick = { onSave(draft) },
            ) { Text(stringResource(R.string.automations_save)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.automations_cancel)) } },
    )
}

@Composable
private fun ScopeRuleRow(rule: ScopeRuleDraft, onChange: (ScopeRuleDraft) -> Unit, onRemove: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
        LabeledDropdown(
            label = stringResource(R.string.automations_field),
            selected = rule.field,
            options = Automations.scopeFields.map { it.first },
            optionLabel = { Automations.label(Automations.scopeFields, it) },
            onSelect = { onChange(rule.copy(field = it)) },
            modifier = Modifier.fillMaxWidth(),
        )
        LabeledDropdown(
            label = stringResource(R.string.automations_text),
            selected = rule.op,
            options = Automations.scopeOps.map { it.first },
            optionLabel = { Automations.label(Automations.scopeOps, it) },
            onSelect = { onChange(rule.copy(op = it)) },
            modifier = Modifier.fillMaxWidth(),
        )
        if (rule.op !in Automations.valuelessOps) {
            OutlinedTextField(
                value = rule.value,
                onValueChange = { onChange(rule.copy(value = it)) },
                label = { Text(stringResource(R.string.automations_value)) },
                singleLine = true,
            )
        }
        TextButton(onClick = onRemove) { Text(stringResource(R.string.automations_remove_this_filter)) }
    }
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
