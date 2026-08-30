package com.gradethread.app.money

import android.content.Context
import android.net.Uri
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * US-3000: photograph a receipt on the phone, which is where the receipt is.
 *
 * A receipt photographed on a phone and then uploaded from a computer is a step
 * most people skip, and the expense with it. This is the whole reason the story
 * exists on mobile at all.
 *
 * THE MODEL PROPOSES AND THE SELLER CONFIRMS. The scan opens the ordinary
 * expense form pre-filled -- it never writes a row. That is US-2993 AC1, kept
 * here rather than reinvented, and it matters more on a phone: a number the
 * seller glanced at on a small screen and never checked is worse than no number.
 */
@HiltViewModel
class ReceiptScanViewModel @Inject constructor(
    private val scans: ReceiptScanService,
    private val expenses: ExpenseRepository,
    @ApplicationContext private val context: Context,
) : ViewModel() {

    data class State(
        val scanning: Boolean = false,
        /** The form to show, pre-filled. Null until a scan produces one. */
        val draft: ExpenseDraft? = null,
        /** Where the photo is parked until an expense exists to attach it to. */
        val stagingPath: String? = null,
        /** Fields the model was unsure about, so the form can point at them. */
        val lowConfidence: List<String> = emptyList(),
        val notice: String? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun scan(uri: Uri) {
        if (_state.value.scanning) return
        _state.value = State(scanning = true)
        viewModelScope.launch {
            val bytes = withContext(Dispatchers.IO) { readBytes(uri) }
            if (bytes == null) {
                _state.value = State(notice = "Couldn't open that photo.")
                return@launch
            }
            if (bytes.size > MAX_BYTES) {
                // The server's cap. Failing here saves the seller a slow upload
                // that was always going to be rejected.
                _state.value = State(notice = "That photo is over 10MB. Try a smaller one.")
                return@launch
            }

            runCatching { scans.scan(bytes, mimeType(uri)) }.fold(
                onSuccess = { result ->
                    _state.value = if (result.readAnything) {
                        State(
                            draft = result.toDraft(),
                            stagingPath = result.stagingPath,
                            lowConfidence = result.lowConfidence,
                            notice = result.warning,
                        )
                    } else {
                        // A blurred photo, a crumpled receipt and a model that
                        // simply could not read it are the same outcome to the
                        // seller: type it in. "The AI failed" invites a retry
                        // that fails the same way. The form still opens, and the
                        // photo is still staged so it can be attached.
                        State(
                            draft = ExpenseDraft(spentOnMs = CalendarDateField.todayMs()),
                            stagingPath = result.stagingPath,
                            notice = "Couldn't read that one. Fill it in and the photo still attaches.",
                        )
                    }
                },
                onFailure = { error ->
                    _state.value = State(
                        notice = error.message ?: "Couldn't read that receipt.",
                    )
                },
            )
        }
    }

    /**
     * Save the confirmed expense, then attach the staged photo to it.
     *
     * IN THAT ORDER, and the attach is best-effort. An expense with no receipt
     * is a correct expense; a receipt with no expense is a file nobody will ever
     * find. Failing the save because the attach failed would lose the number the
     * seller just checked.
     */
    fun confirm(draft: ExpenseDraft, onSaved: () -> Unit) {
        val staging = _state.value.stagingPath
        viewModelScope.launch {
            when (val outcome = expenses.save(draft)) {
                is ExpenseRepository.Outcome.Failed ->
                    _state.value = _state.value.copy(notice = outcome.message)

                is ExpenseRepository.Outcome.Queued -> {
                    // Saved locally with no signal, so there is no expense on
                    // the server yet to attach to. The photo stays staged and
                    // the seller is told, rather than the attach failing
                    // silently and the receipt appearing to be lost.
                    _state.value = State(
                        notice = "Saved offline. Attach the photo once you're back online.",
                    )
                    onSaved()
                }

                is ExpenseRepository.Outcome.Saved -> {
                    var message = "Expense saved."
                    if (staging != null) {
                        runCatching { scans.adoptStaged(outcome.id, staging) }
                            .onFailure {
                                message = "Expense saved, but the photo didn't attach."
                            }
                    }
                    _state.value = State(notice = message)
                    onSaved()
                }
            }
        }
    }

    fun dismiss() {
        _state.value = State()
    }

    fun clearNotice() {
        _state.value = _state.value.copy(notice = null)
    }

    private fun readBytes(uri: Uri): ByteArray? = runCatching {
        context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
    }.getOrNull()

    private fun mimeType(uri: Uri): String = context.contentResolver.getType(uri) ?: "image/jpeg"

    companion object {
        /** Mirrors the route's cap and the bucket's file_size_limit. */
        const val MAX_BYTES = 10 * 1024 * 1024
    }
}

/**
 * The button, its picker and the form it opens.
 *
 * Self-contained like [TripQuickLogButton], so it can sit on any screen without
 * that screen knowing anything about receipts.
 */
@Composable
fun ReceiptScanButton(
    modifier: Modifier = Modifier,
    label: String = "Scan a receipt",
    viewModel: ReceiptScanViewModel = hiltViewModel(),
    onNotice: (String) -> Unit = {},
) {
    val state by viewModel.state.collectAsState()
    // Unused today, kept because a camera capture (rather than the picker)
    // needs a FileProvider URI built from it. Reading it here keeps that change
    // to one file.
    LocalContext.current

    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia(),
    ) { uri -> if (uri != null) viewModel.scan(uri) }

    ReceiptScanTrigger(
        label = label,
        scanning = state.scanning,
        modifier = modifier,
        onClick = {
            picker.launch(
                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
            )
        },
    )

    state.notice?.let { message ->
        onNotice(message)
        viewModel.clearNotice()
    }

    state.draft?.let { draft ->
        ExpenseFormSheet(
            initial = draft,
            onDismiss = { viewModel.dismiss() },
            onSave = { edited -> viewModel.confirm(edited) { viewModel.dismiss() } },
        )
    }
}

/**
 * The visible half of [ReceiptScanButton], with nothing behind it.
 *
 * ⚠ THIS EXISTS SO A GOLDEN CAN SHOW THE REAL WIDGET. MoneyContent takes the
 * scanner as a slot, because a Hilt-backed composable inside that body kills
 * any screenshot test that composes far enough down to reach it. A slot fed
 * with an empty lambda would leave the expenses row a button short of the
 * truth, and one hand-rolled TextButton in the test would be a second
 * definition of this widget that could drift from the first.
 */
@Composable
fun ReceiptScanTrigger(label: String, scanning: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    TextButton(onClick = onClick, enabled = !scanning, modifier = modifier) {
        Text(if (scanning) "Reading it" else label)
    }
}
