package com.gradethread.app.templates

import androidx.compose.foundation.clickable
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
import androidx.compose.material3.AssistChip
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.ui.components.InfoCard
import com.gradethread.app.ui.components.InfoTone
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-1373: saved listing presets.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TemplatesScreen(
    onClose: () -> Unit = {},
    viewModel: TemplatesViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    LaunchedEffect(Unit) { viewModel.load() }

    Column(
        Modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text("Listing templates", style = MaterialTheme.typography.titleLarge)
        Text(
            "Pick one in the publish screen to fill in the parts you type every time.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        state.errorMessage?.let { InfoCard("That didn't work", it, tone = InfoTone.Error) }

        LazyColumn(
            Modifier.fillMaxWidth().weight(1f),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            if (state.templates.isEmpty() && state.loaded) {
                item {
                    InfoCard(
                        "No templates yet",
                        "Save the condition, the specifics and the boilerplate you reuse, " +
                            "then apply them with one tap when you list.",
                    )
                }
            }
            items(state.templates, key = { it.id }) { template ->
                TemplateCard(
                    template = template,
                    onEdit = { viewModel.startEdit(template) },
                    onDelete = { viewModel.confirmDelete(template) },
                )
            }
        }

        BrandPrimaryButton(
            text = "New template",
            enabled = !state.saving,
            modifier = Modifier.fillMaxWidth(),
        ) { viewModel.startCreate() }
        BrandSecondaryButton(text = "Back", modifier = Modifier.fillMaxWidth()) { onClose() }
    }

    if (state.sheetOpen) {
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(onDismissRequest = viewModel::cancelEdit, sheetState = sheetState) {
            EditorSheet(state, viewModel)
        }
    }

    state.deleting?.let { target ->
        AlertDialog(
            onDismissRequest = viewModel::cancelDelete,
            title = { Text("Delete ${target.name}?") },
            text = {
                Text(
                    // Names the one thing that keeps a reference to a template,
                    // because the worry is that deleting breaks old listings.
                    "Listings you've already published keep everything this template " +
                        "filled in. Only the preset goes.",
                )
            },
            confirmButton = { TextButton(onClick = viewModel::delete) { Text("Delete") } },
            dismissButton = { TextButton(onClick = viewModel::cancelDelete) { Text("Keep") } },
        )
    }
}

@Composable
private fun TemplateCard(
    template: ListingTemplate,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().clickable { onEdit() }.cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                template.name,
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f),
            )
            if (template.isDefault) {
                AssistChip(onClick = {}, label = { Text("Default") })
            }
        }
        Text(
            template.summary,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            TextButton(onClick = onEdit) { Text("Edit") }
            TextButton(onClick = onDelete) { Text("Delete") }
        }
    }
}

@Composable
private fun EditorSheet(state: TemplatesViewModel.State, viewModel: TemplatesViewModel) {
    val draft = state.editing ?: return
    var newAspect by remember { mutableStateOf("") }
    var newValue by remember { mutableStateOf("") }

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Text(
            if (state.editingId == null) "New template" else "Edit template",
            style = MaterialTheme.typography.titleLarge,
        )

        OutlinedTextField(
            value = draft.name,
            onValueChange = { v -> viewModel.editDraft { it.copy(name = v) } },
            label = { Text("Name") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = draft.descriptionTemplate,
            onValueChange = { v -> viewModel.editDraft { it.copy(descriptionTemplate = v) } },
            label = { Text("Description block") },
            supportingText = { Text("Added under the listing's own description.") },
            minLines = 3,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = draft.ebayCondition,
            onValueChange = { v -> viewModel.editDraft { it.copy(ebayCondition = v.uppercase()) } },
            label = { Text("eBay condition") },
            supportingText = { Text("For example USED_EXCELLENT. Leave blank to not set one.") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = draft.conditionDescription,
            onValueChange = { v -> viewModel.editDraft { it.copy(conditionDescription = v) } },
            label = { Text("Condition notes") },
            minLines = 2,
            modifier = Modifier.fillMaxWidth(),
        )

        Text("Item specifics", style = MaterialTheme.typography.titleSmall)
        Text(
            // The rule, stated where it matters. A seller who expects these to
            // win would otherwise think the template failed.
            "These fill blanks only. Anything you've already set on a listing stays.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        draft.itemSpecifics.toList().sortedBy { it.first }.forEach { (aspect, value) ->
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(aspect, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                OutlinedTextField(
                    value = value,
                    onValueChange = { v -> viewModel.editDraft { it.withSpecific(aspect, v) } },
                    singleLine = true,
                    modifier = Modifier.weight(1.2f),
                )
                TextButton(onClick = { viewModel.editDraft { it.withoutSpecific(aspect) } }) {
                    Text("Remove")
                }
            }
        }
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedTextField(
                value = newAspect,
                onValueChange = { newAspect = it },
                label = { Text("Aspect") },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            OutlinedTextField(
                value = newValue,
                onValueChange = { newValue = it },
                label = { Text("Value") },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            TextButton(
                enabled = newAspect.isNotBlank() && newValue.isNotBlank(),
                onClick = {
                    viewModel.editDraft { it.withSpecific(newAspect.trim(), newValue.trim()) }
                    newAspect = ""
                    newValue = ""
                },
            ) { Text("Add") }
        }

        Text("eBay policies", style = MaterialTheme.typography.titleSmall)
        OutlinedTextField(
            value = draft.ebayCategoryId,
            onValueChange = { v -> viewModel.editDraft { it.copy(ebayCategoryId = v) } },
            label = { Text("Category id") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = draft.shippingPolicyId,
            onValueChange = { v -> viewModel.editDraft { it.copy(shippingPolicyId = v) } },
            label = { Text("Shipping policy id") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = draft.returnPolicyId,
            onValueChange = { v -> viewModel.editDraft { it.copy(returnPolicyId = v) } },
            label = { Text("Return policy id") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = draft.paymentPolicyId,
            onValueChange = { v -> viewModel.editDraft { it.copy(paymentPolicyId = v) } },
            label = { Text("Payment policy id") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )

        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Use by default", style = MaterialTheme.typography.bodyLarge)
                Text(
                    "Pre-selected when you publish. Only one template can be the default.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Switch(
                checked = draft.isDefault,
                onCheckedChange = { v -> viewModel.editDraft { it.copy(isDefault = v) } },
            )
        }

        draft.validationMessage?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }
        state.errorMessage?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }

        BrandPrimaryButton(
            text = if (state.saving) "Saving…" else "Save",
            enabled = state.canSave,
            modifier = Modifier.fillMaxWidth(),
        ) { viewModel.save() }
        BrandSecondaryButton(text = "Cancel", modifier = Modifier.fillMaxWidth()) {
            viewModel.cancelEdit()
        }
    }
}
