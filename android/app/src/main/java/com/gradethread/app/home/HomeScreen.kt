package com.gradethread.app.home

import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.core.app.NotificationManagerCompat
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.LaunchedEffect
import com.gradethread.app.money.DashboardRollup
import com.gradethread.app.money.Money
import com.gradethread.app.ui.components.Sparkline
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1370: the home dashboard (iOS `DashboardView`).
 *
 * Replaces the `SectionPlaceholder` this destination rendered (that scaffold was
 * deleted in US-2792) — the first thing
 * a seller saw on opening the app.
 *
 * Contains no arithmetic: every figure comes from [HomeViewModel]'s memoized
 * rollups. The sparkline is a static Canvas drawing, so there is no animation to
 * gate for reduced motion.
 */
@Composable
fun HomeScreen(
    onAddItem: () -> Unit,
    onSnap: () -> Unit,
    onOpenInventory: () -> Unit,
    onOpenMoney: () -> Unit,
    onOpenGrades: () -> Unit,
    onOpenMarketplaces: () -> Unit,
    onOpenItem: (String) -> Unit,
    modifier: Modifier = Modifier,
    viewModel: HomeViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val activation by viewModel.activation.collectAsStateWithLifecycle()
    val refreshing by viewModel.refreshing.collectAsStateWithLifecycle()
    val refreshError by viewModel.refreshError.collectAsStateWithLifecycle()
    val context = LocalContext.current

    // Notification state is an OS fact and eBay connectivity a server one, so
    // neither can come from Room. Re-read on entry so returning from system
    // settings shows the step ticked.
    LaunchedEffect(Unit) {
        viewModel.refreshActivation(
            notificationsGranted = NotificationManagerCompat.from(context).areNotificationsEnabled(),
        )
    }

    LazyColumn(modifier.fillMaxSize()) {
        item {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Spacing.md, vertical = Spacing.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    stringResource(R.string.home_today),
                    style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = viewModel::refresh, enabled = !refreshing) {
                    Text(
                        stringResource(
                            if (refreshing) R.string.home_refreshing else R.string.home_refresh,
                        ),
                    )
                }
            }
        }

        refreshError?.let { message ->
            item {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = Spacing.md),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        message,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = viewModel::dismissRefreshError) { Text(stringResource(R.string.home_dismiss)) }
                }
            }
        }

        // ── Snapshot ─────────────────────────────────────────────────────────
        item {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Spacing.md),
                horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
            ) {
                StatTile(
                    label = stringResource(R.string.home_inventory_value),
                    value = Money.format(state.metrics.inventoryValue),
                    detail = pluralStringResource(
                        R.plurals.home_on_hand,
                        state.metrics.onHandCount,
                        state.metrics.onHandCount,
                    ),
                    modifier = Modifier.weight(1f),
                    onClick = onOpenInventory,
                )
                StatTile(
                    label = stringResource(R.string.home_listed),
                    value = state.metrics.listedCount.toString(),
                    detail = stringResource(R.string.home_active_listings),
                    modifier = Modifier.weight(1f),
                    onClick = onOpenMarketplaces,
                )
            }
        }
        item {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Spacing.md, vertical = Spacing.xs),
                horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
            ) {
                StatTile(
                    label = stringResource(R.string.home_sold_7_days),
                    value = state.metrics.soldThisWeekCount.toString(),
                    detail = Money.format(state.metrics.revenueThisWeek),
                    modifier = Modifier.weight(1f),
                    onClick = onOpenMoney,
                )
                StatTile(
                    label = stringResource(R.string.home_net_profit_7_days),
                    value = Money.format(state.metrics.netProfitThisWeek),
                    detail = stringResource(R.string.home_after_fees),
                    modifier = Modifier.weight(1f),
                    onClick = onOpenMoney,
                )
            }
        }

        // ── Sparkline ────────────────────────────────────────────────────────
        if (state.hasTrendActivity) {
            item {
                Column(Modifier.fillMaxWidth().padding(horizontal = Spacing.md)) {
                    Text(
                        stringResource(R.string.home_last_14_days),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Sparkline(
                        values = state.trend.map { it.revenue },
                        // A spoken sentence rather than 14 unlabeled shapes: the
                        // rising/falling cue must not be colour-only (US-1223).
                        description = stringResource(
                            R.string.home_trend_spoken,
                            Money.format(Money.sum(state.trend) { it.revenue }),
                        ),
                    )
                }
            }
        }

        // ── Activation checklist ─────────────────────────────────────────────
        if (activation.shouldShow) {
            item {
                ChecklistCard(
                    state = activation,
                    onDismiss = viewModel::dismissChecklist,
                    onStep = { step ->
                        when (step.id) {
                            ActivationStep.ADD_ITEM.id -> onAddItem()
                            ActivationStep.CONNECT_EBAY.id -> onOpenMarketplaces()
                            // Opens system settings rather than firing a runtime
                            // permission request. Push DELIVERY is US-1378 and
                            // isn't built yet — prompting for a permission
                            // nothing can use would be asking under false
                            // pretences. Reading the real setting keeps the step
                            // honest in the meantime.
                            ActivationStep.NOTIFICATIONS.id -> context.startActivity(
                                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                                    .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName),
                            )
                        }
                    },
                )
            }
        }

        // ── Quick actions ────────────────────────────────────────────────────
        item {
            Column(Modifier.fillMaxWidth().padding(Spacing.md)) {
                Text(stringResource(R.string.home_quick_actions), style = MaterialTheme.typography.titleMedium)
                Row(
                    Modifier.fillMaxWidth().padding(top = Spacing.xs),
                    horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
                ) {
                    BrandSecondaryButton(text = stringResource(R.string.home_add_item), modifier = Modifier.weight(1f)) {
                        onAddItem()
                    }
                    BrandSecondaryButton(text = stringResource(R.string.home_snap_to_value), modifier = Modifier.weight(1f)) {
                        onSnap()
                    }
                }
                // Scout and Prospect are the other two actions US-1370 AC2 names.
                // They are deliberately absent rather than stubbed: US-1374 hasn't
                // landed, and a button that opens a placeholder is worse than no
                // button — it teaches sellers the app is broken.
            }
        }

        // ── Certified grades (US-1341 AC2's outstanding half) ────────────────
        if (state.grades.total > 0) {
            item {
                Card(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = Spacing.md)
                        .clickable(onClick = onOpenGrades),
                ) {
                    Column(Modifier.padding(Spacing.sm)) {
                        Text(stringResource(R.string.home_certified_grades), style = MaterialTheme.typography.titleMedium)
                        Text(
                            state.grades.label,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }

        // ── Aging nudges ─────────────────────────────────────────────────────
        if (state.agingItems.isNotEmpty()) {
            item {
                Column(Modifier.fillMaxWidth().padding(Spacing.md)) {
                    Text(stringResource(R.string.home_sitting_too_long), style = MaterialTheme.typography.titleMedium)
                    Text(
                        pluralStringResource(
                            R.plurals.home_aging_body,
                            state.metrics.agingCount,
                            state.metrics.agingCount,
                            DashboardRollup.AGING_THRESHOLD_DAYS,
                        ),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            items(state.agingItems, key = { it.id }) { agingItem ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { onOpenItem(agingItem.id) }
                        .padding(horizontal = Spacing.md, vertical = Spacing.xs),
                ) {
                    Text(
                        agingItem.title,
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 1,
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        Money.format(
                            agingItem.listingPrice
                                ?: agingItem.targetPrice
                                ?: agingItem.acquiredPrice
                                ?: 0.0,
                        ),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                HorizontalDivider()
            }
        }

        if (!state.hasAnyItems) {
            item {
                Column(Modifier.fillMaxWidth().padding(Spacing.xl)) {
                    Text(stringResource(R.string.home_nothing_here_yet), style = MaterialTheme.typography.titleMedium)
                    Text(
                        stringResource(R.string.home_empty_body),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun StatTile(
    label: String,
    value: String,
    detail: String,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val spoken = stringResource(R.string.home_tile_spoken, label, value, detail)
    Card(modifier.clickable(onClick = onClick)) {
        Column(
            Modifier
                .padding(Spacing.sm)
                // One spoken element per tile: three separate labels read out in
                // sequence lose the relationship between them.
                .semantics { contentDescription = spoken },
        ) {
            Text(
                label,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                value,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                detail,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun ChecklistCard(
    state: ActivationState,
    onDismiss: () -> Unit,
    onStep: (ActivationStep) -> Unit,
) {
    Card(Modifier.fillMaxWidth().padding(horizontal = Spacing.md, vertical = Spacing.xs)) {
        Column(Modifier.padding(Spacing.sm)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    stringResource(R.string.home_get_set_up),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    stringResource(
                        R.string.home_progress_of,
                        state.completedCount,
                        state.totalCount,
                    ),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                TextButton(onClick = onDismiss) { Text(stringResource(R.string.home_dismiss)) }
            }
            state.steps.forEach { step ->
                // "Done" is spoken as part of the step, not left to the tick
                // glyph — a checkmark drawn in a Canvas says nothing out loud.
                val spokenStep = if (step.done) {
                    stringResource(R.string.home_step_done_spoken, step.title)
                } else {
                    step.title
                }
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable(enabled = !step.done) { onStep(step) }
                        .padding(vertical = Spacing.xxs)
                        .semantics { contentDescription = spokenStep },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            step.title,
                            style = MaterialTheme.typography.bodyMedium,
                            // Strikethrough AND the spoken ", done" above —
                            // never a visual-only completion cue.
                            textDecoration = if (step.done) TextDecoration.LineThrough else null,
                        )
                        if (!step.done) {
                            Text(
                                step.subtitle,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }
    }
}
