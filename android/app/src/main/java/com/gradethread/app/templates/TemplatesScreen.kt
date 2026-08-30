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
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
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
fun TemplatesScreen(onClose: () -> Unit = {}, viewModel: TemplatesViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()
    LaunchedEffect(Unit) { viewModel.load() }

    TemplatesContent(
        state,
        TemplatesActions(
            startCreate = viewModel::startCreate,
            startEdit = viewModel::startEdit,
            confirmDelete = viewModel::confirmDelete,
            cancelDelete = viewModel::cancelDelete,
            delete = viewModel::delete,
            editDraft = viewModel::editDraft,
            save = viewModel::save,
            cancelEdit = viewModel::cancelEdit,
            close = onClose,
        ),
    )
}

/** Everything this screen can be asked to do (US-2902 AC3). */
@Immutable
data class TemplatesActions(
    val startCreate: () -> Unit = {},
    val startEdit: (ListingTemplate) -> Unit = {},
    val confirmDelete: (ListingTemplate) -> Unit = {},
    val cancelDelete: () -> Unit = {},
    val delete: () -> Unit = {},
    /**
     * Edit the draft in place. A transform rather than a field-per-callback:
     * the editor has fourteen inputs plus a specifics map, and one setter each
     * would be an actions record longer than the form.
     */
    val editDraft: ((TemplateDraft) -> TemplateDraft) -> Unit = {},
    val save: () -> Unit = {},
    val cancelEdit: () -> Unit = {},
    val close: () -> Unit = {},
)

