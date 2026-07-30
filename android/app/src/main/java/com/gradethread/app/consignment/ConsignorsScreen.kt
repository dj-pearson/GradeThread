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
        Text("Consignors", style = MaterialTheme.typography.titleLarge)
        Text(
            "The split is their share of what's left after fees.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        state.errorMessage?.let { InfoCard("That didn't work", it, tone = InfoTone.Error) }

        LazyColumn(
            Modifier.fillMaxWidth().weight(1f),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            if (state.consignors.isEmpty() && state.loaded) {
                item {
                    InfoCard(
                        "No consignors yet",
                        "Add whoever you sell for, then set them on an item's page and " +
                            "we'll track what you owe them.",
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
            text = "Add a consignor",
            enabled = !state.saving,
            modifier = Modifier.fillMaxWidth(),
        ) { viewModel.startCreate() }
        BrandSecondaryButton(text = "Payout report", modifier = Modifier.fillMaxWidth()) {
            onOpenReport()
        }
        BrandSecondaryButton(text = "Back", modifier = Modifier.fillMaxWidth()) { onClose() }
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
            title = { Text("Remove ${target.name}?") },
            text = {
                Text(
                    // Says what does NOT happen, because that is the fear:
                    // deleting a consignor looks like it might take their sales
                    // history with it.
                    "Their items stay, along with everything they've already sold. " +
                        "The items just stop being linked to them.",
                )
            },
            confirmButton = {
                TextButton(onClick = viewModel::delete) { Text("Remove") }
            },
            dismissButton = {
                TextButton(onClick = viewModel::cancelDelete) { Text("Keep") }
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
                "${ConsignorDraft.formatPct(consignor.defaultSplitPct)}%",
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
            TextButton(onClick = onEdit) { Text("Edit") }
            TextButton(onClick = onDelete) { Text("Remove") }
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
            if (state.editingId == null) "New consignor" else "Edit consignor",
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
            value = draft.splitText,
            onValueChange = { v -> viewModel.editDraft { it.copy(splitText = v) } },
            label = { Text("Default split %") },
            singleLine = true,
            isError = draft.splitText.isNotBlank() && !draft.splitInRange,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = draft.contactEmail,
            onValueChange = { v -> viewModel.editDraft { it.copy(contactEmail = v) } },
            label = { Text("Email (optional)") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = draft.contactPhone,
            onValueChange = { v -> viewModel.editDraft { it.copy(contactPhone = v) } },
            label = { Text("Phone (optional)") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = draft.notes,
            onValueChange = { v -> viewModel.editDraft { it.copy(notes = v) } },
            label = { Text("Notes (optional)") },
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
            text = if (state.saving) "Saving…" else "Save",
            enabled = state.canSave,
            modifier = Modifier.fillMaxWidth(),
        ) { viewModel.save() }
        BrandSecondaryButton(text = "Cancel", modifier = Modifier.fillMaxWidth()) {
            viewModel.cancelEdit()
        }
    }
}
