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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.ui.components.InfoCard
import com.gradethread.app.ui.components.InfoTone
import com.gradethread.app.ui.components.LabeledDropdown
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-1362: rules that fire on a condition — and can end listings — so every
 * screen here leads with what would happen, not just what was configured.
 */
@Composable
fun AutomationsScreen(
    onClose: () -> Unit = {},
    viewModel: AutomationsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    var editing by remember { mutableStateOf<AutomationDraft?>(null) }
    var deleting by remember { mutableStateOf<AutomationRule?>(null) }

    LaunchedEffect(Unit) { viewModel.load() }

    Column(
        Modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text("Automations", style = MaterialTheme.typography.titleLarge)
        Text(
            "Rules the server applies on its own — no need to keep the app open.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        state.errorMessage?.let { InfoCard("That didn't work", it, tone = InfoTone.Error) }
        state.warning?.let { InfoCard("Worth knowing", it, tone = InfoTone.Warning) }
        state.banner?.let { InfoCard("Done", it, tone = InfoTone.Success) }

        when {
            state.loading -> Hint("Loading…")
            state.rules.isEmpty() -> Hint(
                "No rules yet. A rule watches for something — a listing sitting 30 days, " +
                    "say — and then acts on it.",
            )

            else -> LazyColumn(
                Modifier.fillMaxWidth().weight(1f),
                verticalArrangement = Arrangement.spacedBy(Spacing.sm),
            ) {
                items(state.rules, key = { it.id }) { rule ->
                    RuleCard(
                        rule = rule,
                        busy = state.busy,
                        onToggle = { viewModel.setActive(rule, !rule.isActive) },
                        onEdit = { editing = AutomationDraft.from(rule) },
                        onDryRun = { viewModel.dryRun(rule) },
                        onDelete = { deleting = rule },
                    )
                }
            }
        }

        BrandSecondaryButton(
            text = "New rule",
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth(),
        ) { editing = AutomationDraft() }

        BrandSecondaryButton(
            text = "Run all rules now",
            enabled = !state.busy && state.rules.any { it.isActive },
            modifier = Modifier.fillMaxWidth(),
        ) { viewModel.runNow() }

        BrandSecondaryButton(text = "Back", modifier = Modifier.fillMaxWidth()) { onClose() }
    }

    state.dryRun?.let { result ->
        AlertDialog(
            onDismissRequest = viewModel::closeDryRun,
            title = { Text("What this rule would do") },
            text = {
                Column(
                    Modifier.verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
                ) {
                    Text(Automations.dryRunSummary(result))
                    result.matches.take(20).forEach { match ->
                        Text(
                            "${match.displayTitle} — ${Automations.matchSummary(match)}",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    if (result.matches.size > 20) {
                        // Never a silent truncation: the count says what's hidden.
                        Text(
                            "…and ${result.matches.size - 20} more.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            },
            confirmButton = { TextButton(onClick = viewModel::closeDryRun) { Text("Close") } },
        )
    }

    editing?.let { draft ->
        RuleEditorDialog(
            initial = draft,
            busy = state.busy,
            onDismiss = { editing = null },
            onSave = {
                viewModel.save(it)
                editing = null
            },
        )
    }

    deleting?.let { rule ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete \"${rule.name}\"?") },
            text = { Text("Changes it already made stay as they are.") },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.delete(rule)
                    deleting = null
                }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
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
            "Waits ${rule.trigger.cooldownDays} days before touching the same listing again.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Automations.scopeWarning(rule)?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }
        Row {
            TextButton(onClick = onDryRun, enabled = !busy) { Text("Preview") }
            TextButton(onClick = onEdit, enabled = !busy) { Text("Edit") }
            TextButton(onClick = onDelete, enabled = !busy) {
                Text("Delete", color = MaterialTheme.colorScheme.error)
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
        title = { Text(if (initial.id == null) "New rule" else "Edit rule") },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(Spacing.xs),
            ) {
                OutlinedTextField(
                    value = draft.name,
                    onValueChange = { draft = draft.copy(name = it) },
                    label = { Text("Name") },
                    singleLine = true,
                )

                Text("When", style = MaterialTheme.typography.titleSmall)
                LabeledDropdown(
                    label = "Trigger",
                    selected = draft.triggerType,
                    options = Automations.triggerTypes.map { it.first },
                    optionLabel = { Automations.label(Automations.triggerTypes, it) },
                    onSelect = { draft = draft.copy(triggerType = it) },
                    modifier = Modifier.fillMaxWidth(),
                )
                NumberField("Days", draft.triggerDays.toString()) {
                    draft = draft.copy(triggerDays = it.toIntOrNull() ?: draft.triggerDays)
                }
                if (draft.triggerType == "watchers_lt_after_days") {
                    NumberField("Fewer than this many watchers", draft.triggerWatchers.toString()) {
                        draft = draft.copy(
                            triggerWatchers = it.toIntOrNull() ?: draft.triggerWatchers,
                        )
                    }
                }
                NumberField("Wait this many days before repeating", draft.cooldownDays.toString()) {
                    draft = draft.copy(cooldownDays = it.toIntOrNull() ?: draft.cooldownDays)
                }

                Text("Then", style = MaterialTheme.typography.titleSmall)
                LabeledDropdown(
                    label = "Action",
                    selected = draft.actionType,
                    options = Automations.actionTypes.map { it.first },
                    optionLabel = { Automations.label(Automations.actionTypes, it) },
                    onSelect = { draft = draft.copy(actionType = it) },
                    modifier = Modifier.fillMaxWidth(),
                )
                if (draft.actionType != "end_listing") {
                    NumberField("Percent", Automations.formatPct(draft.actionPct)) {
                        draft = draft.copy(actionPct = it.toDoubleOrNull() ?: draft.actionPct)
                    }
                }
                if (draft.actionType == "price_drop_pct") {
                    NumberField("Never cut below this margin %", draft.marginFloorPct.toString()) {
                        draft = draft.copy(
                            marginFloorPct = it.toIntOrNull() ?: draft.marginFloorPct,
                        )
                    }
                }

                Text("To which listings", style = MaterialTheme.typography.titleSmall)
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
                    listOf("all" to "All active", "filter" to "Filtered").forEach { (key, label) ->
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
                    }) { Text("Add a filter") }
                    if (Automations.scopeSilentlyWidened(draft)) {
                        // Empty clauses would quietly turn a filtered rule into
                        // one that touches everything.
                        Text(
                            "Those filters have no values yet, so this would apply to every " +
                                "active listing.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                }

                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Active", modifier = Modifier.weight(1f))
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
            ) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun ScopeRuleRow(
    rule: ScopeRuleDraft,
    onChange: (ScopeRuleDraft) -> Unit,
    onRemove: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
        LabeledDropdown(
            label = "Field",
            selected = rule.field,
            options = Automations.scopeFields.map { it.first },
            optionLabel = { Automations.label(Automations.scopeFields, it) },
            onSelect = { onChange(rule.copy(field = it)) },
            modifier = Modifier.fillMaxWidth(),
        )
        LabeledDropdown(
            label = "Is",
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
                label = { Text("Value") },
                singleLine = true,
            )
        }
        TextButton(onClick = onRemove) { Text("Remove this filter") }
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
