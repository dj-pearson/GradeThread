package com.gradethread.app.referrals

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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.ui.a11y.A11yAnnouncer
import com.gradethread.app.ui.a11y.rememberA11yAnnouncer
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-1385: your referral code, and someone else's.
 *
 * Two halves that do not overlap: the top shares YOUR link, the bottom applies
 * a friend's. Once you have been referred the bottom half becomes a statement
 * rather than a form — a code box that can only ever fail is worse than no box.
 */
@Composable
fun ReferralsScreen(viewModel: ReferralsViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()
    val context = LocalContext.current
    val a11y = rememberA11yAnnouncer()

    LaunchedEffect(Unit) { viewModel.load() }

    ReferralsContent(
        state,
        ReferralsActions(
            retry = viewModel::load,
            setTypedCode = viewModel::setTypedCode,
            redeem = viewModel::redeem,
            // Clipboard and the share sheet both need a real Context, and the
            // announcer needs a live composition. Both stay in the wrapper.
            copy = { text, label -> copyToClipboard(context, a11y, text, label) },
            share = { text -> share(context, text) },
        ),
    )
}

/** Everything this screen can be asked to do (US-2902 AC3). */
@Immutable
data class ReferralsActions(
    val retry: () -> Unit = {},
    val setTypedCode: (String) -> Unit = {},
    val redeem: () -> Unit = {},
    val copy: (String, String) -> Unit = { _, _ -> },
    val share: (String) -> Unit = {},
)

/**
 * Referrals with no ViewModel attached (US-2902 AC3).
 *
 * ⚠ A CODE CAN ONLY BE REDEEMED ONCE, AND THAT IS THREE DIFFERENT SCREENS.
 * `alreadyReferred` means somebody else's code is already on this account;
 * `redeemed` means it just worked; and a plain empty field means neither has
 * happened. All three render the same section with different words, and
 * offering the field to someone who already used a code is a form that can only
 * fail.
 *
 * ⚠ AND THE SHARE CARD IS THE PRODUCT. The link and the code are what a seller
 * actually hands to somebody, so a card that rendered an empty code, or the
 * wrong one, hands out a link that credits nobody.
 */
@Composable
fun ReferralsContent(state: ReferralsViewModel.State, actions: ReferralsActions, modifier: Modifier = Modifier) {
    Column(
        modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.md),
    ) {
        Text(
            stringResource(R.string.referrals_title),
            style = MaterialTheme.typography.headlineMedium,
        )

        when {
            state.loading && state.me == null -> Row(
                Modifier.fillMaxWidth().padding(Spacing.xl),
                horizontalArrangement = Arrangement.Center,
            ) { CircularProgressIndicator() }

            state.loadError != null -> ErrorCard(state.loadError!!, onRetry = actions.retry)

            state.locked -> Text(
                // Deliberately not a share button over an empty link: sending a
                // broken URL to someone's friend is worse than saying "not yet".
                stringResource(R.string.referrals_not_ready),
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.cardStyle(),
            )

            state.me != null -> {
                ShareCard(
                    state = state,
                    onCopy = { text, label ->
                        actions.copy(text, label)
                    },
                    onShare = actions.share,
                )
                StatsCard(state)
            }
        }

        RedeemSection(state, actions)
    }
}

@Composable
private fun ErrorCard(message: String, onRetry: () -> Unit) {
    Column(Modifier.fillMaxWidth().cardStyle()) {
        Text(message, style = MaterialTheme.typography.bodyMedium)
        BrandSecondaryButton(
            text = stringResource(R.string.common_try_again),
            modifier = Modifier.padding(top = Spacing.sm),
        ) { onRetry() }
    }
}

