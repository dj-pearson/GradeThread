package com.gradethread.app.consignment

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.R
import com.gradethread.app.ui.theme.Spacing
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1372 AC1: pick a consignor on the item canvas.
 *
 * Its own small ViewModel rather than a parameter threaded down from the canvas:
 * the consignor list is a different data source with a different failure mode,
 * and folding it into the item's state would make a network hiccup look like an
 * item that failed to load.
 */
@HiltViewModel
class ConsignorPickerViewModel @Inject constructor(
    private val service: ConsignorProviding,
) : ViewModel() {

    data class State(
        val consignors: List<Consignor> = emptyList(),
        val loaded: Boolean = false,
        val failed: Boolean = false,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun load() {
        if (_state.value.loaded) return
        viewModelScope.launch {
            runCatching { service.list() }.fold(
                onSuccess = { _state.value = State(consignors = it, loaded = true) },
                // Loaded stays false so a later visit retries. The canvas shows
                // nothing rather than an empty picker that looks like the seller
                // has no consignors.
                onFailure = { _state.value = State(failed = true) },
            )
        }
    }

    fun byId(id: String?): Consignor? =
        id?.let { wanted -> _state.value.consignors.firstOrNull { it.id == wanted } }
}

/**
 * The picker row.
 *
 * Renders nothing at all when the seller has no consignors — an empty
 * "Consignor" section on every item page would be permanent clutter for the
 * majority who never consign anything.
 */
@Composable
fun ConsignorPickerSection(
    selectedId: String?,
    splitText: String,
    onSelect: (String?) -> Unit,
    viewModel: ConsignorPickerViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    LaunchedEffect(Unit) { viewModel.load() }

    if (state.consignors.isEmpty()) return

    Column(
        Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Text(stringResource(R.string.consignor_label), style = MaterialTheme.typography.titleSmall)
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(Spacing.xxs),
        ) {
            FilterChip(
                selected = selectedId == null,
                onClick = { onSelect(null) },
                label = { Text(stringResource(R.string.common_none)) },
            )
            state.consignors.forEach { consignor ->
                FilterChip(
                    selected = consignor.id == selectedId,
                    // Tapping the selected one clears it. Otherwise the only way
                    // to un-consign an item is to know that "None" is a chip.
                    onClick = {
                        onSelect(if (consignor.id == selectedId) null else consignor.id)
                    },
                    label = { Text(consignor.name) },
                )
            }
        }
        Text(
            splitHint(viewModel.byId(selectedId), splitText),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * WHICH hint the split field should show, and with what numbers.
 *
 * An empty override is not "no split" — it means the consignor's default
 * applies, and leaving that unsaid is how someone thinks a blank field means
 * they keep everything.
 *
 * Pure and unit-tested on the CHOICE, not on the wording: US-2368 moved the
 * sentences into strings.xml, and a test asserting English here would have been
 * the reason not to. [splitHint] resolves it.
 */
sealed interface SplitHint {
    /** No consignor selected — the item is the seller's own. */
    data object NotConsigned : SplitHint

    /** The field is empty, so the consignor's standing split applies. */
    data class UsingDefault(val name: String, val defaultPct: String) : SplitHint

    /** A one-off split for this item, named against the usual one. */
    data class Override(
        val name: String,
        val overridePct: String,
        val defaultPct: String,
    ) : SplitHint
}

fun splitHintFor(consignor: Consignor?, splitText: String): SplitHint {
    if (consignor == null) return SplitHint.NotConsigned
    val defaultPct = ConsignorDraft.formatPct(consignor.defaultSplitPct)
    val override = splitText.trim().toDoubleOrNull()
        ?: return SplitHint.UsingDefault(consignor.name, defaultPct)
    return SplitHint.Override(consignor.name, ConsignorDraft.formatPct(override), defaultPct)
}

/** The split hint in the reader's language. */
@Composable
fun splitHint(consignor: Consignor?, splitText: String): String =
    when (val hint = splitHintFor(consignor, splitText)) {
        SplitHint.NotConsigned -> stringResource(R.string.consignor_not_consigned)
        is SplitHint.UsingDefault ->
            stringResource(R.string.consignor_using_default, hint.name, hint.defaultPct)

        is SplitHint.Override -> stringResource(
            R.string.consignor_override,
            hint.name,
            hint.overridePct,
            hint.defaultPct,
        )
    }
