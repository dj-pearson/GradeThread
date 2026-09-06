package com.gradethread.app.money

import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage
import com.gradethread.app.ui.text
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * US-3000 AC4: logging a trip is TWO TAPS from the screen a seller is on when
 * they arrive at a store.
 *
 * "A feature that takes longer than the trip is a feature nobody uses" is the
 * whole acceptance criterion, and it rules out the obvious shape -- navigate to
 * Money, scroll to Mileage, tap add. This is a button plus a sheet that carries
 * its own state, so it can be dropped onto any screen without that screen
 * knowing anything about mileage: tap the button, tap Save.
 *
 * It owns a ViewModel rather than taking a callback because the alternative is
 * threading a repository through every host screen's constructor, and the first
 * host that forgot would fail at injection rather than at compile time.
 */
@HiltViewModel
class TripQuickLogViewModel @Inject constructor(private val mileage: MileageRepository) : ViewModel() {

    private val _notice = MutableStateFlow<UiMessage?>(null)
    val notice: StateFlow<UiMessage?> = _notice.asStateFlow()

    fun save(draft: TripDraft, onSaved: () -> Unit) {
        viewModelScope.launch {
            when (val outcome = mileage.save(draft)) {
                is MileageRepository.Outcome.Saved -> {
                    _notice.value = UiMessage(R.string.money_trip_logged)
                    onSaved()
                }
                is MileageRepository.Outcome.Queued -> {
                    // The expected outcome in a thrift-store car park, not the
                    // exceptional one. Saying "failed" here would send a seller
                    // away to re-enter a trip that is already recorded.
                    _notice.value = UiMessage(R.string.money_logged_offline)
                    onSaved()
                }
                is MileageRepository.Outcome.Failed ->
                    _notice.value = UiMessage(outcome.messageRes, outcome.detail)
            }
        }
    }

    fun clearNotice() {
        _notice.value = null
    }
}

/**
 * The button and its sheet.
 *
 * @param sourceId attributes the drive to a sourcing trip when the host screen
 *   knows which one. Optional, because a seller standing outside a shop they
 *   have not recorded yet must still be able to log the miles.
 */
@Composable
fun TripQuickLogButton(
    modifier: Modifier = Modifier,
    /** Empty means the default caption; a host can override it. */
    label: String = "",
    sourceId: String? = null,
    snackbarHostState: SnackbarHostState? = null,
    viewModel: TripQuickLogViewModel = hiltViewModel(),
) {
    var draft by remember { mutableStateOf<TripDraft?>(null) }
    val notice by viewModel.notice.collectAsState()

    // Resolved outside the effect: showSnackbar is suspend and not composable,
    // so the sentence has to be built while a Context is still in scope.
    val noticeText = notice?.text()

    LaunchedEffect(noticeText) {
        val message = noticeText ?: return@LaunchedEffect
        snackbarHostState?.showSnackbar(message)
        viewModel.clearNotice()
    }

    TextButton(onClick = { draft = TripDraft.today(sourceId) }, modifier = modifier) {
        Text(label.ifEmpty { stringResource(R.string.money_log_a_trip) })
    }

    draft?.let { current ->
        TripFormSheet(
            initial = current,
            onDismiss = { draft = null },
            onSave = { edited -> viewModel.save(edited) { draft = null } },
        )
    }
}
