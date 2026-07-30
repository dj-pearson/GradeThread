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
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-1358: standing repricing rules, and the suggestions a scan turns up.
 */
@Composable
fun RepricingScreen(
    onClose: () -> Unit = {},
    viewModel: RepricingViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    var editing by remember { mutableStateOf<RuleDraft?>(null) }
    var deleting by remember { mutableStateOf<RepricingRule?>(null) }

    LaunchedEffect(Unit) { viewModel.load() }

    Column(
        Modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text("Repricing", style = MaterialTheme.typography.titleLarge)

        state.errorMessage?.let { InfoCard("That didn't work", it, tone = InfoTone.Error) }
        state.banner?.let { InfoCard("Scan", it, tone = InfoTone.Success) }
        state.caveat?.let { InfoCard("Worth knowing", it, tone = InfoTone.Warning) }

        LazyColumn(
            Modifier.fillMaxWidth().weight(1f),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            item {
                Text("Suggestions (${state.suggestions.size})", style = MaterialTheme.typography.titleMedium)
            }
            if (state.suggestions.isEmpty()) {
                item {
                    Hint(
                        if (state.loading) {
                            "Loading…"
                        } else {
                            "No open suggestions. Run a scan to compare your live " +
                                "listings against current comps."
                        },
                    )
                }
            }
            items(state.suggestions, key = { it.id }) { suggestion ->
                SuggestionCard(
                    suggestion = suggestion,
                    busy = state.busy,
                    onApply = { viewModel.apply(suggestion) },
                    onDismiss = { viewModel.dismiss(suggestion) },
                )
            }

            item {
                Text(
                    "Rules (${state.rules.size})",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(top = Spacing.sm),
                )
            }
            if (state.rules.isEmpty() && !state.loading) {
                item { Hint("No rules yet. A rule drops prices on a schedule until its floor.") }
            }
            items(state.rules, key = { it.id }) { rule ->
                RuleCard(
                    rule = rule,
                    busy = state.busy,
                    onToggle = { viewModel.toggleRule(rule) },
                    onEdit = { editing = RuleDraft.from(rule) },
                    onDelete = { deleting = rule },
                )
            }
        }

        BrandPrimaryButton(
            text = if (state.scanning) "Scanning…" else "Scan for suggestions",
            enabled = !state.scanning,
            modifier = Modifier.fillMaxWidth(),
        ) { viewModel.scan() }

        BrandSecondaryButton(
            text = "New rule",
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth(),
        ) { editing = RuleDraft() }

        BrandSecondaryButton(text = "Back", modifier = Modifier.fillMaxWidth()) { onClose() }
    }

    editing?.let { draft ->
        RuleEditorDialog(
            initial = draft,
            busy = state.busy,
            onDismiss = { editing = null },
            onSave = {
                viewModel.saveRule(it)
                editing = null
            },
        )
    }

    deleting?.let { rule ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete \"${rule.name}\"?") },
            text = { Text("Prices it already changed stay as they are.") },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.deleteRule(rule)
                    deleting = null
                }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
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
                text = "Apply",
                enabled = !busy,
                modifier = Modifier.weight(1f),
            ) { onApply() }
            BrandSecondaryButton(
                text = "Dismiss",
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
            TextButton(onClick = onEdit, enabled = !busy) { Text("Edit") }
            TextButton(onClick = onDelete, enabled = !busy) {
                Text("Delete", color = MaterialTheme.colorScheme.error)
            }
        }
    }
}

@Composable
private fun RuleEditorDialog(
    initial: RuleDraft,
    busy: Boolean,
    onDismiss: () -> Unit,
    onSave: (RuleDraft) -> Unit,
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
                NumberField("Drop %", draft.dropPct.toString()) {
                    draft = draft.copy(dropPct = it.toDoubleOrNull() ?: draft.dropPct)
                }
                NumberField("Every (days)", draft.intervalDays.toString()) {
                    draft = draft.copy(intervalDays = it.toIntOrNull() ?: draft.intervalDays)
                }
                OutlinedTextField(
                    value = draft.floorPriceText,
                    onValueChange = { draft = draft.copy(floorPriceText = it) },
                    label = { Text("Never below") },
                    prefix = { Text("$") },
                    singleLine = true,
                )
                Text(
                    "Leave the floor blank and the rule keeps cutting with nothing to " +
                        "stop it.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    value = draft.filterBrand,
                    onValueChange = { draft = draft.copy(filterBrand = it) },
                    label = { Text("Only this brand (optional)") },
                    singleLine = true,
                )
                NumberField("Only listings older than (days)", draft.minAgeDays.toString()) {
                    draft = draft.copy(minAgeDays = it.toIntOrNull() ?: draft.minAgeDays)
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Auto-accept offers", modifier = Modifier.weight(1f))
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
            ) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
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