@Composable
private fun ShareCard(state: ReferralsViewModel.State, onCopy: (String, String) -> Unit, onShare: (String) -> Unit) {
    val code = state.me?.code.orEmpty()
    // Spoken character by character: TalkBack reads "ABCD2345" as a mangled
    // attempt at pronunciation otherwise.
    val spokenCode = stringResource(
        R.string.referrals_code_spoken,
        code.toCharArray().joinToString(" "),
    )
    Column(Modifier.fillMaxWidth().cardStyle()) {
        Text(
            stringResource(R.string.referrals_your_code),
            style = MaterialTheme.typography.labelMedium,
        )
        Text(
            code,
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            // Spoken as the CODE, not as a word: TalkBack reads "ABCD2345" as
            // a mangled attempt at pronunciation otherwise.
            modifier = Modifier.semantics { contentDescription = spokenCode },
        )

        Referrals.creditsPerReferral(state.me?.credits ?: ReferralCredits())?.let {
            Text(
                pluralStringResource(R.plurals.referral_credits_summary, it, it),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = Spacing.xs),
            )
        }
        Referrals.nextMilestone(state.me?.milestones ?: ReferralMilestones())?.let {
            Text(
                stringResource(R.string.referral_next_milestone, it.first, it.second),
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(top = Spacing.xs),
            )
        }

        state.shareParts?.let { (code, url) ->
            // The sentence is assembled HERE, from a resource, because the
            // seller is sending it and it has to be in their language.
            val message = stringResource(R.string.referral_share_text, code, url)
            BrandPrimaryButton(
                text = stringResource(R.string.referrals_share_link),
                modifier = Modifier.fillMaxWidth().padding(top = Spacing.md),
            ) { onShare(message) }
        }
        Row(Modifier.fillMaxWidth().padding(top = Spacing.xs)) {
            val codeCopied = stringResource(R.string.referrals_code_copied)
            val linkCopied = stringResource(R.string.referrals_link_copied)
            BrandSecondaryButton(
                text = stringResource(R.string.referrals_copy_code),
                modifier = Modifier.weight(1f),
            ) { onCopy(code, codeCopied) }
            state.link?.let { link ->
                BrandSecondaryButton(
                    text = stringResource(R.string.referrals_copy_link),
                    modifier = Modifier.weight(1f).padding(start = Spacing.xs),
                ) { onCopy(link, linkCopied) }
            }
        }
    }
}

@Composable
private fun StatsCard(state: ReferralsViewModel.State) {
    val stats = state.me?.stats ?: ReferralStats()
    Row(Modifier.fillMaxWidth().cardStyle()) {
        Stat(stringResource(R.string.referrals_stat_referred), stats.total, Modifier.weight(1f))
        Stat(
            stringResource(R.string.referrals_stat_in_progress),
            state.inProgress,
            Modifier.weight(1f),
        )
        Stat(stringResource(R.string.referrals_stat_rewarded), stats.granted, Modifier.weight(1f))
    }
}

@Composable
private fun Stat(label: String, value: Int, modifier: Modifier = Modifier) {
    // "$value $label" reads correctly in English and in every language whose
    // number-then-noun order matches; the label itself is already translated.
    val spoken = "$value $label"
    Column(
        modifier.semantics { contentDescription = spoken },
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            value.toString(),
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold,
        )
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun RedeemSection(state: ReferralsViewModel.State, actions: ReferralsActions) {
    Column(Modifier.fillMaxWidth().cardStyle()) {
        Text(
            stringResource(R.string.referrals_redeem_title),
            style = MaterialTheme.typography.titleMedium,
        )

        val referredLabel = Referrals.referredByLabel(state.me?.referredBy)
        if (referredLabel != null) {
            // A form that can only ever be refused is worse than a sentence
            // that explains why there is no form.
            Text(
                stringResource(referredLabel, state.me?.referredBy?.code.orEmpty()),
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(top = Spacing.xs),
            )
            return@Column
        }

        Text(
            stringResource(R.string.referrals_redeem_hint),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = Spacing.xs, bottom = Spacing.sm),
        )
        OutlinedTextField(
            value = state.typedCode,
            onValueChange = actions.setTypedCode,
            label = { Text(stringResource(R.string.referrals_redeem_label)) },
            singleLine = true,
            isError = state.redeemError != null,
            enabled = !state.redeeming,
            modifier = Modifier.fillMaxWidth(),
        )
        state.redeemError?.let {
            Text(
                it.detail ?: stringResource(it.res),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(top = Spacing.xs),
            )
        }
        if (state.redeemed) {
            Text(
                stringResource(R.string.referrals_redeem_applied),
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(top = Spacing.xs),
            )
        }
        BrandPrimaryButton(
            text = stringResource(
                if (state.redeeming) {
                    R.string.referrals_redeem_applying
                } else {
                    R.string.referrals_redeem_apply
                },
            ),
            modifier = Modifier.fillMaxWidth().padding(top = Spacing.sm),
            enabled = state.canRedeem,
        ) { actions.redeem() }
    }
}

/**
 * AC1: the system share sheet.
 *
 * A plain `ACTION_SEND` with text, wrapped in a chooser. No package targeting —
 * where someone's friends are is their business, not ours.
 */
private fun share(context: Context, text: String) {
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, text)
    }
    context.startActivity(Intent.createChooser(send, null))
}

/**
 * AC2: copy, and SAY that it copied.
 *
 * Android 13+ shows its own clipboard toast, so announcing there too would
 * double it. Below 13 there is no system feedback at all, which for a
 * screen-reader user means the button appears to do nothing.
 */
private fun copyToClipboard(context: Context, a11y: A11yAnnouncer, text: String, announcement: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
    clipboard?.setPrimaryClip(ClipData.newPlainText("GradeThread referral", text))
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
        // US-2891: the shared announcer, not the raw View call. See the twin of
        // this helper in PassportScreen.copyClaimLink for the reasoning.
        a11y.announce(announcement)
    }
}
