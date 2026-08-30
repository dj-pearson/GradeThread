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
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
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
// US-2910 AC3. PullToRefreshBox is still ExperimentalMaterial3Api on
// Compose BOM 2025.04.00 - the same opt-in InventoryListScreen carries.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    onAddItem: () -> Unit,
    onSnap: () -> Unit,
    onScout: () -> Unit,
    onProspect: () -> Unit,
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

    HomeContent(
        state = state,
        activation = activation,
        refreshing = refreshing,
        refreshError = refreshError,
        actions = HomeActions(
            onAddItem = onAddItem,
            onSnap = onSnap,
            onScout = onScout,
            onProspect = onProspect,
            onOpenInventory = onOpenInventory,
            onOpenMoney = onOpenMoney,
            onOpenGrades = onOpenGrades,
            onOpenMarketplaces = onOpenMarketplaces,
            onOpenItem = onOpenItem,
            refresh = viewModel::refresh,
            dismissRefreshError = viewModel::dismissRefreshError,
            dismissChecklist = viewModel::dismissChecklist,
        ),
        modifier = modifier,
    )
}

/**
 * Everything the home screen can do (US-2902 AC3).
 *
 * Twelve callbacks - nine navigation targets plus three the ViewModel owns -
 * passed one by one is a signature nobody reads and a screenshot test nobody
 * writes. Bundled, HomeContent takes six arguments and renders from a golden
 * with no Hilt graph and no Context.
 *
 * `refreshActivation` is NOT here: it needs a Context to read the OS
 * notification permission, which is exactly the dependency this split exists to
 * keep out of the stateless half.
 */
@Immutable
data class HomeActions(
    val onAddItem: () -> Unit = {},
    val onSnap: () -> Unit = {},
    val onScout: () -> Unit = {},
    val onProspect: () -> Unit = {},
    val onOpenInventory: () -> Unit = {},
    val onOpenMoney: () -> Unit = {},
    val onOpenGrades: () -> Unit = {},
    val onOpenMarketplaces: () -> Unit = {},
    val onOpenItem: (String) -> Unit = {},
    val refresh: () -> Unit = {},
    val dismissRefreshError: () -> Unit = {},
    val dismissChecklist: () -> Unit = {},
)

