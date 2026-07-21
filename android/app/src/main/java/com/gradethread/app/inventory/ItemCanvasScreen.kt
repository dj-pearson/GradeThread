package com.gradethread.app.inventory

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.text.KeyboardOptions
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.capture.FlipdeskCategory
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1343: the item canvas — identity, pricing and notes, edited in place.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ItemCanvasScreen(
    itemId: String,
    onClose: () -> Unit,
    onGrade: (String) -> Unit,
    onOpenReport: (String) -> Unit,
    /** US-1344: a duplicate opens as its own canvas. */
    onOpenItem: (String) -> Unit,
    modifier: Modifier = Modifier,
    viewModel: ItemCanvasViewModel = hiltViewModel(),
) {
    LaunchedEffect(itemId) { viewModel.bind(itemId) }
    val state by viewModel.state.collectAsState()

    if (state.loading) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }
    if (state.notFound) {
        Column(Modifier.fillMaxSize().padding(Spacing.md)) {
            Text("Item not found", style = MaterialTheme.typography.titleMedium)
            Text(
                "It may have been deleted, or it hasn't synced to this device yet.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            BrandPrimaryButton(text = "Back", modifier = Modifier.fillMaxWidth()) { onClose() }
        }
        return
    }

    val draft = state.draft
    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        state.errorMessage?.let { message ->
            Banner(message, MaterialTheme.colorScheme.error) { viewModel.dismissError() }
        }
        if (state.queuedOffline) {
            // Named as saved-and-waiting, not failed: the edit IS kept.
            Banner(
                "Saved on this device — it'll sync when you're back online.",
                MaterialTheme.colorScheme.onSurfaceVariant,
                null,
            )
        }

        SectionHeader("Item")
        Field("Title", draft.title) { v -> viewModel.edit { it.copy(title = v) } }
        if (draft.title.isBlank()) {
            Text(
                "Title is required to save.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
        Field("Brand", draft.brand) { v -> viewModel.edit { it.copy(brand = v) } }
        Field("SKU", draft.sku) { v -> viewModel.edit { it.copy(sku = v) } }
        Field("Size", draft.size) { v -> viewModel.edit { it.copy(size = v) } }
        Field("Color", draft.color) { v -> viewModel.edit { it.copy(color = v) } }
        Field("Material", draft.material) { v -> viewModel.edit { it.copy(material = v) } }
        Field("Style", draft.style) { v -> viewModel.edit { it.copy(style = v) } }

        SectionHeader("Category")
        FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
            FlipdeskCategory.entries.forEach { option ->
                FilterChip(
                    selected = draft.category == option,
                    onClick = {
                        // Tapping the selected chip clears it, so an item with
                        // no category can be left that way rather than forced
                        // into one by the act of opening the canvas.
                        viewModel.setCategory(if (draft.category == option) null else option)
                    },
                    label = { Text(option.label) },
                )
            }
        }
        if (draft.category == null) {
            Text(
                "No category set. Pick one to unlock category-specific photos and specifics.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (draft.showsGarmentFields) {
            Field("Garment type", draft.garmentType) { v ->
                viewModel.edit { it.copy(garmentType = v) }
            }
            Field("Garment category", draft.garmentCategory) { v ->
                viewModel.edit { it.copy(garmentCategory = v) }
            }
        }

        MeasurementsSection(
            measurements = draft.measurements,
            category = draft.category?.wire,
            onSet = viewModel::setMeasurement,
        )
        SizeEstimateCard(
            estimate = state.sizeEstimate,
            busy = state.estimatingSize,
            errorMessage = state.sizeErrorMessage,
            onEstimate = viewModel::estimateSize,
            onApply = viewModel::applyInferredSize,
            onDismiss = viewModel::dismissSizeEstimate,
        )

        SectionHeader("Pricing & sourcing")
        Field("Acquired price", draft.acquiredPriceText, numeric = true) { v ->
            viewModel.edit { it.copy(acquiredPriceText = v) }
        }
        Field("Target price", draft.targetPriceText, numeric = true) { v ->
            viewModel.edit { it.copy(targetPriceText = v) }
        }
        Field("Sourced by", draft.sourcedBy) { v -> viewModel.edit { it.copy(sourcedBy = v) } }
        Field("Container", draft.container) { v -> viewModel.edit { it.copy(container = v) } }
        Field("Location bin", draft.locationBin) { v ->
            viewModel.edit { it.copy(locationBin = v) }
        }
        Field("Consignor split %", draft.consignmentSplitText, numeric = true) { v ->
            viewModel.edit { it.copy(consignmentSplitText = v) }
        }

        SectionHeader("Notes")
        Field("Description", draft.description, lines = 3) { v ->
            viewModel.edit { it.copy(description = v) }
        }
        Field("Condition notes", draft.conditionNotes, lines = 3) { v ->
            viewModel.edit { it.copy(conditionNotes = v) }
        }

        HorizontalDivider(Modifier.padding(vertical = Spacing.xs))

        BrandPrimaryButton(
            text = when {
                state.saving -> "Saving…"
                state.isDirty -> "Save changes"
                else -> "Saved"
            },
            enabled = state.canSave,
            modifier = Modifier.fillMaxWidth(),
        ) { viewModel.save() }

        if (state.isDirty) {
            TextButton(onClick = viewModel::discard, modifier = Modifier.fillMaxWidth()) {
                Text("Discard changes")
            }
        }

        // US-1344: photos live here, not on a separate screen — the cover
        // decides the eBay main image, so it belongs next to the fields that
        // decide the rest of the listing.
        ItemPhotosSection(
            itemId = itemId,
            onDuplicated = onOpenItem,
            onDeleted = onClose,
            onShareCertificate = null,
        )

        SectionHeader("Grading")
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            BrandSecondaryButton(text = "Grade", modifier = Modifier.weight(1f)) { onGrade(itemId) }
            BrandSecondaryButton(text = "Report", modifier = Modifier.weight(1f)) {
                onOpenReport(itemId)
            }
        }

        BrandSecondaryButton(text = "Back", modifier = Modifier.fillMaxWidth()) { onClose() }
    }
}

@Composable
private fun SectionHeader(text: String) {
    Column(Modifier.padding(top = Spacing.sm)) {
        Text(
            text,
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun Field(
    label: String,
    value: String,
    numeric: Boolean = false,
    lines: Int = 1,
    onChange: (String) -> Unit,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        singleLine = lines == 1,
        minLines = lines,
        keyboardOptions = if (numeric) {
            KeyboardOptions(keyboardType = KeyboardType.Decimal)
        } else {
            KeyboardOptions.Default
        },
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun Banner(
    message: String,
    tone: androidx.compose.ui.graphics.Color,
    onDismiss: (() -> Unit)?,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(tone.copy(alpha = 0.10f), RoundedCornerShape(12.dp))
            .padding(Spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            message,
            style = MaterialTheme.typography.bodySmall,
            color = tone,
            modifier = Modifier.weight(1f),
        )
        onDismiss?.let { TextButton(onClick = it) { Text("Dismiss") } }
    }
}
