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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.text.KeyboardOptions
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.capture.FlipdeskCategory
import com.gradethread.app.marketplaces.CustomTabsLauncher
import com.gradethread.app.marketplaces.publish.PublishSheet
import com.gradethread.app.measure.MeasurementPhotoEditorSheet
import com.gradethread.app.marketplaces.QUEUED_NOTICE
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing

/**
 * Channels the desktop extension can run, as (id, label) pairs.
 *
 * Mirrors LISTER_EXTENSION_PLATFORMS in src/lib/lister-extension.ts. eBay and
 * Shopify are absent on purpose: they publish through a real API straight from
 * the phone, so queueing them for a browser would be a worse path than the
 * Publish button directly above.
 */
private val EXTENSION_QUEUE_CHANNELS = listOf(
    "poshmark" to "Poshmark",
    "mercari" to "Mercari",
    "grailed" to "Grailed",
    "vinted" to "Vinted",
    "facebook" to "Facebook",
)

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
    /** US-1376: the item's pedigree timeline. */
    onOpenPassport: (String) -> Unit = {},
    /** US-1344: a duplicate opens as its own canvas. */
    onOpenItem: (String) -> Unit,
    modifier: Modifier = Modifier,
    viewModel: ItemCanvasViewModel = hiltViewModel(),
) {
    LaunchedEffect(itemId) { viewModel.bind(itemId) }
    val state by viewModel.state.collectAsState()
    val context = LocalContext.current
    var publishing by remember { mutableStateOf(false) }
    var disclosing by remember { mutableStateOf(false) }
    var measuring by remember { mutableStateOf(false) }

    if (state.loading) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }
    if (state.notFound) {
        Column(Modifier.fillMaxSize().padding(Spacing.md)) {
            Text(stringResource(R.string.canvas_item_not_found), style = MaterialTheme.typography.titleMedium)
            Text(
                stringResource(R.string.canvas_may_have_been_deleted_hasn),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            BrandPrimaryButton(text = stringResource(R.string.canvas_back), modifier = Modifier.fillMaxWidth()) {
                onClose()
            }
        }
        return
    }

    // US-1360: the disclosure surface REPLACES the canvas rather than stacking
    // under it — it is a full screen, not a sheet.
    if (disclosing) {
        com.gradethread.app.disclosure.DisclosureScreen(
            itemId = itemId,
            onClose = { disclosing = false },
        )
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
                stringResource(R.string.canvas_saved_offline),
                MaterialTheme.colorScheme.onSurfaceVariant,
                null,
            )
        }

        SectionHeader(stringResource(R.string.canvas_item))
        Field(stringResource(R.string.canvas_field_title), draft.title) { v -> viewModel.edit { it.copy(title = v) } }
        if (draft.title.isBlank()) {
            Text(
                stringResource(R.string.canvas_title_required_save),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
        Field(stringResource(R.string.canvas_field_brand), draft.brand) { v -> viewModel.edit { it.copy(brand = v) } }
        Field(stringResource(R.string.canvas_field_sku), draft.sku) { v -> viewModel.edit { it.copy(sku = v) } }
        Field(stringResource(R.string.canvas_field_size), draft.size) { v -> viewModel.edit { it.copy(size = v) } }
        Field(stringResource(R.string.canvas_field_color), draft.color) { v -> viewModel.edit { it.copy(color = v) } }
        Field(stringResource(R.string.canvas_field_material), draft.material) { v ->
            viewModel.edit { it.copy(material = v) }
        }
        Field(stringResource(R.string.canvas_field_style), draft.style) { v -> viewModel.edit { it.copy(style = v) } }

        SectionHeader(stringResource(R.string.canvas_category))
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
                stringResource(R.string.canvas_no_category_set_pick_one),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (draft.showsGarmentFields) {
            Field(stringResource(R.string.canvas_field_garment_type), draft.garmentType) { v ->
                viewModel.edit { it.copy(garmentType = v) }
            }
            Field(stringResource(R.string.canvas_field_garment_category), draft.garmentCategory) { v ->
                viewModel.edit { it.copy(garmentCategory = v) }
            }
        }

        MeasurementsSection(
            measurements = draft.measurements,
            category = draft.category?.wire,
            onSet = viewModel::setMeasurement,
        )
        // US-1576: only offered when there is a MeasureCard shot to measure
        // from — see State.hasMeasurementPhoto.
        if (state.hasMeasurementPhoto) {
            BrandSecondaryButton(
                text = stringResource(R.string.measure_editor_open),
                modifier = Modifier.fillMaxWidth(),
            ) { measuring = true }
        }
        SizeEstimateCard(
            estimate = state.sizeEstimate,
            busy = state.estimatingSize,
            errorMessage = state.sizeErrorMessage,
            onEstimate = viewModel::estimateSize,
            onApply = viewModel::applyInferredSize,
            onDismiss = viewModel::dismissSizeEstimate,
        )

        SectionHeader(stringResource(R.string.canvas_pricing_sourcing))
        Field(stringResource(R.string.canvas_field_acquired_price), draft.acquiredPriceText, numeric = true) { v ->
            viewModel.edit { it.copy(acquiredPriceText = v) }
        }
        Field(stringResource(R.string.canvas_field_target_price), draft.targetPriceText, numeric = true) { v ->
            viewModel.edit { it.copy(targetPriceText = v) }
        }
        // US-2886: a roster pick, not a typed name, so the same person cannot
        // arrive as three spellings across three sessions.
        SourcedByPicker(
            label = stringResource(R.string.canvas_field_sourced_by),
            value = draft.sourcedBy,
            onValueChange = { v -> viewModel.edit { it.copy(sourcedBy = v) } },
            sourcers = SourcerRoster(state.sourcerRoster),
            onAddPerson = viewModel::addSourcer,
        )
        Field(stringResource(R.string.canvas_field_container), draft.container) { v ->
            viewModel.edit { it.copy(container = v) }
        }
        Field(stringResource(R.string.canvas_field_location_bin), draft.locationBin) { v ->
            viewModel.edit { it.copy(locationBin = v) }
        }
        // US-1372: the picker renders nothing when there are no consignors, so
        // the split field is only ever shown next to something that explains it.
        com.gradethread.app.consignment.ConsignorPickerSection(
            selectedId = draft.consignorId,
            splitText = draft.consignmentSplitText,
            onSelect = { id ->
                viewModel.edit {
                    // Clearing the consignor clears the override with it: a
                    // stray 70% left on an un-consigned item would silently
                    // apply again the moment someone re-assigned it.
                    if (id == null) {
                        it.copy(consignorId = null, consignmentSplitText = "")
                    } else {
                        it.copy(consignorId = id)
                    }
                }
            },
        )
        if (draft.consignorId != null) {
            Field(stringResource(R.string.canvas_field_split_pct), draft.consignmentSplitText, numeric = true) { v ->
                viewModel.edit { it.copy(consignmentSplitText = v) }
            }
        }

        CompsSection(
            state = state.comps,
            savedComps = draft.comps,
            onFetch = viewModel::fetchComps,
            onUseMedian = viewModel::useMedian,
            onAddComp = viewModel::addComp,
            onRemoveComp = viewModel::removeComp,
        )

        AspectsSection(
            spec = state.aspectSpec,
            values = draft.aspects,
            sources = draft.aspectSources,
            missingRequired = state.missingRequiredAspects,
            onLoad = viewModel::loadAspectSpec,
            onSet = viewModel::setAspect,
        )

        // US-2411: only once the category's specifics are on screen — before
        // that there is nothing for the model's answers to land in.
        if (state.aspectSpec is AspectSpecState.Loaded) {
            AiFillAspectsRow(state, viewModel)
        }

        SectionHeader(stringResource(R.string.canvas_notes))
        // US-2411: the copy is a PROPOSAL. It sits above the fields it would
        // replace so the seller can compare before accepting.
        ListingCopyCard(state, viewModel)
        Field(stringResource(R.string.canvas_field_description), draft.description, lines = 3) { v ->
            viewModel.edit { it.copy(description = v) }
        }
        Field(stringResource(R.string.canvas_field_condition_notes), draft.conditionNotes, lines = 3) { v ->
            viewModel.edit { it.copy(conditionNotes = v) }
        }

        HorizontalDivider(Modifier.padding(vertical = Spacing.xs))

        BrandPrimaryButton(
            text = when {
                state.saving -> stringResource(R.string.canvas_saving)
                state.isDirty -> stringResource(R.string.canvas_save_changes)
                else -> stringResource(R.string.canvas_saved)
            },
            enabled = state.canSave,
            modifier = Modifier.fillMaxWidth(),
        ) { viewModel.save() }

        if (state.isDirty) {
            TextButton(onClick = viewModel::discard, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.canvas_discard_changes))
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

        SectionHeader(stringResource(R.string.canvas_grading))
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            BrandSecondaryButton(text = stringResource(R.string.canvas_grade), modifier = Modifier.weight(1f)) {
                onGrade(itemId)
            }
            BrandSecondaryButton(text = stringResource(R.string.canvas_report), modifier = Modifier.weight(1f)) {
                onOpenReport(itemId)
            }
        }
        // US-1376: always offered, even for an ungraded item — the passport
        // screen explains that grading is what starts one, which is more use
        // than a button that isn't there.
        BrandSecondaryButton(text = stringResource(R.string.canvas_passport), modifier = Modifier.fillMaxWidth()) {
            onOpenPassport(itemId)
        }

        // US-1352: publish from the canvas, where the fields the listing is
        // built from already are. Disabled while there are unsaved edits — the
        // server publishes what's in the database, so publishing over a dirty
        // canvas would list the OLD values and look like the app ignored them.
        SectionHeader(stringResource(R.string.canvas_selling))
        BrandSecondaryButton(
            text = stringResource(
                if (state.isDirty) {
                    R.string.canvas_save_before_list
                } else {
                    R.string.publish_list_title
                },
            ),
            enabled = !state.isDirty,
            modifier = Modifier.fillMaxWidth(),
        ) { publishing = true }

        // US-2481: queue this cross-list for the desktop extension.
        //
        // Publish above goes through eBay's API and works from the phone.
        // Poshmark, Mercari, Grailed, Vinted and Facebook have no write API, so
        // the form has to be filled in a browser — which a seller standing in a
        // thrift store does not have open. This records the instruction; the
        // desktop runs it. The server never stores a marketplace credential.
        SectionHeader(stringResource(R.string.canvas_run_on_desktop))
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            EXTENSION_QUEUE_CHANNELS.forEach { channel ->
                FilterChip(
                    selected = state.queuedForDesktop == channel.first,
                    onClick = { viewModel.queueForDesktop(channel.first) },
                    label = { Text(channel.second) },
                )
            }
        }
        if (state.queuedForDesktop != null) {
            // The shared sentence, verbatim. It says the work is WAITING, never
            // that it is done — a seller told "listed" for a queued job believes
            // their item is live when it is not.
            Text(
                QUEUED_NOTICE,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (state.queueFailed) {
            Text(
                stringResource(R.string.canvas_queue_failed),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }

        // US-1360: the graded flaws, marked on the photo and pushed into the
        // live description.
        BrandSecondaryButton(
            text = stringResource(R.string.canvas_flaw_disclosure),
            modifier = Modifier.fillMaxWidth(),
        ) { disclosing = true }

        BrandSecondaryButton(text = stringResource(R.string.canvas_back), modifier = Modifier.fillMaxWidth()) {
            onClose()
        }
    }

    if (measuring) {
        MeasurementPhotoEditorSheet(
            itemId = itemId,
            // The numbers land in the DRAFT, not the row: the seller still sees
            // them in the fields and still presses Save, so a measurement they
            // disagree with can be changed before it reaches a listing.
            onApply = viewModel::applyMeasurements,
            onDismiss = { measuring = false },
        )
    }

    if (publishing) {
        PublishSheet(
            itemId = itemId,
            onDismiss = { publishing = false },
            onOpenListing = { url -> CustomTabsLauncher.open(context, url) },
        )
    }
}

/**
 * US-2411: ask the model to fill the specifics from the photos.
 *
 * The cost is named before the tap. One AI action is not free and the seller's
 * monthly allowance is the thing they run out of, so a button that spends one
 * without saying so is a button they learn not to trust.
 */
@Composable
private fun AiFillAspectsRow(state: ItemCanvasViewModel.State, viewModel: ItemCanvasViewModel) {
    Column(Modifier.fillMaxWidth()) {
        BrandSecondaryButton(
            text = if (state.fillingAspects) {
                stringResource(R.string.canvas_ai_aspects_running)
            } else {
                stringResource(R.string.canvas_ai_aspects)
            },
            modifier = Modifier.fillMaxWidth(),
            enabled = !state.fillingAspects,
        ) { viewModel.fillAspectsFromPhotos() }
        Text(
            stringResource(R.string.canvas_ai_one_action),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        state.aspectsFilled?.let { count ->
            Text(
                if (count == 0) {
                    stringResource(R.string.canvas_ai_aspects_none)
                } else {
                    pluralStringResource(R.plurals.canvas_ai_aspects_filled, count, count)
                },
                style = MaterialTheme.typography.bodySmall,
            )
        }
        state.aspectAiError?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            TextButton(onClick = viewModel::dismissAspectAi) {
                Text(stringResource(R.string.common_dismiss))
            }
        }
    }
}

/**
 * US-2411: the model's title and description, before they are accepted.
 *
 * Nothing reaches the fields until Use this is tapped. Overwriting a
 * description the seller already wrote, on a screen whose only undo is
 * retyping it, is not worth saving one tap.
 */
@Composable
private fun ListingCopyCard(state: ItemCanvasViewModel.State, viewModel: ItemCanvasViewModel) {
    val copy = state.listingCopy
    Column(Modifier.fillMaxWidth()) {
        if (copy == null) {
            BrandSecondaryButton(
                text = if (state.writingCopy) {
                    stringResource(R.string.canvas_ai_copy_running)
                } else {
                    stringResource(R.string.canvas_ai_copy)
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = !state.writingCopy,
            ) { viewModel.writeListingCopy() }
            Text(
                stringResource(R.string.canvas_ai_one_action),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else if (!copy.isUsable) {
            // An empty answer is a real answer. Applying it would erase copy
            // the seller already had.
            Text(
                stringResource(R.string.canvas_ai_copy_empty),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            TextButton(onClick = viewModel::dismissListingCopy) {
                Text(stringResource(R.string.common_dismiss))
            }
        } else {
            Text(copy.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
            Text(
                copy.description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row {
                TextButton(onClick = viewModel::applyListingCopy) {
                    Text(stringResource(R.string.canvas_ai_copy_use))
                }
                TextButton(onClick = viewModel::dismissListingCopy) {
                    Text(stringResource(R.string.common_dismiss))
                }
            }
        }
        state.listingCopyError?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            TextButton(onClick = viewModel::dismissListingCopy) {
                Text(stringResource(R.string.common_dismiss))
            }
        }
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
private fun Field(label: String, value: String, numeric: Boolean = false, lines: Int = 1, onChange: (String) -> Unit) {
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
private fun Banner(message: String, tone: androidx.compose.ui.graphics.Color, onDismiss: (() -> Unit)?) {
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
        onDismiss?.let { TextButton(onClick = it) { Text(stringResource(R.string.canvas_dismiss)) } }
    }
}
