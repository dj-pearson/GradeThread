package com.gradethread.app.autolister

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
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
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
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

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
    var scheduling by remember { mutableStateOf<DraftListing?>(null) }

    LaunchedEffect(Unit) { viewModel.loadDrafts() }

    Column(
        Modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(stringResource(R.string.drafts_draft_listings), style = MaterialTheme.typography.titleLarge)

        state.errorMessage?.let { InfoCard(stringResource(R.string.drafts_that_didn_t_work), it, tone = InfoTone.Error) }
        state.banner?.let { InfoCard(stringResource(R.string.drafts_done), it, tone = InfoTone.Success) }

        state.batch?.let { batch -> BatchPanel(batch, state, viewModel) }

        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                stringResource(
                    R.string.drafts_selected_of,
                    state.selected.size,
                    state.drafts.size,
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = viewModel::toggleAll) {
                Text(
                    stringResource(
                        if (state.allSelected) {
                            R.string.drafts_clear_all
                        } else {
                            R.string.drafts_select_all
                        },
                    ),
                )
            }
        }

        when {
            state.loading -> Hint(stringResource(R.string.drafts_loading))
            state.drafts.isEmpty() -> Hint(
                stringResource(R.string.drafts_empty),
            )

            else -> LazyColumn(
                Modifier.fillMaxWidth().weight(1f),
                verticalArrangement = Arrangement.spacedBy(Spacing.sm),
            ) {
                items(ScheduledDrops.ordered(state.drafts), key = { it.id }) { draft ->
                    DraftCard(
                        draft = draft,
                        selected = draft.id in state.selected,
                        busy = state.busy,
                        onToggle = { viewModel.toggle(draft.id) },
                        onEdit = { editing = draft },
                        onDelete = { viewModel.deleteDraft(draft) },
                        onSchedule = { scheduling = draft },
                        onClearSchedule = { viewModel.clearSchedule(draft) },
                        onOtherPlatforms = { viewModel.loadPlatformFields(draft.inventoryItemId) },
                    )
                }
            }
        }

        if (state.selected.isNotEmpty()) {
            BrandPrimaryButton(
                text = stringResource(R.string.drafts_edit_together, state.selected.size),
                enabled = !state.busy,
                modifier = Modifier.fillMaxWidth(),
            ) { bulkOpen = true }
        }

        BrandSecondaryButton(text = stringResource(R.string.drafts_back), modifier = Modifier.fillMaxWidth()) { onClose() }
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

    // US-2408: the same draft as every other marketplace would take it,
    // filled by the server.
    state.platformFields?.let { fields ->
        PlatformFieldsDialog(fields = fields, onDismiss = viewModel::dismissPlatformFields)
    }

    scheduling?.let { draft ->
        ScheduleDialog(
            draft = draft,
            busy = state.busy,
            onDismiss = { scheduling = null },
            onSchedule = { date, time ->
                viewModel.schedule(draft, date, time)
                scheduling = null
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
                text = stringResource(R.string.drafts_resume),
                enabled = !state.busy,
                modifier = Modifier.fillMaxWidth(),
            ) { viewModel.resume() }
        }
        if (state.failedJobs.isNotEmpty()) {
            val bulletPrefix = stringResource(R.string.drafts_bullet_prefix)
            Text(
                state.failedJobs.mapNotNull { it.error }.distinct().take(3)
                    .joinToString("\n") { bulletPrefix + it },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (state.canRetry) {
            BrandSecondaryButton(
                text = stringResource(R.string.drafts_retry_failed, batch.failedCount),
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
    onSchedule: () -> Unit = {},
    onClearSchedule: () -> Unit = {},
    onOtherPlatforms: () -> Unit = {},
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
                    stringResource(R.string.drafts_estimated),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        draft.publishError?.takeIf { it.isNotBlank() }?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }
        // US-1361: the schedule, in the seller's own timezone. A time already
        // past is named as still-coming rather than shown as a normal future
        // drop — the cron simply hasn't reached it yet.
        draft.scheduledPublishAt?.let {
            Text(
                ScheduledDrops.statusLine(it, ZoneId.systemDefault(), Instant.now()),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Row {
            TextButton(onClick = onEdit, enabled = !busy) { Text(stringResource(R.string.drafts_edit)) }
            TextButton(onClick = onSchedule, enabled = !busy) {
                Text(
                    stringResource(
                        if (draft.scheduledPublishAt == null) {
                            R.string.drafts_schedule
                        } else {
                            R.string.drafts_reschedule
                        },
                    ),
                )
            }
            if (draft.scheduledPublishAt != null) {
                TextButton(onClick = onClearSchedule, enabled = !busy) { Text(stringResource(R.string.drafts_unschedule)) }
            }
            TextButton(onClick = onOtherPlatforms, enabled = !busy) {
                Text(stringResource(R.string.drafts_other_platforms))
            }
            TextButton(onClick = onDelete, enabled = !busy) {
                Text(stringResource(R.string.drafts_delete), color = MaterialTheme.colorScheme.error)
            }
        }
    }
}

/**
 * US-2408: one draft, as each marketplace would take it.
 *
 * Read-only on purpose. These fields are the server's answer for a listing
 * that has not been created yet, and the place to change them is the
 * marketplace's own draft once it exists — an edit here would look saved and
 * would not be.
 */
@Composable
private fun PlatformFieldsDialog(fields: PlatformFieldsResponse, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.drafts_other_platforms)) },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(Spacing.xs),
            ) {
                if (fields.variants.isEmpty()) {
                    Text(stringResource(R.string.drafts_no_platform_fields))
                }
                for (variant in fields.variants) {
                    Text(
                        variant.spec?.label?.ifBlank { variant.platform } ?: variant.platform,
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(variant.title, style = MaterialTheme.typography.bodyMedium)
                    Text(
                        stringResource(
                            R.string.drafts_platform_summary,
                            Money.format(variant.price),
                            variant.category.ifBlank { variant.platform },
                        ),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    // The blockers the marketplace itself would raise. Shown
                    // before a publish rather than after one is refused.
                    for (issue in variant.validation?.issues.orEmpty()) {
                        Text(
                            issue.message,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.drafts_cancel)) }
        },
    )
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
        title = { Text(stringResource(R.string.drafts_edit_draft)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    label = { Text(stringResource(R.string.drafts_title)) },
                )
                OutlinedTextField(
                    value = description,
                    onValueChange = { description = it },
                    label = { Text(stringResource(R.string.drafts_description)) },
                    minLines = 3,
                )
                OutlinedTextField(
                    value = price,
                    onValueChange = { price = it },
                    label = { Text(stringResource(R.string.drafts_price)) },
                    prefix = { Text(stringResource(R.string.drafts_currency_prefix)) },
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
            ) { Text(stringResource(R.string.drafts_save)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.drafts_cancel)) } },
    )
}

