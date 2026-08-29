package com.gradethread.app.radar

import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.R
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle
import kotlin.math.roundToInt

/**
 * US-2492: one shop on the shared map.
 *
 * Every section can be absent, and the reason is always the same one: the
 * k-anonymity floor is enforced on the SERVER, and a below-floor group comes
 * back as no row rather than as a redacted payload. There is nothing here to
 * hide - there is only a hole, and this screen's job is to say what the hole
 * means instead of drawing an empty chart that reads as a finding.
 */
@Composable
fun RadarVenueDetailScreen(
    venueId: String,
    onClose: () -> Unit = {},
    viewModel: RadarVenueDetailViewModel = hiltViewModel(),
) {
    val phase by viewModel.state.collectAsState()
    LaunchedEffect(venueId) { viewModel.load(venueId) }

    Column(
        Modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(Spacing.xs),
        ) {
            when (val current = phase) {
                is RadarVenueDetailViewModel.Phase.Loading ->
                    Row(
                        Modifier.fillMaxWidth().padding(Spacing.md),
                        horizontalArrangement = Arrangement.Center,
                    ) { CircularProgressIndicator() }

                is RadarVenueDetailViewModel.Phase.Withheld ->
                    WithheldCard(current) { viewModel.load(venueId) }

                is RadarVenueDetailViewModel.Phase.Ready -> ReadyDetail(current.detail)
            }
        }

        BrandSecondaryButton(
            text = stringResource(R.string.common_back),
            modifier = Modifier.fillMaxWidth(),
        ) { onClose() }
    }
}

@Composable
private fun WithheldCard(phase: RadarVenueDetailViewModel.Phase.Withheld, onRetry: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Text(
            when (phase.reason) {
                // The SAME sentence for a shop nobody has scanned and a shop two
                // people have scanned. Distinguishing them would answer "did
                // anyone scan here?", the exact question the floor refuses.
                RadarVenueDetailViewModel.WithheldReason.NOTHING_TO_SAY ->
                    stringResource(R.string.radar_venue_floor)
                RadarVenueDetailViewModel.WithheldReason.PLAN_GATED ->
                    stringResource(R.string.radar_venue_locked)
                RadarVenueDetailViewModel.WithheldReason.FAILED ->
                    phase.message ?: stringResource(R.string.radar_venue_failed)
            },
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        // A retry only makes sense when something transient might have failed.
        // Behind the floor or the plan wall, a second attempt is a loop.
        if (phase.reason == RadarVenueDetailViewModel.WithheldReason.FAILED) {
            TextButton(onClick = onRetry) {
                Text(stringResource(R.string.common_try_again))
            }
        }
    }
}

@Composable
private fun ReadyDetail(detail: RadarVenueDetail) {
    Text(detail.venue.displayName, style = MaterialTheme.typography.titleLarge)
    Text(
        freshnessLabel(detail.network.daysSinceActivity),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )

    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Text(
            stringResource(
                R.string.radar_venue_activity,
                detail.network.scanCount,
                detail.network.contributorCount,
            ),
            style = MaterialTheme.typography.bodyMedium,
        )
        detail.network.buyRate?.let { rate ->
            Text(
                stringResource(R.string.radar_venue_buy_rate, (rate * 100).roundToInt()),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }

    Text(stringResource(R.string.radar_venue_brands), style = MaterialTheme.typography.titleSmall)
    if (detail.brands.isEmpty()) {
        Text(
            stringResource(R.string.radar_venue_brands_empty),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    } else {
        for (brand in detail.brands.take(BRAND_LIMIT)) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Spacing.xxs),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(brand.brand.orEmpty(), style = MaterialTheme.typography.bodyMedium)
                Text(
                    pluralStringResource(R.plurals.radar_venue_brand_scans, brand.scanCount, brand.scanCount),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
    Text(
        stringResource(R.string.radar_venue_brands_note),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )

    Text(
        stringResource(R.string.radar_venue_condition),
        style = MaterialTheme.typography.titleSmall,
    )
    val mix = detail.network.gradeMix
    if (mix.graded == 0) {
        Text(
            stringResource(R.string.radar_venue_condition_empty),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    } else {
        GradeRow(R.string.radar_venue_grade_high, mix.high, mix.graded)
        GradeRow(R.string.radar_venue_grade_mid, mix.mid, mix.graded)
        GradeRow(R.string.radar_venue_grade_low, mix.low, mix.graded)
        Text(
            // Said out loud every time: these are field estimates from a phone
            // photo, not the certified grade the same app also sells.
            pluralStringResource(R.plurals.radar_venue_grade_note, mix.graded, mix.graded),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** Eight brands is what fits before the list stops being a shortlist. */
private const val BRAND_LIMIT = 8

@Composable
private fun GradeRow(@StringRes labelRes: Int, count: Int, total: Int) {
    val percent = if (total > 0) (count * 100.0 / total).roundToInt() else 0
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Spacing.xxs),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(stringResource(labelRes), style = MaterialTheme.typography.bodyMedium)
        Text(
            stringResource(R.string.radar_venue_grade_share, percent),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontWeight = FontWeight.Medium,
        )
    }
}
