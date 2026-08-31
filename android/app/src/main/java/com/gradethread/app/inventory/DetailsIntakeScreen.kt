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
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.stringResource
import com.gradethread.app.capture.DetailsIntakeState
import com.gradethread.app.R
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
fun DetailsIntakeScreen(modifier: Modifier = Modifier, viewModel: DetailsIntakeViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()

    DetailsIntakeContent(
        state,
        DetailsIntakeActions(
            update = viewModel::update,
            resumeDraft = viewModel::resumeDraft,
            discardDraft = viewModel::discardDraft,
            toggleMergeChoice = viewModel::toggleMergeChoice,
            confirmMerge = { viewModel.confirmMerge() },
            cancelMerge = viewModel::cancelMerge,
            addSourcer = viewModel::addSourcer,
            save = { addAnother -> viewModel.save(addAnother) },
        ),
        modifier = modifier,
        notesField = { value, onValueChange ->
            NotesFieldWithDictation(
                value = value,
                onValueChange = onValueChange,
                dictation = DictationCallbacks(
                    begin = viewModel::beginDictation,
                    end = viewModel::endDictation,
                    transcript = viewModel::onDictationTranscript,
                    error = viewModel::showDictationError,
                ),
            )
        },
    )
}

/** Everything this screen can be asked to do (US-2902 AC3). */
@Immutable
data class DetailsIntakeActions(
    /**
     * Edit the form in place. One transform rather than a setter per field:
     * this screen has fourteen inputs and a callback each would be an actions
     * record longer than the form it describes.
     */
    val update: ((DetailsIntakeState) -> DetailsIntakeState) -> Unit = {},
    val resumeDraft: () -> Unit = {},
    val discardDraft: () -> Unit = {},
    val toggleMergeChoice: (ItemMergePlan.Field, Boolean) -> Unit = { _, _ -> },
    val confirmMerge: () -> Unit = {},
    val cancelMerge: () -> Unit = {},
    val addSourcer: (String, (String?) -> Unit) -> Unit = { _, _ -> },
    val save: (Boolean) -> Unit = {},
)

/**
 * Cataloguing one item, with no ViewModel attached (US-2902 AC3).
 *
 * ⚠ THE MERGE PROMPT DECIDES WHOSE DATA SURVIVES. When an intake matches an
 * item already in inventory, this screen asks field by field which copy to
 * keep - and whatever is not kept is gone. A prompt that rendered the wrong
 * side, or lost a conflict row, silently overwrites something the seller typed
 * weeks ago.
 *
 * ⚠ AND `showValidation` EXISTS SO THE FORM IS NOT RED ON OPEN. Errors appear
 * only after a save attempt. A blank form scolding someone before they have
 * typed anything is the fastest way to make them close it.
 *
 * ⚠ THE NOTES FIELD IS A SLOT. It owns a DictationController built from a
 * Context, which a screenshot test does not have.
 */
