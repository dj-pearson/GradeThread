package com.gradethread.app.radar

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.R
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle
import com.gradethread.app.ui.theme.statusAmber

/**
 * US-2492: Sourcing Radar on the phone - "is this shop worth walking into?"
 *
 * The web surface is a map. This one is a ranked LIST, and that is a decision
 * rather than a shortcut: standing in a car park, the useful thing is an
 * ordering, nearest-and-busiest first, not a canvas to pan. Both read the same
 * endpoint and score with the same arithmetic ([RadarScoring], ported from
 * `src/lib/radar-map.ts`), so a shop cannot read "Busiest near you" on one and
 * "Quiet" on the other.
 *
 * Nothing here draws a tile map, on this surface most of all: tile URLs ARE the
 * viewport, so panning one would stream the seller's neighbourhood to a third
 * party - the exact disclosure the schema underneath was built to withhold.
 *
 * The location permission is requested from the BUTTON, never on open. The
 * capture flow's launcher pattern, deliberately without its
 * `LaunchedEffect(Unit)` prompt: the first list is built from the seller's own
 * linked stores, so a cold start needs no permission at all and asking for one
 * before the screen has shown its worth is how an app gets a permanent no.
 */
@Composable
fun RadarNearbyScreen(
    onOpenVenue: (String) -> Unit = {},
    onClose: () -> Unit = {},
    viewModel: RadarNearbyViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    LaunchedEffect(Unit) { viewModel.load() }

    val locationLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> viewModel.onLocationPermission(granted) }

    RadarNearbyContent(
        state,
        RadarNearbyActions(
            setWindow = viewModel::setWindow,
            // The permission check stays in the wrapper. A seller who already
            // said yes must not be asked again, and the launcher needs an
            // Activity result registry a screenshot test does not have.
            useMyLocation = {
                if (viewModel.hasLocationPermission()) {
                    viewModel.useMyLocation()
                } else {
                    locationLauncher.launch(Manifest.permission.ACCESS_COARSE_LOCATION)
                }
            },
            retryPersonal = viewModel::retryPersonal,
            retryNetwork = viewModel::retryNetwork,
            checkNetworkAgain = viewModel::checkNetworkAgain,
            openVenue = onOpenVenue,
            close = onClose,
        ),
    )
}

/** Everything this screen can be asked to do (US-2902 AC3). */
@Immutable
data class RadarNearbyActions(
    val setWindow: (RadarWindow) -> Unit = {},
    val useMyLocation: () -> Unit = {},
    val retryPersonal: () -> Unit = {},
    val retryNetwork: () -> Unit = {},
    val checkNetworkAgain: () -> Unit = {},
    val openVenue: (String) -> Unit = {},
    val close: () -> Unit = {},
)

/**
 * The sourcing radar with no ViewModel attached (US-2902 AC3).
 *
 * ⚠ THREE THINGS CAN FAIL SEPARATELY HERE, and they read alike. The seller's
 * OWN store history (`personalError`), the shared network view
 * (`networkError`), and location. Each has its own retry, and one failing must
 * not blank the others - a seller whose location was refused still has a usable
 * list, which is why that case explains itself rather than disabling the row.
 *
 * ⚠ AND `networkLocked` IS NOT AN ERROR. It is a Free plan meeting a paid
 * surface, sticky for the session so the upgrade is offered once rather than on
 * every window change. Rendering it as a failure would tell a seller something
 * is broken when the answer is a price.
 */
