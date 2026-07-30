package com.gradethread.app.autolister

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import com.gradethread.app.money.Money
import com.gradethread.app.ui.components.InfoCard
import com.gradethread.app.ui.components.InfoTone
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-1359: generated drafts — review them, edit them, or change many at once.
 */
@Composable
fun DraftsLibraryScreen(
    onClose: () -> Unit = {},
    viewModel: AutolisterViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    var editing by remember { mutableStateOf<DraftListing?>(null) }
    var bulkOpen by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { viewModel.loadDrafts() }

    Column(
        Modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text("Draft listings", style = MaterialTheme.typography.titleLarge)

        state.errorMessage?.let { InfoCard("That didn't work", it, tone = InfoTone.Error) }
        state.banner?.let { InfoCard("Done", it, tone = InfoTone.Success) }

        state.batch?.let { batch -> BatchPanel(batch, state, viewModel) }

        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                "${state.selected.size} of ${state.drafts.size} selected",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = viewModel::toggleAll) {
                Text(if (state.allSelected) "Clear all" else "Select all")
            }
        }

        when {
            state.loading -> Hint("Loading…")
            state.drafts.isEmpty() -> Hint(
                "No drafts yet. Generate them from items in your inventory, and they " +
                    "land here for review before anything is published.",
            )

            else -> LazyColumn(
                Modifier.fillMaxWidth().weight(1f),
                verticalArrangement = Arrangement.spacedBy(Spacing.sm),
            ) {
                items(state.drafts, key = { it.id }) { draft ->
                    DraftCard(
                        draft = draft,
                        selected = draft.id in state.selected,
                        busy = state.busy,
                        onToggle = { viewModel.toggle(draft.id) },
                        onEdit = { editing = draft },
                        onDelete = { viewModel.deleteDraft(draft) },
                    )
                }
            }
        }

        if (state.selected.isNotEmpty()) {
            BrandPrimaryButton(
                text = "Edit ${state.selected.size} together",
                enabled = !state.busy,
                modifier = Modifier.fillMaxWidth(),
            ) { bulkOpen = true }
        }

        BrandSecondaryButton(text = "Back", modifier = Modifier.fillMaxWidth()) { onClose() }
    }

    editing?.let { draft ->
        DraftEditorDialog(
            draft = draft,
            busy = state.busy,
            onDismiss = { editing = null },
            onSave = { title, description, price ->
                viewModel.saveDraft(draft, title, description, price)
                editing = null
            },
        )
    }

    if (bulkOpen) {
        BulkEditDialog(
            state = state,
            onDismiss = { bulkOpen = false },
            onPrice = {
                viewModel.bulkPrice(it)
                bulkOpen = false
            },
            onText = { title, description ->
                viewModel.bulkText(title, description)
                bulkOpen = false
            },
        )
    }
}

