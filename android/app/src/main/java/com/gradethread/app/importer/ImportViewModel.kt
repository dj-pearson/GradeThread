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
import javax.inject.Inject

/**
 * US-1389: the CSV import flow — pick a file, map the columns, preview, commit.
 */
@HiltViewModel
class ImportViewModel @Inject constructor(
    @ApplicationContext private val context: Context,
    private val service: ImportCommitting,
) : ViewModel() {

    enum class Step { PICK, MAP, PREVIEW, DONE }

    data class State(
        val step: Step = Step.PICK,
        val sheet: CsvParser.Sheet? = null,
        val mapping: List<ImportField> = emptyList(),
        val plan: ImportPlan? = null,
        val busy: Boolean = false,
        val error: String? = null,
        val outcome: String? = null,
        val failures: List<ImportRejection> = emptyList(),
    ) {
        val mappingError: String? get() = Importer.mappingError(mapping)
        val canPreview: Boolean get() = sheet != null && mappingError == null && !busy
        val canCommit: Boolean get() = (plan?.ready?.isNotEmpty() == true) && !busy
        val summary: String? get() = plan?.let(Importer::summary)
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
            val sheet = CsvParser.parseSheet(text)
            if (sheet.headers.isEmpty() || sheet.rows.isEmpty()) {
                _state.value = _state.value.copy(
                    busy = false,
                    // Named separately from an unreadable file: a header-only
                    // export is a different mistake with a different fix.
                    error = "That file has no rows under its header.",
                )
                return@launch
            }
            Telemetry.event("import_file_loaded", mapOf("rows" to sheet.rows.size))
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
