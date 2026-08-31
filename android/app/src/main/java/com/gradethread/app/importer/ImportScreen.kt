package com.gradethread.app.importer

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import com.gradethread.app.money.Money
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.ui.text
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

    ImportContent(
        state,
        ImportActions(
            // The picker stays in the wrapper: it needs an Activity result
            // registry, which a screenshot test does not have.
            pickFile = { picker.launch(arrayOf("*/*")) },
            setSheetUrl = viewModel::setSheetUrl,
            loadFromSheet = viewModel::loadFromSheet,
            setMapping = viewModel::setMapping,
            preview = viewModel::preview,
            backToMapping = viewModel::backToMapping,
            commit = viewModel::commit,
            startOver = viewModel::startOver,
            done = onDone,
        ),
    )
}

/** Everything this screen can be asked to do (US-2902 AC3). */
@Immutable
data class ImportActions(
    val pickFile: () -> Unit = {},
    val setSheetUrl: (String) -> Unit = {},
    val loadFromSheet: () -> Unit = {},
    val setMapping: (Int, ImportField) -> Unit = { _, _ -> },
    val preview: () -> Unit = {},
    val backToMapping: () -> Unit = {},
    val commit: () -> Unit = {},
    val startOver: () -> Unit = {},
    val done: () -> Unit = {},
)

/**
 * The CSV importer with no ViewModel attached (US-2902 AC3).
 *
 * ⚠ FOUR STEPS, ONE SCREEN, AND THE ONLY THING THAT SAYS WHICH IS THE LAYOUT.
 * Pick, map, preview, done are the same Column with different children, so a
 * step that renders the wrong body is not a crash - it is a seller pressing
 * Import on a mapping they have not checked.
 *
 * ⚠ AND THE PREVIEW IS WHERE REJECTED ROWS GET NAMED. An import that quietly
 * dropped the rows it could not read would put a smaller inventory on screen
 * than the file held, with nothing saying which rows went missing. The failures
 * list is captured for that reason.
 */
@Composable
fun ImportContent(state: ImportViewModel.State, actions: ImportActions, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().padding(Spacing.md)) {
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
            ImportViewModel.Step.PICK -> PickStep(state, actions)
            ImportViewModel.Step.MAP -> MapStep(state, actions)
            ImportViewModel.Step.PREVIEW -> PreviewStep(state, actions)
            ImportViewModel.Step.DONE -> DoneStep(state, actions)
        }
    }
}

@Composable
private fun PickStep(state: ImportViewModel.State, actions: ImportActions) {
    Column(Modifier.fillMaxWidth().padding(top = Spacing.sm)) {
        Text(
            stringResource(R.string.import_intro),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        BrandPrimaryButton(
            text = stringResource(R.string.import_choose_file),
            modifier = Modifier.fillMaxWidth().padding(top = Spacing.md),
        ) { actions.pickFile() }

        // US-2410: the sheet goes to the server, which fetches it and hands
        // back CSV — from here on it is the same import as a picked file.
        Text(
            stringResource(R.string.import_sheet_header),
            style = MaterialTheme.typography.labelLarge,
            modifier = Modifier.padding(top = Spacing.md),
        )
        Text(
            stringResource(R.string.import_sheet_help),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedTextField(
            value = state.sheetUrl,
            onValueChange = actions.setSheetUrl,
            label = { Text(stringResource(R.string.import_sheet_link)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(top = Spacing.xs),
        )
        BrandSecondaryButton(
            text = stringResource(R.string.import_sheet_fetch),
            modifier = Modifier.fillMaxWidth().padding(top = Spacing.xs),
            enabled = state.canFetchSheet,
        ) { actions.loadFromSheet() }
    }
}

@Composable
private fun MapStep(state: ImportViewModel.State, actions: ImportActions) {
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
                it.text(),
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
                    onPick = { actions.setMapping(column, it) },
                )
            }
        }

        BrandPrimaryButton(
            text = stringResource(R.string.import_preview),
            modifier = Modifier.fillMaxWidth().padding(top = Spacing.sm),
            enabled = state.canPreview,
        ) { actions.preview() }
    }
}

@Composable
private fun ColumnRow(header: String, sample: String, field: ImportField, onPick: (ImportField) -> Unit) {
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
        TextButton(onClick = { open = 1 }) { Text(stringResource(field.label)) }
        DropdownMenu(expanded = open == 1, onDismissRequest = { open = 0 }) {
            ImportField.entries.forEach { option ->
                DropdownMenuItem(
                    text = { Text(stringResource(option.label)) },
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
private fun PreviewStep(state: ImportViewModel.State, actions: ImportActions) {
    val plan = state.plan ?: return
    Column(Modifier.fillMaxWidth()) {
        state.summary?.let {
            Text(it.text(), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
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
                                // Money.format, not the raw Double. Both strings
                                // take %1$s, so a Double landed as "cost 24.0"
                                // on the one screen where a seller is checking
                                // their own figures against a spreadsheet.
                                draft.acquiredPrice?.let {
                                    stringResource(R.string.import_cost, Money.format(it))
                                },
                                draft.targetPrice?.let {
                                    stringResource(R.string.import_list, Money.format(it))
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
                        rejection.reason.text(),
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
                actions.backToMapping()
            }
            BrandPrimaryButton(
                text = stringResource(R.string.import_commit, plan.ready.size),
                modifier = Modifier.weight(1f).padding(start = Spacing.xs),
                enabled = state.canCommit,
            ) { actions.commit() }
        }
    }
}

@Composable
private fun DoneStep(state: ImportViewModel.State, actions: ImportActions) {
    Column(Modifier.fillMaxWidth()) {
        state.outcome?.let {
            Text(it.text(), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
        }
        LazyColumn(Modifier.weight(1f)) {
            items(state.failures) { failure ->
                Text(
                    stringResource(
                        R.string.import_row_failed,
                        failure.sheetRow,
                        failure.reason.text(),
                    ),
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
                actions.startOver()
            }
            BrandPrimaryButton(
                text = stringResource(R.string.common_done),
                modifier = Modifier.weight(1f).padding(start = Spacing.xs),
            ) { actions.done() }
        }
    }
}
