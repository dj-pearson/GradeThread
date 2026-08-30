package com.gradethread.app.consignment

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.ui.components.InfoCard
import com.gradethread.app.ui.components.InfoTone
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-1372: the people whose things you sell.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConsignorsScreen(
    onOpenReport: () -> Unit = {},
    onClose: () -> Unit = {},
    viewModel: ConsignorsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    LaunchedEffect(Unit) { viewModel.load() }

    ConsignorsContent(
        state,
        ConsignorsActions(
            startCreate = viewModel::startCreate,
            startEdit = viewModel::startEdit,
            confirmDelete = viewModel::confirmDelete,
            cancelDelete = viewModel::cancelDelete,
            delete = viewModel::delete,
            editDraft = viewModel::editDraft,
            save = viewModel::save,
            cancelEdit = viewModel::cancelEdit,
            openReport = onOpenReport,
            close = onClose,
        ),
    )
}

/** Everything this screen can be asked to do (US-2902 AC3). */
@Immutable
data class ConsignorsActions(
    val startCreate: () -> Unit = {},
    val startEdit: (Consignor) -> Unit = {},
    val confirmDelete: (Consignor) -> Unit = {},
    val cancelDelete: () -> Unit = {},
    val delete: () -> Unit = {},
    /**
     * Edit the draft in place. A transform rather than one setter per field:
     * the sheet has five inputs and a callback each would be longer than the
     * form it describes.
     */
    val editDraft: ((ConsignorDraft) -> ConsignorDraft) -> Unit = {},
    val save: () -> Unit = {},
    val cancelEdit: () -> Unit = {},
    val openReport: () -> Unit = {},
    val close: () -> Unit = {},
)

/**
 * Consignors with no ViewModel attached (US-2902 AC3).
 *
 * ⚠ THE SPLIT IS SOMEBODY ELSE'S MONEY. Every row carries the percentage that
 * decides what a consignor is owed on each sale, so a card that renders the
 * wrong number, or renders it where the name should be, is a payout dispute
 * rather than a cosmetic bug.
 *
 * ⚠ AND THE DELETE DIALOG SAYS WHAT DOES NOT HAPPEN. Sellers hesitate because
 * removing a consignor looks like it might take their sales history with it.
 * That sentence exists only in the dialog, so only a capture can check it is
 * still there.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConsignorsContent(state: ConsignorsViewModel.State, actions: ConsignorsActions, modifier: Modifier = Modifier) {
    Column(
        modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(stringResource(R.string.consignors_consignors), style = MaterialTheme.typography.titleLarge)
        Text(
            stringResource(R.string.consignors_split_their_share_what_s),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        state.errorMessage?.let {
            InfoCard(stringResource(R.string.consignors_that_didn_t_work), it, tone = InfoTone.Error)
        }

        LazyColumn(
            Modifier.fillMaxWidth().weight(1f),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            if (state.consignors.isEmpty() && state.loaded) {
                item {
                    InfoCard(
                        stringResource(R.string.consignors_no_consignors_yet),
                        stringResource(R.string.consignors_intro),
                    )
                }
            }
            items(state.consignors, key = { it.id }) { consignor ->
                ConsignorCard(
                    consignor = consignor,
                    onEdit = { actions.startEdit(consignor) },
                    onDelete = { actions.confirmDelete(consignor) },
                )
            }
        }

        BrandPrimaryButton(
            text = stringResource(R.string.consignors_add_consignor),
            enabled = !state.saving,
            modifier = Modifier.fillMaxWidth(),
        ) { actions.startCreate() }
        BrandSecondaryButton(
            text = stringResource(R.string.consignors_payout_report),
            modifier = Modifier.fillMaxWidth(),
            onClick = actions.openReport,
        )
        BrandSecondaryButton(
            text = stringResource(R.string.consignors_back),
            modifier = Modifier.fillMaxWidth(),
            onClick = actions.close,
        )
    }

    if (state.sheetOpen) {
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = actions.cancelEdit,
            sheetState = sheetState,
        ) {
            EditSheet(state, actions)
        }
    }

    state.deleting?.let { target ->
        AlertDialog(
            onDismissRequest = actions.cancelDelete,
            title = { Text(stringResource(R.string.consignors_remove_title, target.name)) },
            text = {
                Text(
                    // Says what does NOT happen, because that is the fear:
                    // deleting a consignor looks like it might take their sales
                    // history with it.
                    stringResource(R.string.consignors_remove_body),
                )
            },
            confirmButton = {
                TextButton(onClick = actions.delete) { Text(stringResource(R.string.consignors_remove)) }
            },
            dismissButton = {
                TextButton(onClick = actions.cancelDelete) { Text(stringResource(R.string.consignors_keep)) }
            },
        )
    }
}

@Composable
private fun ConsignorCard(consignor: Consignor, onEdit: () -> Unit, onDelete: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().clickable { onEdit() }.cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                consignor.name,
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f),
            )
            Text(
                stringResource(
                    R.string.consignors_split_pct,
                    ConsignorDraft.formatPct(consignor.defaultSplitPct),
                ),
                style = MaterialTheme.typography.titleMedium,
            )
        }
        listOfNotNull(consignor.contactEmail, consignor.contactPhone)
            .takeIf { it.isNotEmpty() }
            ?.let {
                Text(
                    it.joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        consignor.notes?.takeIf { it.isNotBlank() }?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            TextButton(onClick = onEdit) { Text(stringResource(R.string.consignors_edit)) }
            TextButton(onClick = onDelete) { Text(stringResource(R.string.consignors_remove)) }
        }
    }
}

@Composable
private fun EditSheet(state: ConsignorsViewModel.State, actions: ConsignorsActions) {
    val draft = state.editing ?: return
    Column(
        Modifier.fillMaxWidth().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Text(
            stringResource(
                if (state.editingId == null) {
                    R.string.consignors_new
                } else {
                    R.string.consignors_edit_title
                },
            ),
            style = MaterialTheme.typography.titleLarge,
        )
        OutlinedTextField(
            value = draft.name,
            onValueChange = { v -> actions.editDraft { it.copy(name = v) } },
            label = { Text(stringResource(R.string.consignors_name)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = draft.splitText,
            onValueChange = { v -> actions.editDraft { it.copy(splitText = v) } },
            label = { Text(stringResource(R.string.consignors_default_split)) },
            singleLine = true,
            isError = draft.splitText.isNotBlank() && !draft.splitInRange,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = draft.contactEmail,
            onValueChange = { v -> actions.editDraft { it.copy(contactEmail = v) } },
            label = { Text(stringResource(R.string.consignors_email_optional)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = draft.contactPhone,
            onValueChange = { v -> actions.editDraft { it.copy(contactPhone = v) } },
            label = { Text(stringResource(R.string.consignors_phone_optional)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = draft.notes,
            onValueChange = { v -> actions.editDraft { it.copy(notes = v) } },
            label = { Text(stringResource(R.string.consignors_notes_optional)) },
            minLines = 2,
            modifier = Modifier.fillMaxWidth(),
        )

        draft.validationMessage?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
        state.errorMessage?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }

        BrandPrimaryButton(
            text = stringResource(
                if (state.saving) R.string.templates_saving else R.string.common_save,
            ),
            enabled = state.canSave,
            modifier = Modifier.fillMaxWidth(),
        ) { actions.save() }
        BrandSecondaryButton(text = stringResource(R.string.consignors_cancel), modifier = Modifier.fillMaxWidth()) {
            actions.cancelEdit()
        }
    }
}
