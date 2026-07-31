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
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
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
        Text("Consignor", style = MaterialTheme.typography.titleSmall)
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(Spacing.xxs),
        ) {
            FilterChip(
                selected = selectedId == null,
                onClick = { onSelect(null) },
                label = { Text("None") },
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
 * What the split field is actually going to do, in words.
 *
 * An empty override is not "no split" — it means the consignor's default
 * applies, and leaving that unsaid is how someone thinks a blank field means
 * they keep everything.
 */
fun splitHint(consignor: Consignor?, splitText: String): String {
    if (consignor == null) return "Not consigned. This item is yours."
    val override = splitText.trim().toDoubleOrNull()
    return if (override == null) {
        "Using ${consignor.name}'s default of " +
            "${ConsignorDraft.formatPct(consignor.defaultSplitPct)}%."
    } else {
        "${consignor.name} gets ${ConsignorDraft.formatPct(override)}% of this one, " +
            "instead of their usual ${ConsignorDraft.formatPct(consignor.defaultSplitPct)}%."
    }
}