/** The home screen with no ViewModel attached (US-2902 AC3). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeContent(
    state: HomeViewModel.State,
    activation: ActivationState,
    refreshing: Boolean,
    refreshError: String?,
    actions: HomeActions,
    modifier: Modifier = Modifier,
) {
    // Read here rather than passed in: LocalContext is available to any
    // composable, so taking it as a parameter would make every caller - a
    // golden included - supply something it should not have to know about.
    // The checklist opens the OS notification settings, which needs it.
    val context = LocalContext.current

    // US-2910 AC3: the GESTURE, not just the button.
    //
    // The Refresh control above has been here since this screen was
    // built and the view model's refresh() is real. What was missing
    // is the pull - what a thumb reaches for on a list, and the only
    // affordance available one-handed in a shop. Inventory was the
    // only sync-backed list of five that had it.
    //
    // The whole list is inside, so a screen showing nothing is still
    // pullable - that is the state a seller pulls from.
    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = actions.refresh,
        // detekt ModifierParameter: the caller's modifier belongs on the
        // ROOT-most layout, and after this wrap that is the box, not the list.
        modifier = modifier.fillMaxSize(),
    ) {
        LazyColumn(Modifier.fillMaxSize()) {
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
                    TextButton(onClick = actions.refresh, enabled = !refreshing) {
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
                        TextButton(onClick = actions.dismissRefreshError) {
                            Text(stringResource(R.string.home_dismiss))
                        }
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
                        onClick = actions.onOpenInventory,
                    )
                    StatTile(
                        label = stringResource(R.string.home_listed),
                        value = state.metrics.listedCount.toString(),
                        detail = stringResource(R.string.home_active_listings),
                        modifier = Modifier.weight(1f),
                        onClick = actions.onOpenMarketplaces,
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
                        onClick = actions.onOpenMoney,
                    )
                    StatTile(
                        label = stringResource(R.string.home_net_profit_7_days),
                        value = Money.format(state.metrics.netProfitThisWeek),
                        detail = stringResource(R.string.home_after_fees),
                        modifier = Modifier.weight(1f),
                        onClick = actions.onOpenMoney,
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
                        onDismiss = actions.dismissChecklist,
                        onStep = { step ->
                            when (step.id) {
                                ActivationStep.ADD_ITEM.id -> actions.onAddItem()
                                ActivationStep.CONNECT_EBAY.id -> actions.onOpenMarketplaces()
                                // Opens system settings rather than firing a runtime
                                // permission request.
                                //
                                // US-2907: the reason used to read "push DELIVERY is
                                // US-1378 and isn't built yet". US-1378 SHIPPED —
                                // platform/push holds nine files including a working
                                // registration and notifier — so that sentence had
                                // been false for as long as the feature has existed.
                                // Same stale-forward-reference shape as the Scout and
                                // Prospect comment ten lines below, in the same file.
                                //
                                // The BEHAVIOUR is still right, for a different
                                // reason. Android gives an app one usable
                                // POST_NOTIFICATIONS dialog: a second ask after a
                                // refusal is auto-denied, and the seller is left
                                // thinking they said yes. OnboardingHost already
                                // spends that one ask on a checklist row the person
                                // taps deliberately, which is the good version of
                                // asking. From here, settings is the route that
                                // still works afterwards.
                                //
                                // OPEN, and not settled here: a seller who never
                                // finished onboarding has an UNSPENT ask, and this
                                // path sends them to settings anyway. Wiring the
                                // real prompt for that case is a behaviour change
                                // with its own argument, not a comment fix.
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
                    // US-2899 sibling note, US-2907: TWO ROWS OF TWO, not one row
                    // of four. At 320dp the four labels are "Add item", "Snap to
                    // Value", "Scout" and "Prospect" — a quarter width each leaves
                    // "Snap to Value" wrapping to three lines or ellipsing, and a
                    // horizontally scrolling row hides the last action behind a
                    // gesture nothing signals. A 2x2 grid keeps every label on one
                    // line at the small end and costs one row of height.
                    Row(
                        Modifier.fillMaxWidth().padding(top = Spacing.xs),
                        horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
                    ) {
                        BrandSecondaryButton(
                            text = stringResource(R.string.home_add_item),
                            modifier = Modifier.weight(1f),
                        ) {
                            actions.onAddItem()
                        }
                        BrandSecondaryButton(
                            text = stringResource(R.string.home_snap_to_value),
                            modifier = Modifier.weight(1f),
                        ) {
                            actions.onSnap()
                        }
                    }
                    Row(
                        Modifier.fillMaxWidth().padding(top = Spacing.xs),
                        horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
                    ) {
                        // Same strings the Tools sheet uses. One feature, one name:
                        // a second copy would let the two drift and teach a seller
                        // that Scout and whatever-it-got-renamed-to are different
                        // things.
                        BrandSecondaryButton(
                            text = stringResource(R.string.tools_scout),
                            modifier = Modifier.weight(1f),
                        ) {
                            actions.onScout()
                        }
                        BrandSecondaryButton(
                            text = stringResource(R.string.tools_prospect),
                            modifier = Modifier.weight(1f),
                        ) {
                            actions.onProspect()
                        }
                    }
                }
            }

            // ── Certified grades (US-1341 AC2's outstanding half) ────────────────
            if (state.grades.total > 0) {
                item {
                    Card(
                        Modifier
                            .fillMaxWidth()
                            .padding(horizontal = Spacing.md)
                            .clickable(onClick = actions.onOpenGrades),
                    ) {
                        Column(Modifier.padding(Spacing.sm)) {
                            Text(
                                stringResource(R.string.home_certified_grades),
                                style = MaterialTheme.typography.titleMedium,
                            )
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
                        Text(
                            stringResource(R.string.home_sitting_too_long),
                            style = MaterialTheme.typography.titleMedium,
                        )
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
                            .clickable { actions.onOpenItem(agingItem.id) }
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
                        Text(
                            stringResource(R.string.home_nothing_here_yet),
                            style = MaterialTheme.typography.titleMedium,
                        )
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
private fun ChecklistCard(state: ActivationState, onDismiss: () -> Unit, onStep: (ActivationStep) -> Unit) {
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