@Composable
private fun BatchPanel(
    batch: AutolisterBatch,
    state: AutolisterViewModel.State,
    viewModel: AutolisterViewModel,
) {
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Text(Autolister.summary(batch), style = MaterialTheme.typography.bodyMedium)
        if (!batch.status.isTerminal) {
            LinearProgressIndicator(
                progress = { Autolister.progressFraction(batch) },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (state.stalled) {
            // The failure a progress bar hides: the worker died and the row
            // stopped moving. Say so, and offer the nudge.
            Text(
                Autolister.STALL_MESSAGE,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
            BrandSecondaryButton(
                text = "Resume",
                enabled = !state.busy,
                modifier = Modifier.fillMaxWidth(),
            ) { viewModel.resume() }
        }
        if (state.failedJobs.isNotEmpty()) {
            Text(
                state.failedJobs.mapNotNull { it.error }.distinct().take(3)
                    .joinToString("\n") { "• $it" },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (state.canRetry) {
            BrandSecondaryButton(
                text = "Retry the ${batch.failedCount} that failed",
                enabled = !state.busy,
                modifier = Modifier.fillMaxWidth(),
            ) { viewModel.retryFailed() }
        }
    }
}

@Composable
private fun DraftCard(
    draft: DraftListing,
    selected: Boolean,
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
            Checkbox(checked = selected, onCheckedChange = { onToggle() })
            Text(
                draft.title,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                modifier = Modifier.weight(1f),
            )
        }
        Row {
            draft.listingPrice?.let {
                Text(Money.format(it), style = MaterialTheme.typography.bodyMedium)
            }
            if (draft.priceIsEstimated == true) {
                // The seller should know which numbers were guessed before
                // bulk-publishing them.
                Text(
                    "   estimated",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        draft.publishError?.takeIf { it.isNotBlank() }?.let {
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
private fun DraftEditorDialog(
    draft: DraftListing,
    busy: Boolean,
    onDismiss: () -> Unit,
    onSave: (String, String, String) -> Unit,
) {
    var title by remember(draft.id) { mutableStateOf(draft.listingTitle.orEmpty()) }
    var description by remember(draft.id) { mutableStateOf(draft.listingDescription.orEmpty()) }
    var price by remember(draft.id) {
        mutableStateOf(draft.listingPrice?.let { String.format(java.util.Locale.US, "%.2f", it) }.orEmpty())
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Edit draft") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    label = { Text("Title") },
                )
                OutlinedTextField(
                    value = description,
                    onValueChange = { description = it },
                    label = { Text("Description") },
                    minLines = 3,
                )
                OutlinedTextField(
                    value = price,
                    onValueChange = { price = it },
                    label = { Text("Price") },
                    prefix = { Text("$") },
                    singleLine = true,
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                        keyboardType = KeyboardType.Decimal,
                    ),
                )
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy,
                onClick = { onSave(title, description, price) },
            ) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun BulkEditDialog(
    state: AutolisterViewModel.State,
    onDismiss: () -> Unit,
    onPrice: (DraftBulk.PriceChange) -> Unit,
    onText: (String?, String?) -> Unit,
) {
    var mode by remember { mutableStateOf("price") }
    var priceText by remember { mutableStateOf("") }
    var percentText by remember { mutableStateOf("") }
    var titleText by remember { mutableStateOf("") }

    val change: DraftBulk.PriceChange? = when {
        mode == "set" -> DraftBulk.parsePrice(priceText)?.let { DraftBulk.PriceChange.Absolute(it) }
        mode == "percent" -> percentText.trim().removeSuffix("%").toDoubleOrNull()
            ?.let { DraftBulk.PriceChange.Percent(it) }

        mode == "round99" -> DraftBulk.PriceChange.Round99
        else -> null
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Edit ${state.selected.size} drafts") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
                    listOf(
                        "set" to "Set price",
                        "percent" to "Adjust %",
                        "round99" to "End in .99",
                        "title" to "Title",
                    ).forEach { (key, label) ->
                        FilterChip(
                            selected = mode == key,
                            onClick = { mode = key },
                            label = { Text(label) },
                        )
                    }
                }
                when (mode) {
                    "set" -> OutlinedTextField(
                        value = priceText,
                        onValueChange = { priceText = it },
                        label = { Text("New price") },
                        prefix = { Text("$") },
                        singleLine = true,
                    )

                    "percent" -> OutlinedTextField(
                        value = percentText,
                        onValueChange = { percentText = it },
                        label = { Text("Change by (use -10 to cut)") },
                        suffix = { Text("%") },
                        singleLine = true,
                    )

                    "title" -> OutlinedTextField(
                        value = titleText,
                        onValueChange = { titleText = it },
                        label = { Text("Title for all of them") },
                    )
                }
                change?.let {
                    // Names the skipped rows: a percentage can't apply to a
                    // draft with no price, and "12 drafts" when only 9 move is
                    // exactly the mismatch that erodes trust.
                    Text(
                        DraftBulk.previewSummary(state.drafts, state.selected, it),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = if (mode == "title") titleText.isNotBlank() else change != null,
                onClick = {
                    if (mode == "title") {
                        onText(titleText, null)
                    } else {
                        change?.let(onPrice)
                    }
                },
            ) { Text("Apply") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
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
