package com.gradethread.app.passport

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.AssistChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.ui.components.InfoCard
import com.gradethread.app.ui.components.InfoTone
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1376: an item's pedigree, hop by hop.
 */
@HiltViewModel
class PassportViewModel @Inject constructor(
    private val service: PassportProviding,
) : ViewModel() {

    data class State(
        val itemId: String = "",
        val loading: Boolean = false,
        val loaded: Boolean = false,
        val timeline: PassportTimeline? = null,
        /**
         * True when the item simply has no passport.
         *
         * Deliberately NOT an error: most of an inventory is ungraded, and a
         * red banner on the ordinary case would train people to ignore it.
         */
        val noPassport: Boolean = false,
        val errorMessage: String? = null,
    ) {
        val events: List<PassportEvent>
            get() = PassportFormat.ordered(timeline?.events.orEmpty())

        val strength: PassportChainStrength
            get() = PassportChainStrength.of(events.map { it.confidence })

        val garmentName: String
            get() = timeline?.let { PassportFormat.garmentName(it.skuClass) } ?: ""

        /** A passport exists but nothing has been recorded on it yet. */
        val emptyChain: Boolean get() = timeline != null && events.isEmpty()
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun load(itemId: String) {
        if (_state.value.itemId == itemId && _state.value.loading) return
        _state.value = State(itemId = itemId, loading = true)
        Telemetry.screen("passport")

        viewModelScope.launch {
            val slug = runCatching { service.resolveSlug(itemId) }.getOrNull()
            if (slug == null) {
                _state.value = _state.value.copy(
                    loading = false,
                    loaded = true,
                    noPassport = true,
                )
                return@launch
            }

            runCatching { service.timeline(slug) }.fold(
                onSuccess = { timeline ->
                    _state.value = _state.value.copy(
                        loading = false,
                        loaded = true,
                        timeline = timeline,
                    )
                },
                onFailure = { error ->
                    _state.value = _state.value.copy(
                        loading = false,
                        loaded = true,
                        errorMessage = (error as? EdgeApiError)?.userMessage()
                            ?: "Couldn't load this item's history.",
                    )
                },
            )
        }
    }
}

@Composable
fun PassportScreen(
    itemId: String,
    onClose: () -> Unit = {},
    viewModel: PassportViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    LaunchedEffect(itemId) { viewModel.load(itemId) }

    Column(
        Modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text("Item passport", style = MaterialTheme.typography.titleLarge)
        if (state.garmentName.isNotEmpty()) {
            Text(state.garmentName, style = MaterialTheme.typography.bodyLarge)
        }

        state.errorMessage?.let { InfoCard("That didn't work", it, tone = InfoTone.Error) }

        when {
            state.loading -> Text("Loading…", style = MaterialTheme.typography.bodyMedium)

            state.noPassport -> InfoCard(
                "No passport yet",
                // Says what creates one. "Nothing here" with no explanation is
                // the same screen as a bug.
                "A passport starts when an item is certified. Grade this one and its " +
                    "history begins.",
            )

            state.emptyChain -> InfoCard(
                "Nothing recorded yet",
                "This item has a passport, but no history has been added to it.",
            )
        }

        state.timeline?.let { timeline ->
            if (state.events.isNotEmpty()) {
                Column(
                    Modifier.fillMaxWidth().cardStyle(),
                    verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
                ) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            "Chain strength: ${state.strength.label}",
                            style = MaterialTheme.typography.titleMedium,
                            modifier = Modifier.weight(1f),
                        )
                    }
                    Text(state.strength.summary, style = MaterialTheme.typography.bodyMedium)
                    LinearProgressIndicator(
                        progress = { state.strength.score.toFloat() },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
            timeline.originVerifiedSeller?.let { seller ->
                Text(
                    "Originally from " +
                        (seller.displayName?.takeIf { it.isNotBlank() } ?: "@${seller.handle}") +
                        " (verified)",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        LazyColumn(
            Modifier.fillMaxWidth().weight(1f),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            // Keyed by the event's own identity plus its index, because two
            // hops can share a timestamp and the ledger has no row id here.
            items(
                count = state.events.size,
                key = { index -> "${state.events[index].key}|$index" },
            ) { index -> EventCard(state.events[index]) }
        }

        BrandSecondaryButton(text = "Back", modifier = Modifier.fillMaxWidth()) { onClose() }
    }
}

@Composable
private fun EventCard(event: PassportEvent) {
    val confidence = PassportConfidence.of(event.confidence)
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                PassportFormat.eventLabel(event.eventType),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.weight(1f),
            )
            AssistChip(onClick = {}, label = { Text(confidence.label) })
        }
        Text(
            PassportFormat.longDate(event.createdAt),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        PassportFormat.gradeLine(event)?.let {
            Text("Graded $it", style = MaterialTheme.typography.bodyMedium)
        }
        PassportFormat.actorLine(event)?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Text(
            // The basis, on every hop. A confidence badge without its reason is
            // a word someone has to take on faith.
            confidence.explanation,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