@Composable
fun RadarNearbyContent(state: RadarNearbyViewModel.State, actions: RadarNearbyActions, modifier: Modifier = Modifier) {
    Column(
        modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(stringResource(R.string.radar_title), style = MaterialTheme.typography.titleLarge)
        Text(
            stringResource(R.string.radar_subtitle),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
            for (window in RadarWindow.entries) {
                FilterChip(
                    selected = state.window == window,
                    onClick = { actions.setWindow(window) },
                    enabled = !state.loadingNetwork,
                    label = { Text(windowLabel(window)) },
                )
            }
        }

        BrandSecondaryButton(
            text = if (state.locating) {
                stringResource(R.string.radar_locating)
            } else {
                stringResource(R.string.radar_use_my_location)
            },
            modifier = Modifier.fillMaxWidth(),
            enabled = !state.locating,
            onClick = actions.useMyLocation,
        )

        if (state.locationDenied) {
            // A dead button would be worse than an explanation: after two
            // refusals Android stops showing the dialog at all, so the only
            // route back is Settings, and the list still works without it.
            Note(stringResource(R.string.radar_location_denied))
        } else if (state.locationFailed) {
            Note(stringResource(R.string.radar_location_failed))
        }

        LazyColumn(
            Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(Spacing.xs),
        ) {
            state.personalError?.let { message ->
                item {
                    Column(Modifier.fillMaxWidth().cardStyle()) {
                        Text(
                            message,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.error,
                        )
                        TextButton(onClick = actions.retryPersonal) {
                            Text(stringResource(R.string.common_try_again))
                        }
                    }
                }
            }

            if (state.networkLocked) {
                item {
                    Column(
                        Modifier.fillMaxWidth().cardStyle(),
                        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
                    ) {
                        Text(
                            stringResource(R.string.radar_locked_title),
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Medium,
                        )
                        // Naming what is NOT behind the wall matters: a prompt
                        // implying the whole screen is paid would be selling the
                        // seller something they already have.
                        Text(
                            stringResource(R.string.radar_locked_body),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        TextButton(onClick = actions.checkNetworkAgain) {
                            Text(stringResource(R.string.radar_check_again))
                        }
                    }
                }
            } else {
                state.networkError?.let { message ->
                    item {
                        Column(Modifier.fillMaxWidth().cardStyle()) {
                            Text(message, style = MaterialTheme.typography.bodySmall)
                            TextButton(onClick = actions.retryNetwork) {
                                Text(stringResource(R.string.common_try_again))
                            }
                        }
                    }
                }
            }

            if (state.isLoading && state.personal == null) {
                item {
                    Row(
                        Modifier.fillMaxWidth().padding(Spacing.md),
                        horizontalArrangement = Arrangement.Center,
                    ) { CircularProgressIndicator() }
                }
            }

            if (state.isEmpty) {
                item {
                    Column(
                        Modifier.fillMaxWidth().cardStyle(),
                        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
                    ) {
                        Text(
                            stringResource(R.string.radar_empty_title),
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Medium,
                        )
                        // The honest reading of a k-floored silence: not "no
                        // shops", but "nothing we can say without giving away
                        // who scanned".
                        Text(
                            stringResource(R.string.radar_empty_body),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            items(state.rows, key = { it.id }) { row ->
                NearbyRow(row) { row.venueId?.let(actions.openVenue) }
            }

            if (state.kFloor > 0) {
                item { Note(pluralStringResource(R.plurals.radar_k_floor, state.kFloor, state.kFloor)) }
            }

            if (state.offMapStores.isNotEmpty()) {
                item {
                    Text(
                        stringResource(R.string.radar_off_map_header),
                        style = MaterialTheme.typography.titleSmall,
                    )
                }
                items(state.offMapStores.take(OFF_MAP_LIMIT), key = { "off:" + it.key }) { store ->
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = Spacing.xxs),
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(store.name, style = MaterialTheme.typography.bodyMedium)
                        Text(
                            pluralStringResource(R.plurals.radar_off_map_items, store.itemsSourced, store.itemsSourced),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                item { Note(stringResource(R.string.radar_off_map_body)) }
            }

            item { Note(stringResource(R.string.radar_viewing_not_contributing)) }
        }

        BrandSecondaryButton(
            text = stringResource(R.string.common_back),
            modifier = Modifier.fillMaxWidth(),
        ) { actions.close() }
    }
}

/** How many off-map stores are worth a phone screen before the list is noise. */
private const val OFF_MAP_LIMIT = 6

@Composable
private fun NearbyRow(row: RadarNearbyRow, onClick: () -> Unit) {
    Column(
        Modifier.fillMaxWidth()
            .let { if (row.venueId != null) it.clickable(onClick = onClick) else it }
            .cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                row.name,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
            )
            row.level?.let { level ->
                // Named as well as coloured. Colour alone would leave the
                // ranking unreadable to anyone who cannot separate amber from
                // red, and this is the row's whole answer.
                Text(
                    hotnessLabel(level),
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.Medium,
                    color = hotnessTint(level),
                )
            }
        }

        val network = row.network
        if (network != null) {
            Text(
                stringResource(
                    R.string.radar_row_activity,
                    network.scanCount,
                    network.contributorCount,
                    freshnessLabel(network.daysSinceActivity),
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            // Deliberately not "no activity": we did not look and find it quiet,
            // we were told nothing.
            Text(
                stringResource(R.string.radar_row_nothing_shared),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        row.distanceKm?.let { km ->
            val distance = RadarFormat.distance(km)
            Text(
                stringResource(
                    if (distance.imperial) {
                        R.string.radar_row_distance_mi
                    } else {
                        R.string.radar_row_distance_km
                    },
                    RadarFormat.number(distance.value),
                ),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        row.personal?.takeIf { it.itemsSourced > 0 }?.let { personal ->
            Text(
                pluralStringResource(R.plurals.radar_row_sourced, personal.itemsSourced, personal.itemsSourced),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
            )
        }
    }
}

/** A footnote. Plain text, not a second card - a card inside a list of cards
 *  reads as another row rather than as a note about them. */
@Composable
private fun Note(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = Spacing.xxs),
    )
}

@Composable
internal fun windowLabel(window: RadarWindow): String = stringResource(
    when (window) {
        RadarWindow.SEVEN_DAYS -> R.string.radar_window_7d
        RadarWindow.THIRTY_DAYS -> R.string.radar_window_30d
        RadarWindow.NINETY_DAYS -> R.string.radar_window_90d
    },
)

@Composable
internal fun hotnessLabel(level: RadarHotnessLevel): String = stringResource(
    when (level) {
        RadarHotnessLevel.QUIET -> R.string.radar_hotness_quiet
        RadarHotnessLevel.WARM -> R.string.radar_hotness_warm
        RadarHotnessLevel.HOT -> R.string.radar_hotness_hot
        RadarHotnessLevel.PEAK -> R.string.radar_hotness_peak
    },
)

/**
 * A four-step ramp, one flat colour per level - no gradient, so the label
 * survives a screenshot and pairs with the word beside it.
 */
@Composable
internal fun hotnessTint(level: RadarHotnessLevel): Color = when (level) {
    RadarHotnessLevel.QUIET -> MaterialTheme.colorScheme.onSurfaceVariant
    RadarHotnessLevel.WARM -> statusAmber()
    RadarHotnessLevel.HOT -> MaterialTheme.colorScheme.primary
    RadarHotnessLevel.PEAK -> MaterialTheme.colorScheme.error
}

/** How recently somebody scanned, resolved from the band the pure layer picked. */
@Composable
internal fun freshnessLabel(daysSince: Int?): String = when (val band = RadarScoring.freshness(daysSince)) {
    RadarFreshness.DAYS_AGO ->
        pluralStringResource(R.plurals.radar_fresh_days, daysSince ?: 0, daysSince ?: 0)
    else -> stringResource(
        when (band) {
            RadarFreshness.UNKNOWN -> R.string.radar_fresh_unknown
            RadarFreshness.TODAY -> R.string.radar_fresh_today
            RadarFreshness.YESTERDAY -> R.string.radar_fresh_yesterday
            RadarFreshness.LAST_WEEK -> R.string.radar_fresh_last_week
            RadarFreshness.THIS_MONTH -> R.string.radar_fresh_this_month
            else -> R.string.radar_fresh_older
        },
    )
}