@Composable
private fun BulkEditDialog(
    state: AutolisterViewModel.State,
    onDismiss: () -> Unit,
    onPrice: (DraftBulk.PriceChange) -> Unit,
    onText: (String?, String?) -> Unit,
) {
    var mode by remember { mutableStateOf(DraftBulk.DEFAULT_BULK_EDIT_MODE) }
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
        title = { Text(stringResource(R.string.drafts_bulk_title, state.selected.size)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
                    // Driven off DraftBulk.BULK_EDIT_MODES so the chips and the
                    // opening mode can't drift apart again (US-2370).
                    DraftBulk.BULK_EDIT_MODES.forEach { key ->
                        val label = when (key) {
                            "percent" -> stringResource(R.string.drafts_mode_percent)
                            "round99" -> stringResource(R.string.drafts_mode_round99)
                            "title" -> stringResource(R.string.drafts_mode_title)
                            else -> stringResource(R.string.drafts_mode_set)
                        }
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
                        label = { Text(stringResource(R.string.drafts_new_price)) },
                        prefix = { Text(stringResource(R.string.drafts_currency_prefix)) },
                        singleLine = true,
                    )

                    "percent" -> OutlinedTextField(
                        value = percentText,
                        onValueChange = { percentText = it },
                        label = { Text(stringResource(R.string.drafts_change_by_use_10_cut)) },
                        suffix = { Text(stringResource(R.string.drafts_text)) },
                        singleLine = true,
                    )

                    "title" -> OutlinedTextField(
                        value = titleText,
                        onValueChange = { titleText = it },
                        label = { Text(stringResource(R.string.drafts_title_all_them)) },
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
            ) { Text(stringResource(R.string.drafts_apply)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.drafts_cancel)) } },
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

/**
 * US-1361: pick a local date and time for the drop.
 *
 * Plain text fields rather than platform pickers: the value is typed as ISO
 * date and 24-hour time, parsed with java.time, and anything unparseable
 * refuses rather than guessing at a date. The note under it says what will
 * ACTUALLY happen — the clocks changing, or a time already gone.
 */
@Composable
private fun ScheduleDialog(
    draft: DraftListing,
    busy: Boolean,
    onDismiss: () -> Unit,
    onSchedule: (LocalDate, LocalTime) -> Unit,
) {
    val zone = ZoneId.systemDefault()
    val existing = remember(draft.id) {
        ScheduledDrops.toLocal(draft.scheduledPublishAt, zone)
    }
    var dateText by remember(draft.id) {
        mutableStateOf((existing?.toLocalDate() ?: LocalDate.now(zone).plusDays(1)).toString())
    }
    var timeText by remember(draft.id) {
        mutableStateOf((existing?.toLocalTime()?.withSecond(0)?.withNano(0) ?: LocalTime.of(19, 0)).toString())
    }

    val date = runCatching { LocalDate.parse(dateText.trim()) }.getOrNull()
    val time = runCatching { LocalTime.parse(timeText.trim()) }.getOrNull()
    val note = if (date != null && time != null) {
        ScheduledDrops.scheduleNote(date, time, zone)
            ?: if (ScheduledDrops.isDue(ScheduledDrops.toInstant(date, time, zone), Instant.now())) {
                ScheduledDrops.PAST_TIME_NOTE
            } else {
                null
            }
    } else {
        null
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.drafts_schedule_this_drop)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                OutlinedTextField(
                    value = dateText,
                    onValueChange = { dateText = it },
                    label = { Text(stringResource(R.string.drafts_date_yyyy_mm_dd)) },
                    singleLine = true,
                )
                OutlinedTextField(
                    value = timeText,
                    onValueChange = { timeText = it },
                    label = { Text(stringResource(R.string.drafts_time_hh_mm)) },
                    singleLine = true,
                )
                Text(
                    stringResource(R.string.drafts_timezone_note, zone.id),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (dateText.isNotBlank() && date == null) {
                    Text(
                        stringResource(R.string.drafts_that_date_doesn_t_parse),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
                if (timeText.isNotBlank() && time == null) {
                    Text(
                        stringResource(R.string.drafts_that_time_doesn_t_parse),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
                note?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = date != null && time != null && !busy,
                onClick = { onSchedule(date!!, time!!) },
            ) { Text(stringResource(R.string.drafts_schedule)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.drafts_cancel)) } },
    )
}
