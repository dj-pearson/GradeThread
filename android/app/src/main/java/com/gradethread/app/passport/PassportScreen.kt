package com.gradethread.app.passport

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.R
import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.ui.a11y.A11yAnnouncer
import com.gradethread.app.ui.a11y.rememberA11yAnnouncer
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
class PassportViewModel @Inject constructor(private val service: PassportProviding) : ViewModel() {

    data class State(
        val itemId: String = "",
        val loading: Boolean = false,
        val loaded: Boolean = false,
        val timeline: PassportTimeline? = null,
        /**
         * US-2494: the garment behind this passport. Present only when the
         * owner-scoped resolve walk succeeded, which is what makes it the gate
         * for the handoff section.
         */
        val garmentId: String? = null,
        val minting: Boolean = false,
        /**
         * US-2494: the minted claim link, held in memory for this screen only.
         *
         * Never written to DataStore, Room or SavedStateHandle, and never
         * logged. The server keeps a hash, so a copy that leaves here is the
         * only copy there will ever be.
         */
        val handoff: PassportHandoff? = null,
        val handoffError: String? = null,
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
            val ref = runCatching { service.resolve(itemId) }.getOrNull()
            if (ref == null) {
                _state.value = _state.value.copy(
                    loading = false,
                    loaded = true,
                    noPassport = true,
                )
                return@launch
            }
            _state.value = _state.value.copy(garmentId = ref.garmentId)

            runCatching { service.timeline(ref.slug) }.fold(
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

    /**
     * US-2494: mint the buyer's claim link.
     *
     * Re-mintable on purpose: the server accepts a second mint, which is the
     * only way to retire a link that went to the wrong person. Each press
     * replaces the one on screen, and the old one is no longer shown.
     */
    fun mintClaimLink() {
        val garmentId = _state.value.garmentId ?: return
        if (_state.value.minting) return
        _state.value = _state.value.copy(minting = true, handoffError = null, handoff = null)
        viewModelScope.launch {
            runCatching { service.mintClaimLink(garmentId) }.fold(
                onSuccess = {
                    _state.value = _state.value.copy(minting = false, handoff = it)
                },
                onFailure = { error ->
                    _state.value = _state.value.copy(
                        minting = false,
                        handoffError = (error as? EdgeApiError)?.userMessage()
                            ?: "Couldn't create a claim link just now.",
                    )
                },
            )
        }
    }
}

@Composable
fun PassportScreen(itemId: String, onClose: () -> Unit = {}, viewModel: PassportViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()
    LaunchedEffect(itemId) { viewModel.load(itemId) }

    Column(
        Modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(stringResource(R.string.passport_title), style = MaterialTheme.typography.titleLarge)
        if (state.garmentName.isNotEmpty()) {
            Text(state.garmentName, style = MaterialTheme.typography.bodyLarge)
        }

        state.errorMessage?.let {
            InfoCard(stringResource(R.string.common_that_didnt_work), it, tone = InfoTone.Error)
        }

        when {
            state.loading -> Text(
                stringResource(R.string.common_loading),
                style = MaterialTheme.typography.bodyMedium,
            )

            state.noPassport -> InfoCard(
                stringResource(R.string.passport_empty_title),
                // Says what creates one. "Nothing here" with no explanation is
                // the same screen as a bug.
                stringResource(R.string.passport_empty_body),
            )

            state.emptyChain -> InfoCard(
                stringResource(R.string.passport_no_history_title),
                stringResource(R.string.passport_no_history_body),
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
                            stringResource(R.string.passport_chain_strength, state.strength.label),
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
                    stringResource(
                        R.string.passport_origin,
                        seller.displayName?.takeIf { it.isNotBlank() }
                            ?: stringResource(R.string.passport_origin_handle, seller.handle),
                    ),
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

        // US-2494: only once the owner-scoped resolve found the garment. On any
        // other item this is not a section to explain — there is nothing to
        // hand off.
        state.garmentId?.let { HandoffSection(state, viewModel::mintClaimLink) }

        BrandSecondaryButton(
            text = stringResource(R.string.common_back),
            modifier = Modifier.fillMaxWidth(),
        ) { onClose() }
    }
}

/**
 * US-2494: the owner's handoff.
 *
 * The link is shown once and never again — the server keeps only a hash of it —
 * so the copy says so plainly rather than leaving the seller to find out by
 * coming back for it.
 */
@Composable
private fun HandoffSection(state: PassportViewModel.State, onMint: () -> Unit) {
    val context = LocalContext.current
    val a11y = rememberA11yAnnouncer()
    val copied = stringResource(R.string.passport_claim_link_copied)

    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Text(
            stringResource(R.string.passport_handoff_title),
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Medium,
        )
        Text(
            stringResource(R.string.passport_handoff_body),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        state.handoffError?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }

        val handoff = state.handoff
        if (handoff != null) {
            Text(
                stringResource(
                    R.string.passport_claim_link_once,
                    PassportFormat.longDate(handoff.expiresAt),
                ),
                style = MaterialTheme.typography.bodySmall,
            )
            BrandSecondaryButton(
                text = stringResource(R.string.passport_share_claim_link),
                modifier = Modifier.fillMaxWidth(),
            ) { shareText(context, handoff.claimUrl) }
            BrandSecondaryButton(
                text = stringResource(R.string.passport_copy_claim_link),
                modifier = Modifier.fillMaxWidth(),
            ) { copyClaimLink(context, a11y, handoff.claimUrl, copied) }
        }

        BrandSecondaryButton(
            text = when {
                state.minting -> stringResource(R.string.passport_creating_claim_link)
                handoff != null -> stringResource(R.string.passport_new_claim_link)
                else -> stringResource(R.string.passport_create_claim_link)
            },
            enabled = !state.minting,
            modifier = Modifier.fillMaxWidth(),
        ) { onMint() }
    }
}

/** The system share sheet, with no package targeting. */
private fun shareText(context: Context, text: String) {
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, text)
    }
    context.startActivity(Intent.createChooser(send, null))
}

/**
 * Copy, and say so below Android 13.
 *
 * 13+ shows its own clipboard confirmation, so announcing there would double
 * it; below 13 there is no system feedback at all, which for a screen-reader
 * user means the button appears to do nothing.
 */
private fun copyClaimLink(context: Context, a11y: A11yAnnouncer, link: String, announcement: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
    clipboard?.setPrimaryClip(ClipData.newPlainText("GradeThread claim link", link))
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
        // US-2891: the shared announcer, not the raw View call. The Android 16
        // deprecation is what surfaced it; the reason to change it is that a
        // bare call races the frame and can be dropped. See the twin of this
        // helper in ReferralsScreen.copyToClipboard, and the fuller note in
        // FeedbackSheet.
        a11y.announce(announcement)
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
            Text(
                stringResource(R.string.passport_graded, it),
                style = MaterialTheme.typography.bodyMedium,
            )
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
