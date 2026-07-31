package com.gradethread.app.fulfillment

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.money.Money
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.sync.SyncTrigger
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.ui.components.InfoCard
import com.gradethread.app.ui.components.InfoTone
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1377: the shipping queue.
 *
 * Room-backed, so it works in the corner of the room where the parcels are and
 * the signal isn't. Marking shipped stamps the local row immediately and queues
 * the write when there's no connection (AC3).
 */
@HiltViewModel
class FulfillmentViewModel @Inject constructor(
    db: GradeThreadDb,
    private val service: FulfillmentService,
    private val syncTrigger: SyncTrigger,
) : ViewModel() {

    data class State(
        val queue: List<FulfillmentOrder> = emptyList(),
        val shipped: List<FulfillmentOrder> = emptyList(),
        val nowMs: Long = 0L,
        val busyId: String? = null,
        val banner: String? = null,
        val errorMessage: String? = null,
        val refreshing: Boolean = false,
    ) {
        val summary: String get() = Fulfillment.summary(queue, nowMs)
        val labelCost: Double get() = Fulfillment.totalLabelCost(queue)
    }

    private val busyId = MutableStateFlow<String?>(null)
    private val banner = MutableStateFlow<String?>(null)
    private val error = MutableStateFlow<String?>(null)
    private val refreshing = MutableStateFlow(false)

    /** Per-order tracking text, so two rows can't share one field. */
    private val _tracking = MutableStateFlow<Map<String, String>>(emptyMap())
    val tracking: StateFlow<Map<String, String>> = _tracking.asStateFlow()

    val state: StateFlow<State> = combine(
        db.sales().observeAll(),
        db.items().observeAll(),
        busyId,
        banner,
        combine(error, refreshing) { e, r -> e to r },
    ) { sales, items, busy, message, (errorMessage, isRefreshing) ->
        // Stamped once per recomputation so every row's "days waiting" is
        // measured against the same instant.
        val nowMs = System.currentTimeMillis()
        State(
            queue = Fulfillment.queue(sales, items),
            shipped = Fulfillment.shipped(sales, items),
            nowMs = nowMs,
            busyId = busy,
            banner = message,
            errorMessage = errorMessage,
            refreshing = isRefreshing,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), State())

    fun setTracking(saleId: String, value: String) {
        _tracking.value = _tracking.value + (saleId to value)
    }

    fun markShipped(order: FulfillmentOrder) {
        if (busyId.value != null) return
        busyId.value = order.id
        banner.value = null
        error.value = null
        Telemetry.event("fulfillment.mark_shipped", mapOf("ebay" to order.onEbay))

        viewModelScope.launch {
            when (val outcome = service.markShipped(order, _tracking.value[order.id].orEmpty())) {
                is ShipOutcome.Sent -> {
                    banner.value = Fulfillment.confirmation(order, outcome.tracking, queued = false)
                    _tracking.value = _tracking.value - order.id
                }
                is ShipOutcome.Queued -> {
                    banner.value = Fulfillment.confirmation(order, outcome.tracking, queued = true)
                    _tracking.value = _tracking.value - order.id
                }
                is ShipOutcome.Failed -> error.value = outcome.message
            }
            busyId.value = null
        }
    }

    fun refresh() {
        if (refreshing.value) return
        refreshing.value = true
        viewModelScope.launch {
            runCatching { syncTrigger.refresh() }.onFailure {
                // The cached queue stays. A failed refresh is not a reason to
                // hide parcels that still need posting.
                error.value = "Couldn't refresh. Showing what's on this device."
            }
            refreshing.value = false
        }
    }

    fun dismiss() {
        banner.value = null
        error.value = null
    }
}

@Composable
fun FulfillmentScreen(
    onOpenItem: (String) -> Unit = {},
    onClose: () -> Unit = {},
    viewModel: FulfillmentViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    val tracking by viewModel.tracking.collectAsState()

    Column(
        Modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text("Shipping", style = MaterialTheme.typography.titleLarge)
        Text(state.summary, style = MaterialTheme.typography.bodyMedium)
        if (state.labelCost > 0) {
            Text(
                "${Money.format(state.labelCost)} of labels on these",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        state.banner?.let { InfoCard("Done", it, tone = InfoTone.Success) }
        state.errorMessage?.let { InfoCard("That didn't work", it, tone = InfoTone.Error) }

        LazyColumn(
            Modifier.fillMaxWidth().weight(1f),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            items(state.queue, key = { it.id }) { order ->
                QueueCard(
                    order = order,
                    nowMs = state.nowMs,
                    trackingText = tracking[order.id].orEmpty(),
                    busy = state.busyId == order.id,
                    onTracking = { viewModel.setTracking(order.id, it) },
                    onShip = { viewModel.markShipped(order) },
                    onOpenItem = { onOpenItem(order.sale.inventoryItemId) },
                )
            }

            if (state.shipped.isNotEmpty()) {
                item {
                    Text(
                        "Recently posted",
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(top = Spacing.sm),
                    )
                }
                items(state.shipped, key = { "done-${it.id}" }) { order ->
                    ShippedRow(order) { onOpenItem(order.sale.inventoryItemId) }
                }
            }
        }

        BrandSecondaryButton(
            text = if (state.refreshing) "Refreshing…" else "Refresh",
            enabled = !state.refreshing,
            modifier = Modifier.fillMaxWidth(),
        ) { viewModel.refresh() }
        BrandSecondaryButton(text = "Back", modifier = Modifier.fillMaxWidth()) { onClose() }
    }
}

@Composable
private fun QueueCard(
    order: FulfillmentOrder,
    nowMs: Long,
    trackingText: String,
    busy: Boolean,
    onTracking: (String) -> Unit,
    onShip: () -> Unit,
    onOpenItem: () -> Unit,
) {
    val overdue = Fulfillment.overdue(order, nowMs)
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                order.displayTitle,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
                maxLines = 2,
                modifier = Modifier.weight(1f),
            )
            Text(Money.format(order.sale.salePrice), style = MaterialTheme.typography.bodyMedium)
        }
        Text(
            Fulfillment.waitingLabel(order, nowMs) +
                (order.sale.buyerUsername?.let { " · $it" } ?: ""),
            style = MaterialTheme.typography.bodySmall,
            color = if (overdue) {
                MaterialTheme.colorScheme.error
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
        )
        if (!order.onEbay) {
            Text(
                // Says why this one won't notify a buyer. Without it, a seller
                // reasonably assumes every "mark shipped" reaches somebody.
                "Recorded here only. This sale isn't linked to an eBay order.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        OutlinedTextField(
            value = trackingText.ifEmpty { order.existingTracking.orEmpty() },
            onValueChange = onTracking,
            label = { Text("Tracking number") },
            singleLine = true,
            enabled = !busy,
            modifier = Modifier.fillMaxWidth(),
        )

        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            BrandPrimaryButton(
                text = if (busy) "Saving…" else "Mark shipped",
                enabled = !busy,
                modifier = Modifier.weight(1f),
            ) { onShip() }
            TextButton(onClick = onOpenItem) { Text("Open item") }
        }
    }
}

@Composable
private fun ShippedRow(order: FulfillmentOrder, onOpenItem: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().cardStyle(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(order.displayTitle, style = MaterialTheme.typography.bodyMedium, maxLines = 1)
            Text(
                order.existingTracking?.let { "Tracking $it" } ?: "No tracking recorded",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        TextButton(onClick = onOpenItem) { Text("Open") }
    }
}
