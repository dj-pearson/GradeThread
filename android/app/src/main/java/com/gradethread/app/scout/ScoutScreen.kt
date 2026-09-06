package com.gradethread.app.scout

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.AssistChip
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.marketplaces.CustomTabsLauncher
import com.gradethread.app.ui.components.InfoCard
import com.gradethread.app.ui.components.InfoTone
import com.gradethread.app.ui.text
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.money.TripQuickLogButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-1374: ScoutAI — grade what you don't own.
 */
@Composable
fun ScoutScreen(
    onOpenProspect: () -> Unit = {},
    onClose: () -> Unit = {},
    viewModel: ScoutViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    val context = LocalContext.current

    ScoutContent(
        state,
        ScoutActions(
            setKeyword = viewModel::setKeyword,
            setBrand = viewModel::setBrand,
            setSort = viewModel::setSort,
            toggleActionableOnly = viewModel::toggleActionableOnly,
            scan = viewModel::scan,
            // The Context stays in the wrapper. A custom tab needs a real one,
            // and a screenshot test has no browser to hand it to.
            openCandidate = { url -> CustomTabsLauncher.open(context, url) },
            openProspect = onOpenProspect,
            close = onClose,
        ),
    )
}

/** Everything this screen can be asked to do (US-2902 AC3). */
@Immutable
data class ScoutActions(
    val setKeyword: (String) -> Unit = {},
    val setBrand: (String) -> Unit = {},
    val setSort: (ScoutSort) -> Unit = {},
    val toggleActionableOnly: () -> Unit = {},
    val scan: () -> Unit = {},
    val openCandidate: (String) -> Unit = {},
    val openProspect: () -> Unit = {},
    val close: () -> Unit = {},
)

/**
 * Scout with no ViewModel attached (US-2902 AC3).
 *
 * ⚠ THE TRIP LOGGER COMES IN AS A SLOT, and it is the reason this screen could
 * not be captured before. TripQuickLogButton resolves its own ViewModel through
 * Hilt, and RoborazziActivity is not a Hilt component, so any capture reaching
 * it dies on "does not implement GeneratedComponentManager" - the same trap
 * ReceiptScanButton set in MoneyContent, and this one sits ABOVE the fold, so
 * it would have taken every Scout golden rather than two of them.
 *
 * ⚠ AND `planWall` IS NOT AN ERROR, whatever it looks like. A plan wall means
 * the shell is already showing an upgrade dialog, so this screen hides its
 * retry: offering "try again" for a limit that will not move is a button that
 * cannot work. A failure that IS retryable and one that is not render as two
 * different screens, and only a capture can tell them apart.
 */
@Composable
fun ScoutContent(
    state: ScoutViewModel.State,
    actions: ScoutActions,
    modifier: Modifier = Modifier,
    tripQuickLog: @Composable () -> Unit = { TripQuickLogButton() },
) {
    Column(
        modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(stringResource(R.string.scout_scout), style = MaterialTheme.typography.titleLarge)
        Text(
            stringResource(R.string.scout_intro),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        // US-3000 AC4: two taps. A seller opens Scout standing outside a shop,
        // and this is where the drive they just made is still in mind. Tap the
        // button, tap Save. Anything further away does not get logged, and an
        // unlogged trip is worth nothing in April.
        // Wrapped rather than aligned inside the slot: Modifier.align needs a
        // ColumnScope, and a slot that only composes inside one is a slot a
        // screenshot test cannot fill.
        Box(Modifier.align(Alignment.Start)) { tripQuickLog() }

        OutlinedTextField(
            value = state.keyword,
            onValueChange = actions.setKeyword,
            label = { Text(stringResource(R.string.scout_keyword)) },
            singleLine = true,
            enabled = !state.scanning,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = state.brand,
            onValueChange = actions.setBrand,
            label = { Text(stringResource(R.string.scout_brand_optional)) },
            singleLine = true,
            enabled = !state.scanning,
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            // Shows which category the scan actually used, so a bad
            // auto-resolution is visible rather than blamed on the results.
            stringResource(R.string.scout_searching_in, state.categoryLabel),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        state.errorMessage?.let {
            InfoCard(
                stringResource(
                    if (state.planWall != null) {
                        R.string.prospect_not_on_plan
                    } else {
                        R.string.prospect_failed
                    },
                ),
                // US-2976: the server's sentence when there is one, ours when
                // there is not, with the plan name substituted either way.
                it.text(),
                tone = if (state.planWall != null) InfoTone.Warning else InfoTone.Error,
            )
        }

        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(Spacing.xxs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ScoutSort.entries.forEach { option ->
                FilterChip(
                    selected = option == state.sort,
                    onClick = { actions.setSort(option) },
                    label = { Text(stringResource(option.label)) },
                )
            }
            FilterChip(
                selected = state.actionableOnly,
                onClick = actions.toggleActionableOnly,
                label = { Text(stringResource(R.string.scout_worth_buying)) },
            )
        }

        // The server's own note for an empty result when there is one, ours
        // otherwise - and "Scanned 40, showing 12" is a format string, because
        // that order is English's.
        Text(
            state.summary.text(),
            style = MaterialTheme.typography.bodySmall,
        )

        LazyColumn(
            Modifier.fillMaxWidth().weight(1f),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            items(state.candidates, key = { it.itemId }) { candidate ->
                CandidateCard(candidate) {
                    candidate.itemWebUrl?.let(actions.openCandidate)
                }
            }
            state.response?.disclaimer?.let { disclaimer ->
                item {
                    Text(
                        disclaimer,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        BrandPrimaryButton(
            // The retry is hidden on a plan wall: tapping it would hit the same
            // wall, and a button that never works reads as a broken app.
            text = stringResource(
                if (state.scanning) R.string.repricing_scanning else R.string.scout_scan,
            ),
            enabled = state.canScan && state.planWall == null,
            modifier = Modifier.fillMaxWidth(),
        ) { actions.scan() }
        BrandSecondaryButton(text = stringResource(R.string.scout_prospect_store), modifier = Modifier.fillMaxWidth()) {
            actions.openProspect()
        }
        BrandSecondaryButton(text = stringResource(R.string.scout_back), modifier = Modifier.fillMaxWidth()) {
            actions.close()
        }
    }
}

@Composable
private fun CandidateCard(candidate: ScoutCandidate, onOpen: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().clickable { onOpen() }.cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                candidate.title,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
                maxLines = 2,
                modifier = Modifier.weight(1f),
            )
            if (candidate.actionable) {
                AssistChip(onClick = {}, label = { Text(stringResource(R.string.scout_worth_buying)) })
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.scout_asking), style = MaterialTheme.typography.labelSmall)
                Text(candidate.askingLabel, style = MaterialTheme.typography.bodyMedium)
            }
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.scout_sells), style = MaterialTheme.typography.labelSmall)
                Text(candidate.valueLabel, style = MaterialTheme.typography.bodyMedium)
            }
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.scout_profit), style = MaterialTheme.typography.labelSmall)
                Text(
                    candidate.marginLabel,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = if (candidate.underpriced) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.onSurface
                    },
                )
            }
        }
        Text(
            // The grade is shown WITH its confidence, always. A 9.2 read off a
            // stranger's blurry photo is not the same claim as a 9.2 from a
            // proper set, and hiding that gap is how someone overpays.
            stringResource(
                R.string.scout_grade_confidence,
                candidate.gradeLabel,
                Math.round(candidate.gradeConfidence * 100),
            ),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (candidate.reason.isNotBlank()) {
            Text(
                candidate.reason,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
