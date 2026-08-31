package com.gradethread.app.importer

import android.content.Context
import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.platform.telemetry.Telemetry
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import com.gradethread.app.ui.UiMessage
import javax.inject.Inject

/**
 * US-1389: the CSV import flow — pick a file, map the columns, preview, commit.
 */
@HiltViewModel
class ImportViewModel @Inject constructor(
    @ApplicationContext private val context: Context,
    private val service: ImportCommitting,
    /** US-2410: the Google Sheets side. Local file import does not touch it. */
    private val sheets: SheetsImporting,
) : ViewModel() {

    enum class Step { PICK, MAP, PREVIEW, DONE }

    data class State(
        val step: Step = Step.PICK,
        val sheet: CsvParser.Sheet? = null,
        val mapping: List<ImportField> = emptyList(),
        val plan: ImportPlan? = null,
        val busy: Boolean = false,
        val error: String? = null,
        val outcome: UiMessage? = null,
        val failures: List<ImportRejection> = emptyList(),
        /** US-2410: the sheet link the seller is typing. */
        val sheetUrl: String = "",
    ) {
        val canFetchSheet: Boolean get() = sheetUrl.isNotBlank() && !busy
        val mappingError: UiMessage? get() = Importer.mappingError(mapping)
        val canPreview: Boolean get() = sheet != null && mappingError == null && !busy
        val canCommit: Boolean get() = (plan?.ready?.isNotEmpty() == true) && !busy
        val summary: UiMessage? get() = plan?.let(Importer::summary)
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /**
     * Read the picked file.
     *
     * The whole file is read into memory on purpose: an inventory export is
     * kilobytes, and streaming would buy nothing while making the quoted-newline
     * handling much harder to get right.
     */
    fun load(uri: Uri) {
        _state.value = _state.value.copy(busy = true, error = null)
        viewModelScope.launch {
            val text = withContext(Dispatchers.IO) {
                runCatching {
                    context.contentResolver.openInputStream(uri)?.use { input ->
                        input.readBytes().toString(Charsets.UTF_8)
                    }
                }.getOrNull()
            }
            if (text.isNullOrBlank()) {
                _state.value = _state.value.copy(
                    busy = false,
                    error = "We couldn't read that file. Export it again as CSV and retry.",
                )
                return@launch
            }
            adopt(text, "import_file_loaded")
        }
    }

    /**
     * Parse CSV text and move to the mapping step.
     *
     * The single entry point for both front doors — a local file and a fetched
     * sheet arrive here as the same string.
     */
    private fun adopt(text: String, telemetryEvent: String) {
        val sheet = CsvParser.parseSheet(text)
        if (sheet.headers.isEmpty() || sheet.rows.isEmpty()) {
            _state.value = _state.value.copy(
                busy = false,
                // Named separately from an unreadable file: a header-only
                // export is a different mistake with a different fix.
                error = "That file has no rows under its header.",
            )
            return
        }
        Telemetry.event(telemetryEvent, mapOf("rows" to sheet.rows.size))
        _state.value = _state.value.copy(
            busy = false,
            step = Step.MAP,
            sheet = sheet,
            mapping = Importer.guessMapping(sheet.headers),
            plan = null,
            outcome = null,
            failures = emptyList(),
        )
    }

    fun setSheetUrl(value: String) {
        _state.value = _state.value.copy(sheetUrl = value, error = null)
    }

    /**
     * US-2410: pull a Google Sheet and hand it to the same pipeline.
     *
     * It converges on [adopt] the moment the CSV arrives, which is what keeps
     * the promise that local import is unchanged: column guessing, the mapping
     * screen, the preview and the duplicate rule are one code path with two
     * front doors, not two importers that drift.
     */
    fun loadFromSheet() {
        if (!_state.value.canFetchSheet) return
        val url = _state.value.sheetUrl
        _state.value = _state.value.copy(busy = true, error = null)
        viewModelScope.launch {
            val csv = runCatching { sheets.fetchCsv(url) }
                .onFailure { error ->
                    // Verbatim. A sheet that is not shared comes back naming
                    // the exact setting to change, and nothing here could
                    // work that out.
                    _state.value = _state.value.copy(
                        busy = false,
                        error = SheetsImportService.message(error),
                    )
                }
                .getOrNull() ?: return@launch
            adopt(csv, "import_sheet_loaded")
        }
    }

    fun setMapping(column: Int, field: ImportField) {
        val current = _state.value.mapping.toMutableList()
        if (column !in current.indices) return
        // Each field maps once. Assigning "Title" to a second column silently
        // orphans the first, so the old one is cleared where the seller can see.
        if (field != ImportField.SKIP) {
            current.forEachIndexed { i, existing ->
                if (i != column && existing == field) current[i] = ImportField.SKIP
            }
        }
        current[column] = field
        _state.value = _state.value.copy(mapping = current)
    }

    fun preview() {
        val sheet = _state.value.sheet ?: return
        if (!_state.value.canPreview) return
        _state.value = _state.value.copy(busy = true)
        viewModelScope.launch {
            val plan = Importer.plan(sheet, _state.value.mapping, service.existingSkus())
            _state.value = _state.value.copy(busy = false, step = Step.PREVIEW, plan = plan)
        }
    }

    fun backToMapping() {
        _state.value = _state.value.copy(step = Step.MAP, plan = null)
    }

    fun commit() {
        val plan = _state.value.plan ?: return
        if (!_state.value.canCommit) return
        _state.value = _state.value.copy(busy = true)
        viewModelScope.launch {
            val result = service.commit(plan.ready)
            _state.value = _state.value.copy(
                busy = false,
                step = Step.DONE,
                failures = result.failures,
                outcome = Importer.outcome(
                    // Queued rows are neither imported yet nor failed; they get
                    // their own count so the total still adds up.
                    inserted = plan.ready.size - result.failures.size - result.queued.size,
                    skipped = plan.duplicates.size,
                    queued = result.queued.size,
                    failed = result.failures.size,
                ),
            )
        }
    }

    fun startOver() {
        _state.value = State()
    }
}
