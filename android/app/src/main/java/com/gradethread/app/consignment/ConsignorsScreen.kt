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

    Column(
        Modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(stringResource(R.string.consignors_consignors), style = MaterialTheme.typography.titleLarge)
        Text(
            stringResource(R.string.consignors_split_their_share_what_s),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        state.errorMessage?.let { InfoCard(stringResource(R.string.consignors_that_didn_t_work), it, tone = InfoTone.Error) }

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
                    onEdit = { viewModel.startEdit(consignor) },
                    onDelete = { viewModel.confirmDelete(consignor) },
                )
            }
        }

        BrandPrimaryButton(
            text = stringResource(R.string.consignors_add_consignor),
            enabled = !state.saving,
            modifier = Modifier.fillMaxWidth(),
        ) { viewModel.startCreate() }
        BrandSecondaryButton(text = stringResource(R.string.consignors_payout_report), modifier = Modifier.fillMaxWidth()) {
            onOpenReport()
        }
        BrandSecondaryButton(text = stringResource(R.string.consignors_back), modifier = Modifier.fillMaxWidth()) { onClose() }
    }

    if (state.sheetOpen) {
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = viewModel::cancelEdit,
            sheetState = sheetState,
        ) {
            EditSheet(state, viewModel)
        }
    }

    state.deleting?.let { target ->
        AlertDialog(
            onDismissRequest = viewModel::cancelDelete,
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
                TextButton(onClick = viewModel::delete) { Text(stringResource(R.string.consignors_remove)) }
            },
            dismissButton = {
                TextButton(onClick = viewModel::cancelDelete) { Text(stringResource(R.string.consignors_keep)) }
            },
        )
    }
}

@Composable
private fun ConsignorCard(
    consignor: Consignor,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
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
private fun EditSheet(state: ConsignorsViewModel.State, viewModel: ConsignorsViewModel) {
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
            onValueChange = { v -> viewModel.editDraft { it.copy(name = v) } },
            label = { Text(stringResource(R.string.consignors_name)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = draft.splitText,
            onValueChange = { v -> viewModel.editDraft { it.copy(splitText = v) } },
            label = { Text(stringResource(R.string.consignors_default_split)) },
            singleLine = true,
            isError = draft.splitText.isNotBlank() && !draft.splitInRange,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = draft.contactEmail,
            onValueChange = { v -> viewModel.editDraft { it.copy(contactEmail = v) } },
            label = { Text(stringResource(R.string.consignors_email_optional)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = draft.contactPhone,
            onValueChange = { v -> viewModel.editDraft { it.copy(contactPhone = v) } },
            label = { Text(stringResource(R.string.consignors_phone_optional)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = draft.notes,
            onValueChange = { v -> viewModel.editDraft { it.copy(notes = v) } },
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
        ) { viewModel.save() }
        BrandSecondaryButton(text = stringResource(R.string.consignors_cancel), modifier = Modifier.fillMaxWidth()) {
            viewModel.cancelEdit()
        }
    }
}
