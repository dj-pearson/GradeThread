package com.gradethread.app.importer

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-1389: CSV import — pick, map, preview, commit.
 *
 * The preview step is the point of the whole flow. A migration writes hundreds
 * of rows that are then tedious to undo, so nothing is inserted until the
 * seller has seen what the mapping actually produced.
 */
@Composable
fun ImportScreen(onDone: () -> Unit, viewModel: ImportViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()

    // Any MIME type: Drive, Files and the various "Sheets export" apps all
    // report CSV differently, and a strict filter hides the file people picked.
    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri -> uri?.let(viewModel::load) }

    Column(Modifier.fillMaxSize().padding(Spacing.md)) {
        Text(
            stringResource(R.string.import_title),
            style = MaterialTheme.typography.headlineMedium,
        )

        if (state.busy) {
            LinearProgressIndicator(Modifier.fillMaxWidth().padding(vertical = Spacing.xs))
        }
        state.error?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(vertical = Spacing.xs),
            )
        }

        when (state.step) {
            ImportViewModel.Step.PICK -> PickStep { picker.launch(arrayOf("*/*")) }
            ImportViewModel.Step.MAP -> MapStep(state, viewModel)
            ImportViewModel.Step.PREVIEW -> PreviewStep(state, viewModel)
            ImportViewModel.Step.DONE -> DoneStep(state, viewModel, onDone)
        }
    }
}

@Composable
private fun PickStep(onPick: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(top = Spacing.sm)) {
        Text(
            stringResource(R.string.import_intro),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        BrandPrimaryButton(
            text = stringResource(R.string.import_choose_file),
            modifier = Modifier.fillMaxWidth().padding(top = Spacing.md),
        ) { onPick() }
    }
}

@Composable
private fun MapStep(state: ImportViewModel.State, viewModel: ImportViewModel) {
    val sheet = state.sheet ?: return
    Column(Modifier.fillMaxWidth()) {
        Text(
            // A plural resource, not a template: "1 rows" is what a Kotlin
            // template produces, and every language past English has more than
            // two forms.
            pluralStringResource(R.plurals.rows_found, sheet.rows.size, sheet.rows.size),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(vertical = Spacing.xs),
        )
        state.mappingError?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }

        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            items(sheet.headers.size) { column ->
                ColumnRow(
                    header = sheet.headers[column],
                    // The first row's value, so the seller is mapping against
                    // real data rather than a header they may have forgotten.
                    sample = sheet.rows.firstOrNull()?.getOrNull(column).orEmpty(),
                    field = state.mapping.getOrElse(column) { ImportField.SKIP },
                    onPick = { viewModel.setMapping(column, it) },
                )
            }
        }

        BrandPrimaryButton(
            text = stringResource(R.string.import_preview),
            modifier = Modifier.fillMaxWidth().padding(top = Spacing.sm),
            enabled = state.canPreview,
        ) { viewModel.preview() }
    }
}

@Composable
private fun ColumnRow(
    header: String,
    sample: String,
    field: ImportField,
    onPick: (ImportField) -> Unit,
) {
    var open by remember { mutableIntStateOf(0) }
    Column(Modifier.fillMaxWidth().cardStyle()) {
        Text(
            header.ifBlank { stringResource(R.string.import_unnamed_column) },
            fontWeight = FontWeight.Medium,
        )
        if (sample.isNotBlank()) {
            Text(
                sample,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        TextButton(onClick = { open = 1 }) { Text(field.label) }
        DropdownMenu(expanded = open == 1, onDismissRequest = { open = 0 }) {
            ImportField.entries.forEach { option ->
                DropdownMenuItem(
                    text = { Text(option.label) },
                    onClick = {
                        onPick(option)
                        open = 0
                    },
                )
            }
        }
    }
}

@Composable
private fun PreviewStep(state: ImportViewModel.State, viewModel: ImportViewModel) {
    val plan = state.plan ?: return
    Column(Modifier.fillMaxWidth()) {
        state.summary?.let {
            Text(it, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
        }

        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            items(plan.ready.take(Importer.PREVIEW_ROWS)) { draft ->
                Column(Modifier.fillMaxWidth().cardStyle()) {
                    Text(
                        stringResource(R.string.import_row_preview, draft.sheetRow, draft.title),
                        fontWeight = FontWeight.Medium,
                    )
                    Row(Modifier.horizontalScroll(rememberScrollState())) {
                        Text(
                            listOfNotNull(
                                draft.sku?.let { stringResource(R.string.import_sku, it) },
                                draft.brand,
                                draft.size,
                                draft.acquiredPrice?.let {
                                    stringResource(R.string.import_cost, it)
                                },
                                draft.targetPrice?.let {
                                    stringResource(R.string.import_list, it)
                                },
                                draft.status,
                            ).joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            // Skipped rows are shown, not summarised away: "12 skipped" without
            // saying WHICH twelve is not something a seller can act on.
            items(plan.duplicates + plan.rejected) { rejection ->
                Text(
                    stringResource(
                        R.string.import_row_skipped,
                        rejection.sheetRow,
                        rejection.reason,
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = Spacing.xs),
                )
            }
        }

        Row(Modifier.fillMaxWidth().padding(top = Spacing.sm)) {
            BrandSecondaryButton(
                text = stringResource(R.string.common_back),
                modifier = Modifier.width(120.dp),
            ) {
                viewModel.backToMapping()
            }
            BrandPrimaryButton(
                text = stringResource(R.string.import_commit, plan.ready.size),
                modifier = Modifier.weight(1f).padding(start = Spacing.xs),
                enabled = state.canCommit,
            ) { viewModel.commit() }
        }
    }
}

@Composable
private fun DoneStep(
    state: ImportViewModel.State,
    viewModel: ImportViewModel,
    onDone: () -> Unit,
) {
    Column(Modifier.fillMaxWidth()) {
        state.outcome?.let {
            Text(it, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
        }
        LazyColumn(Modifier.weight(1f)) {
            items(state.failures) { failure ->
                Text(
                    stringResource(R.string.import_row_failed, failure.sheetRow, failure.reason),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(vertical = 2.dp),
                )
            }
        }
        Row(Modifier.fillMaxWidth()) {
            BrandSecondaryButton(
                text = stringResource(R.string.import_another),
                modifier = Modifier.weight(1f),
            ) {
                viewModel.startOver()
            }
            BrandPrimaryButton(
                text = stringResource(R.string.common_done),
                modifier = Modifier.weight(1f).padding(start = Spacing.xs),
            ) { onDone() }
        }
    }
}