/**
 * Listing templates with no ViewModel attached (US-2902 AC3).
 *
 * ⚠ A TEMPLATE IS PREFILL, NOT A LINK, and the delete dialog is where that gets
 * said. Sellers hesitate over deleting one because they assume old listings
 * point at it; they do not. That sentence only exists in the dialog, so a
 * capture is the only thing that can check it is still there.
 *
 * ⚠ AND THE EMPTY STATE IS GATED ON `loaded`, NOT ON THE LIST BEING EMPTY. The
 * list is empty for the whole first frame of every visit, so keying the "no
 * templates yet" card on emptiness alone would flash it at every seller who has
 * templates. Both states are captured.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TemplatesContent(state: TemplatesViewModel.State, actions: TemplatesActions, modifier: Modifier = Modifier) {
    Column(
        modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(stringResource(R.string.templates_listing_templates), style = MaterialTheme.typography.titleLarge)
        Text(
            stringResource(R.string.templates_pick_one_publish_screen_fill),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        state.errorMessage?.let {
            InfoCard(stringResource(R.string.templates_that_didn_t_work), it, tone = InfoTone.Error)
        }

        LazyColumn(
            Modifier.fillMaxWidth().weight(1f),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            // ⚠ LOADING IS NOT EMPTY. Before US-2902's golden this branch did
            // not exist, so the first frame of every visit was a blank page
            // with a New template button on it: no list, no message, nothing
            // saying the app was working. The empty CARD was already correctly
            // gated on the loaded flag; what was missing is the state before it.
            if (state.templates.isEmpty() && !state.loaded) {
                item {
                    Text(
                        stringResource(R.string.templates_loading),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (state.templates.isEmpty() && state.loaded) {
                item {
                    InfoCard(
                        stringResource(R.string.templates_no_templates_yet),
                        stringResource(R.string.templates_intro),
                    )
                }
            }
            items(state.templates, key = { it.id }) { template ->
                TemplateCard(
                    template = template,
                    onEdit = { actions.startEdit(template) },
                    onDelete = { actions.confirmDelete(template) },
                )
            }
        }

        BrandPrimaryButton(
            text = stringResource(R.string.templates_new_template),
            enabled = !state.saving,
            modifier = Modifier.fillMaxWidth(),
        ) { actions.startCreate() }
        BrandSecondaryButton(text = stringResource(R.string.templates_back), modifier = Modifier.fillMaxWidth()) {
            actions.close()
        }
    }

    if (state.sheetOpen) {
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(onDismissRequest = actions.cancelEdit, sheetState = sheetState) {
            EditorSheet(state, actions)
        }
    }

    state.deleting?.let { target ->
        AlertDialog(
            onDismissRequest = actions.cancelDelete,
            title = { Text(stringResource(R.string.templates_delete_title, target.name)) },
            text = {
                Text(
                    // Names the one thing that keeps a reference to a template,
                    // because the worry is that deleting breaks old listings.
                    stringResource(R.string.templates_delete_body),
                )
            },
            confirmButton = {
                TextButton(onClick = actions.delete) { Text(stringResource(R.string.templates_delete)) }
            },
            dismissButton = {
                TextButton(onClick = actions.cancelDelete) { Text(stringResource(R.string.templates_keep)) }
            },
        )
    }
}

@Composable
private fun TemplateCard(template: ListingTemplate, onEdit: () -> Unit, onDelete: () -> Unit) {
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
                AssistChip(onClick = {}, label = { Text(stringResource(R.string.templates_default)) })
            }
        }
        Text(
            template.summary,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            TextButton(onClick = onEdit) { Text(stringResource(R.string.templates_edit)) }
            TextButton(onClick = onDelete) { Text(stringResource(R.string.templates_delete)) }
        }
    }
}

@Composable
private fun EditorSheet(state: TemplatesViewModel.State, actions: TemplatesActions) {
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
            stringResource(
                if (state.editingId == null) {
                    R.string.templates_new
                } else {
                    R.string.templates_edit
                },
            ),
            style = MaterialTheme.typography.titleLarge,
        )

        OutlinedTextField(
            value = draft.name,
            onValueChange = { v -> actions.editDraft { it.copy(name = v) } },
            label = { Text(stringResource(R.string.templates_name)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = draft.descriptionTemplate,
            onValueChange = { v -> actions.editDraft { it.copy(descriptionTemplate = v) } },
            label = { Text(stringResource(R.string.templates_description_block)) },
            supportingText = { Text(stringResource(R.string.templates_added_under_listing_s_own)) },
            minLines = 3,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = draft.ebayCondition,
            onValueChange = { v -> actions.editDraft { it.copy(ebayCondition = v.uppercase()) } },
            label = { Text(stringResource(R.string.templates_ebay_condition)) },
            supportingText = { Text(stringResource(R.string.templates_example_used_excellent_leave_blank)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = draft.conditionDescription,
            onValueChange = { v -> actions.editDraft { it.copy(conditionDescription = v) } },
            label = { Text(stringResource(R.string.templates_condition_notes)) },
            minLines = 2,
            modifier = Modifier.fillMaxWidth(),
        )

        Text(stringResource(R.string.templates_item_specifics), style = MaterialTheme.typography.titleSmall)
        Text(
            // The rule, stated where it matters. A seller who expects these to
            // win would otherwise think the template failed.
            stringResource(R.string.templates_these_fill_blanks_only_anything),
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
                    onValueChange = { v -> actions.editDraft { it.withSpecific(aspect, v) } },
                    singleLine = true,
                    modifier = Modifier.weight(1.2f),
                )
                TextButton(onClick = { actions.editDraft { it.withoutSpecific(aspect) } }) {
                    Text(stringResource(R.string.templates_remove))
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
                label = { Text(stringResource(R.string.templates_aspect)) },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            OutlinedTextField(
                value = newValue,
                onValueChange = { newValue = it },
                label = { Text(stringResource(R.string.templates_value)) },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            TextButton(
                enabled = newAspect.isNotBlank() && newValue.isNotBlank(),
                onClick = {
                    actions.editDraft { it.withSpecific(newAspect.trim(), newValue.trim()) }
                    newAspect = ""
                    newValue = ""
                },
            ) { Text(stringResource(R.string.templates_add)) }
        }

        Text(stringResource(R.string.templates_ebay_policies), style = MaterialTheme.typography.titleSmall)
        OutlinedTextField(
            value = draft.ebayCategoryId,
            onValueChange = { v -> actions.editDraft { it.copy(ebayCategoryId = v) } },
            label = { Text(stringResource(R.string.templates_category_id)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = draft.shippingPolicyId,
            onValueChange = { v -> actions.editDraft { it.copy(shippingPolicyId = v) } },
            label = { Text(stringResource(R.string.templates_shipping_policy_id)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = draft.returnPolicyId,
            onValueChange = { v -> actions.editDraft { it.copy(returnPolicyId = v) } },
            label = { Text(stringResource(R.string.templates_return_policy_id)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = draft.paymentPolicyId,
            onValueChange = { v -> actions.editDraft { it.copy(paymentPolicyId = v) } },
            label = { Text(stringResource(R.string.templates_payment_policy_id)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )

        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.templates_use_by_default), style = MaterialTheme.typography.bodyLarge)
                Text(
                    stringResource(R.string.templates_pre_selected_when_publish_only),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Switch(
                checked = draft.isDefault,
                onCheckedChange = { v -> actions.editDraft { it.copy(isDefault = v) } },
            )
        }

        draft.validationMessage?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }
        state.errorMessage?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }

        BrandPrimaryButton(
            text = stringResource(
                if (state.saving) R.string.templates_saving else R.string.common_save,
            ),
            enabled = state.canSave,
            modifier = Modifier.fillMaxWidth(),
        ) { actions.save() }
        BrandSecondaryButton(text = stringResource(R.string.templates_cancel), modifier = Modifier.fillMaxWidth()) {
            actions.cancelEdit()
        }
    }
}