@Composable
fun DetailsIntakeContent(
    state: DetailsIntakeViewModel.UiState,
    actions: DetailsIntakeActions,
    modifier: Modifier = Modifier,
    notesField: @Composable (String, (String) -> Unit) -> Unit = { _, _ -> },
) {
    val form = state.form

    // The validation message and its announcement share one source, so they
    // can never disagree.
    val titleError = if (state.showValidation) {
        form.titleValidationMessage?.let { stringResource(it) }
    } else {
        null
    }
    val announcer = rememberA11yAnnouncer()
    // Keyed so each NEW message announces once, not on every recomposition.
    LaunchedEffect(titleError) { titleError?.let(announcer::announce) }
    LaunchedEffect(state.banner) { state.banner?.let { announcer.announce(it.message) } }

    state.pendingDraft?.let { draft ->
        // An explicit prompt, never a silent restore: silently repopulating an
        // abandoned form is how duplicate items get created.
        AlertDialog(
            onDismissRequest = actions.discardDraft,
            title = { Text(stringResource(R.string.intake_resume_unsaved_item)) },
            text = {
                Text(draft.title.ifBlank { stringResource(R.string.intake_unsaved_draft) })
            },
            confirmButton = {
                TextButton(onClick = actions.resumeDraft) { Text(stringResource(R.string.intake_resume)) }
            },
            dismissButton = {
                TextButton(onClick = actions.discardDraft) { Text(stringResource(R.string.intake_discard)) }
            },
        )
    }

    state.merge?.let { merge ->
        MergeSkuDialog(
            prompt = merge,
            onToggle = actions.toggleMergeChoice,
            onConfirm = actions.confirmMerge,
            onCancel = actions.cancelMerge,
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
                onValueChange = { v -> actions.update { it.copy(title = v) } },
                label = stringResource(R.string.intake_title),
                errorMessage = titleError,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            SkuFieldWithScanner(
                value = form.sku,
                onValueChange = { v -> actions.update { it.copy(sku = v) } },
            )
        }
        item {
            ValidatedTextField(
                value = form.brand,
                onValueChange = { v -> actions.update { it.copy(brand = v) } },
                label = stringResource(R.string.intake_brand),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            ValidatedTextField(
                value = form.style,
                onValueChange = { v -> actions.update { it.copy(style = v) } },
                label = stringResource(R.string.intake_style),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            ValidatedTextField(
                value = form.size,
                onValueChange = { v -> actions.update { it.copy(size = v) } },
                label = stringResource(R.string.intake_size),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            ValidatedTextField(
                value = form.color,
                onValueChange = { v -> actions.update { it.copy(color = v) } },
                label = stringResource(R.string.intake_color),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            ValidatedTextField(
                value = form.material,
                onValueChange = { v -> actions.update { it.copy(material = v) } },
                label = stringResource(R.string.intake_material),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            LabeledDropdown(
                label = stringResource(R.string.intake_category),
                selected = FlipdeskCategory.from(form.category),
                options = FlipdeskCategory.entries,
                optionLabel = { stringResource(it.label) },
                onSelect = { c -> actions.update { it.copy(category = c.wire) } },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            LabeledDropdown(
                label = stringResource(R.string.intake_status),
                selected = IntakeStatus.from(form.status),
                options = IntakeStatus.entries,
                optionLabel = { stringResource(it.label) },
                onSelect = { s -> actions.update { it.copy(status = s.wire) } },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            LabeledDropdown(
                label = stringResource(R.string.intake_source),
                selected = state.sources.firstOrNull { it.id == form.sourceId },
                options = state.sources,
                optionLabel = { it.name },
                onSelect = { s -> actions.update { it.copy(sourceId = s.id) } },
                placeholder = stringResource(R.string.intake_no_source),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            ValidatedTextField(
                value = form.container,
                onValueChange = { v -> actions.update { it.copy(container = v) } },
                label = stringResource(R.string.intake_container),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            // US-2886: a roster pick, not a typed name.
            SourcedByPicker(
                label = stringResource(R.string.intake_sourced_by),
                value = form.sourcedBy,
                onValueChange = { v -> actions.update { it.copy(sourcedBy = v) } },
                sourcers = SourcerRoster(state.sourcerRoster),
                onAddPerson = actions.addSourcer,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            ValidatedTextField(
                value = form.purchasePriceText,
                onValueChange = { v -> actions.update { it.copy(purchasePriceText = v) } },
                label = stringResource(R.string.intake_purchase_price),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            notesField(form.notes) { v -> actions.update { it.copy(notes = v) } }
        }

        item {
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = Spacing.sm),
                horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BrandPrimaryButton(
                    text = stringResource(
                        if (state.saving) R.string.templates_saving else R.string.common_save,
                    ),
                    enabled = !state.saving,
                    onClick = { actions.save(false) },
                    modifier = Modifier.weight(1f),
                )
                BrandSecondaryButton(
                    text = stringResource(R.string.intake_save_add_another),
                    enabled = !state.saving,
                    onClick = { actions.save(true) },
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
    // Read here, not inside the ifBlank lambdas — those run inside a
    // non-composable `let` chain on each conflict row.
    val blank = stringResource(R.string.intake_blank_value)
    val chosen = stringResource(R.string.intake_chosen_marker)
    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text(stringResource(R.string.intake_that_sku_already_use)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                Text(
                    stringResource(R.string.intake_merge_body),
                    style = MaterialTheme.typography.bodyMedium,
                )
                prompt.conflicts.forEach { conflict ->
                    val keepExisting = conflict.field in prompt.keepExisting
                    Column(Modifier.padding(top = Spacing.xs)) {
                        Text(
                            stringResource(conflict.field.label),
                            style = MaterialTheme.typography.labelMedium,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                            TextButton(onClick = { onToggle(conflict.field, false) }) {
                                Text(
                                    conflict.current.display.ifBlank { blank } +
                                        if (!keepExisting) chosen else "",
                                )
                            }
                            TextButton(onClick = { onToggle(conflict.field, true) }) {
                                Text(
                                    conflict.existing.display.ifBlank { blank } +
                                        if (keepExisting) chosen else "",
                                )
                            }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onConfirm) { Text(stringResource(R.string.intake_combine)) } },
        dismissButton = { TextButton(onClick = onCancel) { Text(stringResource(R.string.intake_cancel)) } },
    )
}
