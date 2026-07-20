package com.gradethread.app.inventory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.compose.runtime.collectAsState
import com.gradethread.app.capture.FlipdeskCategory
import com.gradethread.app.capture.IntakeStatus
import androidx.compose.runtime.LaunchedEffect
import com.gradethread.app.ui.a11y.rememberA11yAnnouncer
import com.gradethread.app.ui.components.LabeledDropdown
import com.gradethread.app.ui.components.ValidatedTextField
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1330: the details-first intake form. Typing is the fast path for
 * cataloging a haul — photos come later (US-1328's capture flow).
 */
@Composable
fun DetailsIntakeScreen(
    modifier: Modifier = Modifier,
    viewModel: DetailsIntakeViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    val form = state.form

    // The validation message and its announcement share one source, so they
    // can never disagree.
    val titleError = if (state.showValidation) form.titleValidationMessage else null
    val announcer = rememberA11yAnnouncer()
    // Keyed so each NEW message announces once, not on every recomposition.
    LaunchedEffect(titleError) { titleError?.let(announcer::announce) }
    LaunchedEffect(state.banner) { state.banner?.let { announcer.announce(it.message) } }

    state.pendingDraft?.let { draft ->
        // An explicit prompt, never a silent restore: silently repopulating an
        // abandoned form is how duplicate items get created.
        AlertDialog(
            onDismissRequest = viewModel::discardDraft,
            title = { Text("Resume your unsaved item?") },
            text = { Text(draft.title.ifBlank { "You have an unsaved draft." }) },
            confirmButton = {
                TextButton(onClick = viewModel::resumeDraft) { Text("Resume") }
            },
            dismissButton = {
                TextButton(onClick = viewModel::discardDraft) { Text("Discard") }
            },
        )
    }

    state.merge?.let { merge ->
        MergeSkuDialog(
            prompt = merge,
            onToggle = viewModel::toggleMergeChoice,
            onConfirm = { viewModel.confirmMerge() },
            onCancel = viewModel::cancelMerge,
        )
    }

    LazyColumn(
        modifier = modifier.fillMaxWidth().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        state.banner?.let { banner ->
            item {
                Text(
                    text = banner.message,
                    color = if (banner.isError) {
                        MaterialTheme.colorScheme.error
                    } else {
                        MaterialTheme.colorScheme.primary
                    },
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }

        item {
            ValidatedTextField(
                value = form.title,
                onValueChange = { v -> viewModel.update { it.copy(title = v) } },
                label = "Title",
                errorMessage = titleError,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            ValidatedTextField(
                value = form.sku,
                onValueChange = { v -> viewModel.update { it.copy(sku = v) } },
                label = "SKU",
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            ValidatedTextField(
                value = form.brand,
                onValueChange = { v -> viewModel.update { it.copy(brand = v) } },
                label = "Brand",
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            ValidatedTextField(
                value = form.style,
                onValueChange = { v -> viewModel.update { it.copy(style = v) } },
                label = "Style",
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            ValidatedTextField(
                value = form.size,
                onValueChange = { v -> viewModel.update { it.copy(size = v) } },
                label = "Size",
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            ValidatedTextField(
                value = form.color,
                onValueChange = { v -> viewModel.update { it.copy(color = v) } },
                label = "Color",
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            ValidatedTextField(
                value = form.material,
                onValueChange = { v -> viewModel.update { it.copy(material = v) } },
                label = "Material",
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            LabeledDropdown(
                label = "Category",
                selected = FlipdeskCategory.from(form.category),
                options = FlipdeskCategory.entries,
                optionLabel = { it.label },
                onSelect = { c -> viewModel.update { it.copy(category = c.wire) } },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            LabeledDropdown(
                label = "Status",
                selected = IntakeStatus.from(form.status),
                options = IntakeStatus.entries,
                optionLabel = { it.label },
                onSelect = { s -> viewModel.update { it.copy(status = s.wire) } },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            LabeledDropdown(
                label = "Source",
                selected = state.sources.firstOrNull { it.id == form.sourceId },
                options = state.sources,
                optionLabel = { it.name },
                onSelect = { s -> viewModel.update { it.copy(sourceId = s.id) } },
                placeholder = "No source",
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            ValidatedTextField(
                value = form.container,
                onValueChange = { v -> viewModel.update { it.copy(container = v) } },
                label = "Container",
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            ValidatedTextField(
                value = form.sourcedBy,
                onValueChange = { v -> viewModel.update { it.copy(sourcedBy = v) } },
                label = "Sourced by",
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            ValidatedTextField(
                value = form.purchasePriceText,
                onValueChange = { v -> viewModel.update { it.copy(purchasePriceText = v) } },
                label = "Purchase price",
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            ValidatedTextField(
                value = form.notes,
                onValueChange = { v -> viewModel.update { it.copy(notes = v) } },
                label = "Notes",
                singleLine = false,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        item {
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = Spacing.sm),
                horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BrandPrimaryButton(
                    text = if (state.saving) "Saving…" else "Save",
                    enabled = !state.saving,
                    onClick = { viewModel.save() },
                    modifier = Modifier.weight(1f),
                )
                BrandSecondaryButton(
                    text = "Save & add another",
                    enabled = !state.saving,
                    onClick = { viewModel.save(addAnother = true) },
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

/** The combine sheet shown when the typed SKU already belongs to an item. */
@Composable
private fun MergeSkuDialog(
    prompt: DetailsIntakeViewModel.MergePrompt,
    onToggle: (ItemMergePlan.Field, Boolean) -> Unit,
    onConfirm: () -> Unit,
    onCancel: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text("That SKU is already in use") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                Text(
                    "Combine these details into the existing item. " +
                        "Pick which value to keep for each field.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                prompt.conflicts.forEach { conflict ->
                    val keepExisting = conflict.field in prompt.keepExisting
                    Column(Modifier.padding(top = Spacing.xs)) {
                        Text(conflict.field.label, style = MaterialTheme.typography.labelMedium)
                        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                            TextButton(onClick = { onToggle(conflict.field, false) }) {
                                Text(
                                    conflict.current.display.ifBlank { "(blank)" } +
                                        if (!keepExisting) " ✓" else "",
                                )
                            }
                            TextButton(onClick = { onToggle(conflict.field, true) }) {
                                Text(
                                    conflict.existing.display.ifBlank { "(blank)" } +
                                        if (keepExisting) " ✓" else "",
                                )
                            }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onConfirm) { Text("Combine") } },
        dismissButton = { TextButton(onClick = onCancel) { Text("Cancel") } },
    )
}
