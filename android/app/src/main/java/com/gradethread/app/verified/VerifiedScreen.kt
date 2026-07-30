package com.gradethread.app.verified

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import com.gradethread.app.marketplaces.CustomTabsLauncher
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
 * US-1375: where the seller stands on the verified badge.
 */
@HiltViewModel
class VerifiedViewModel @Inject constructor(
    private val service: VerifiedProviding,
) : ViewModel() {

    data class State(
        val profile: VerifiedProfile? = null,
        val stats: VerifiedStats = VerifiedStats(),
        val loading: Boolean = false,
        val loaded: Boolean = false,
        /** True when what's on screen came from disk, not from the server. */
        val stale: Boolean = false,
        val errorMessage: String? = null,
    ) {
        val status: VerifiedStatus? get() = profile?.let { VerifiedBadge.status(it) }

        val requirements: List<VerifiedRequirement>
            get() = profile?.let { VerifiedBadge.requirements(it, stats) }.orEmpty()

        val progress: Float get() = VerifiedBadge.progress(requirements)

        val nextStep: VerifiedRequirement? get() = VerifiedBadge.nextStep(requirements)

        val profileUrl: String? get() = profile?.let { VerifiedBadge.profileUrl(it) }

        val credentials: String? get() = VerifiedBadge.credentials(stats)

        val sinceLabel: String? get() = profile?.let { VerifiedBadge.sinceLabel(it) }
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun load() {
        if (_state.value.loading) return
        _state.value = _state.value.copy(loading = true, errorMessage = null)
        Telemetry.screen("verified")

        viewModelScope.launch {
            // The cached copy goes up FIRST, so an offline open shows the last
            // known standing immediately rather than a spinner that resolves
            // into an error.
            if (_state.value.profile == null) {
                service.cached()?.let { cached ->
                    _state.value = _state.value.copy(
                        profile = cached.profile,
                        stats = cached.stats,
                        loaded = true,
                        stale = true,
                    )
                }
            }

            runCatching { service.profile() }.fold(
                onSuccess = { response ->
                    _state.value = State(
                        profile = response.profile,
                        stats = response.stats,
                        loaded = true,
                        stale = false,
                    )
                },
                onFailure = { error ->
                    _state.value = _state.value.copy(
                        loading = false,
                        errorMessage = if (_state.value.profile != null) {
                            // There IS something on screen; say it might be old
                            // rather than shouting about a failure.
                            "Showing what we last knew. Couldn't reach the server just now."
                        } else {
                            (error as? EdgeApiError)?.userMessage()
                                ?: "Couldn't load your verification status."
                        },
                    )
                },
            )
        }
    }

    fun dismissError() {
        _state.value = _state.value.copy(errorMessage = null)
    }
}

@Composable
fun VerifiedScreen(
    onClose: () -> Unit = {},
    viewModel: VerifiedViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    val context = androidx.compose.ui.platform.LocalContext.current
    LaunchedEffect(Unit) { viewModel.load() }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Text("Verified seller", style = MaterialTheme.typography.titleLarge)
        Text(
            // Says up front where changes are made, so a read-only screen isn't
            // mistaken for a broken one.
            "Your badge shows buyers your grading record. Set it up on gradethread.com.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        state.errorMessage?.let {
            InfoCard(
                if (state.profile != null) "Might be out of date" else "That didn't work",
                it,
                tone = if (state.profile != null) InfoTone.Warning else InfoTone.Error,
            )
        }

        val status = state.status
        if (status != null) {
            Column(
                Modifier.fillMaxWidth().cardStyle(),
                verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
            ) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        status.label,
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.weight(1f),
                    )
                    if (state.stale) {
                        Text(
                            "Offline",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                Text(status.detail, style = MaterialTheme.typography.bodyMedium)
                state.sinceLabel?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                state.credentials?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                    )
                }
                LinearProgressIndicator(
                    progress = { state.progress },
                    modifier = Modifier.fillMaxWidth(),
                )
                state.nextStep?.let {
                    // One step, not four. A list of everything undone is a wall;
                    // the first thing is the only one that matters today.
                    Text(
                        "Next: ${it.title.lowercase()}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
            }
        } else if (state.loading) {
            Text("Loading…", style = MaterialTheme.typography.bodyMedium)
        }

        if (state.requirements.isNotEmpty()) {
            Text("What it takes", style = MaterialTheme.typography.titleMedium)
            state.requirements.forEach { requirement ->
                Column(
                    Modifier.fillMaxWidth().cardStyle(),
                    verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
                ) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            requirement.title,
                            style = MaterialTheme.typography.bodyLarge,
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            if (requirement.met) "Done" else "To do",
                            style = MaterialTheme.typography.labelMedium,
                            color = if (requirement.met) {
                                MaterialTheme.colorScheme.primary
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            },
                        )
                    }
                    Text(
                        requirement.detail,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        state.profileUrl?.let { url ->
            BrandSecondaryButton(text = "View my public profile", modifier = Modifier.fillMaxWidth()) {
                CustomTabsLauncher.open(context, url)
            }
        }
        BrandSecondaryButton(
            text = if (state.loading) "Checking…" else "Refresh",
            enabled = !state.loading,
            modifier = Modifier.fillMaxWidth(),
        ) { viewModel.load() }
        BrandSecondaryButton(text = "Back", modifier = Modifier.fillMaxWidth()) { onClose() }
    }
}
