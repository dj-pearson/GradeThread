package com.gradethread.app.onboarding

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.platform.push.PushPermission
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.CornerRadius
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-1384: the first-run flow, over everything.
 *
 * Renders nothing at all when it has already been seen, so the shell can host
 * it unconditionally — the same shape [com.gradethread.app.billing.PlanStepHost]
 * uses. It sits ABOVE the plan step in the shell: asking someone to pick a plan
 * before they know what the app does is the wrong order.
 */
@Composable
fun OnboardingHost(
    onFirstAction: (String) -> Unit,
    onConnectEbay: () -> Unit,
    viewModel: OnboardingViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()

    // US-2978: the callback is not among this effect's keys, so the block
    // carries whichever closure existed when the key last changed. Read it
    // through rememberUpdatedState rather than adding it to the keys —
    // restarting on a lambda that changes every recomposition would re-run
    // the effect for no reason.
    val currentOnFirstAction by rememberUpdatedState(onFirstAction)
    LaunchedEffect(state.navigateTo) {
        state.navigateTo?.let {
            viewModel.onNavigated()
            currentOnFirstAction(it)
        }
    }

    if (!state.visible) return

    // AC3: the real ActivityResult contract, not a settings deep link. The
    // result is recorded either way - a denial still counts as asked, because
    // Android silently auto-denies the second dialog. Hoisted to the wrapper
    // (US-2902 AC3): a launcher needs an Activity result registry, which the
    // activity a screenshot test renders into does not have.
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { viewModel.markNotificationsAsked() }

    // eBay consent leaves the app and comes back; re-read on return rather than
    // leaving the row unticked next to an account that is now connected.
    LaunchedEffect(state.step) {
        if (state.step == Onboarding.Step.ACTIVATION) viewModel.refreshChecklist()
    }

    OnboardingContent(
        state,
        OnboardingActions(
            setPage = viewModel::setPage,
            pick = viewModel::pick,
            next = viewModel::next,
            skip = viewModel::skip,
            connectEbay = onConnectEbay,
            askNotifications = {
                if (PushPermission.required) {
                    permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                }
            },
        ),
    )
}

/** Everything this screen can be asked to do (US-2902 AC3). */
@Immutable
data class OnboardingActions(
    val setPage: (Int) -> Unit = {},
    val pick: (OnboardingUseCase) -> Unit = {},
    val next: () -> Unit = {},
    val skip: () -> Unit = {},
    val connectEbay: () -> Unit = {},
    val askNotifications: () -> Unit = {},
)

/**
 * The first-run flow, with no ViewModel attached (US-2902 AC3).
 *
 * ⚠ THIS SCREEN HAD NO GOLDEN, which is how US-2976 came to add it. Every other
 * string extraction in that story was verified against a screenshot - "the
 * words move and the pixels do not" - and this one could not be, because
 * US-2902's 46 screens did not include the one a seller sees FIRST. It is
 * reachable only on a first run, which is presumably why it was missed.
 *
 * ⚠ THE PRIMARY BUTTON IS DISABLED ON ONE STEP ONLY. The use-case step is the
 * single place a choice is required, and "Continue" with nothing picked would
 * silently mean "skip" - so the three steps are three different buttons and
 * only a capture shows which one came out.
 */
@Composable
fun OnboardingContent(state: OnboardingViewModel.State, actions: OnboardingActions, modifier: Modifier = Modifier) {
    // A full-bleed Surface, not a dialog: this IS the app until it is done, and
    // a dismissible scrim would let someone tap past the one moment they get
    // to say what they came for.
    Surface(modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.fillMaxSize().padding(Spacing.lg)) {
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when (state.step) {
                    Onboarding.Step.CAROUSEL -> Carousel(state, actions.setPage)
                    Onboarding.Step.USE_CASE -> UseCaseStep(state, actions.pick)
                    Onboarding.Step.ACTIVATION -> ActivationStep(state, actions)
                }
            }

            BrandPrimaryButton(
                text = stringResource(state.primaryLabel),
                modifier = Modifier.fillMaxWidth().padding(top = Spacing.md),
                enabled = state.step != Onboarding.Step.USE_CASE || state.useCase != null,
            ) { actions.next() }

            BrandSecondaryButton(
                text = stringResource(R.string.onboarding_skip),
                modifier = Modifier.fillMaxWidth().padding(top = Spacing.xs),
            ) { actions.skip() }
        }
    }
}

@Composable
private fun Carousel(state: OnboardingViewModel.State, onPage: (Int) -> Unit) {
    val pagerState = rememberPagerState(pageCount = { Onboarding.pages.size })

    // Two-way: the button drives the pager, and a swipe drives the button's
    // label. Without the second half, swiping to the last slide leaves the
    // button reading "Next" with nowhere to go.
    LaunchedEffect(state.pageIndex) {
        if (pagerState.currentPage != state.pageIndex) pagerState.animateScrollToPage(state.pageIndex)
    }
    LaunchedEffect(pagerState) {
        snapshotFlow { pagerState.currentPage }.collect(onPage)
    }

    Column(Modifier.fillMaxSize()) {
        HorizontalPager(state = pagerState, modifier = Modifier.weight(1f)) { page ->
            val content = Onboarding.pages[page]
            Column(
                Modifier.fillMaxSize().padding(horizontal = Spacing.md),
                verticalArrangement = Arrangement.Center,
            ) {
                Text(
                    stringResource(content.title),
                    style = MaterialTheme.typography.headlineMedium,
                )
                Text(
                    stringResource(content.body),
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = Spacing.sm),
                )
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(top = Spacing.sm),
            horizontalArrangement = Arrangement.Center,
        ) {
            repeat(Onboarding.pages.size) { index ->
                Box(
                    Modifier
                        .padding(horizontal = 4.dp)
                        .size(8.dp)
                        .background(
                            if (index == pagerState.currentPage) {
                                MaterialTheme.colorScheme.primary
                            } else {
                                MaterialTheme.colorScheme.surfaceVariant
                            },
                            CircleShape,
                        ),
                )
            }
        }
    }
}

@Composable
private fun UseCaseStep(state: OnboardingViewModel.State, onPick: (OnboardingUseCase) -> Unit) {
    Column(Modifier.fillMaxSize()) {
        Text(
            stringResource(R.string.onboarding_use_case_title),
            style = MaterialTheme.typography.headlineMedium,
        )
        Text(
            stringResource(R.string.onboarding_use_case_subtitle),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = Spacing.xs, bottom = Spacing.md),
        )
        OnboardingUseCase.entries.forEach { useCase ->
            val selected = state.useCase == useCase
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(bottom = Spacing.sm)
                    .cardStyle(flush = true)
                    .then(
                        // Selection is a border, not a fill: a filled card on a
                        // surfaceVariant card reads as disabled, not chosen.
                        if (selected) {
                            Modifier.border(
                                2.dp,
                                MaterialTheme.colorScheme.primary,
                                RoundedCornerShape(CornerRadius.card),
                            )
                        } else {
                            Modifier
                        },
                    )
                    .clickable { onPick(useCase) }
                    .padding(Spacing.md),
            ) {
                Text(
                    stringResource(useCase.title),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Medium,
                )
                Text(
                    stringResource(useCase.subtitle),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun ActivationStep(state: OnboardingViewModel.State, actions: OnboardingActions) {
    Column(Modifier.fillMaxSize()) {
        Text(
            stringResource(R.string.onboarding_activation_title),
            style = MaterialTheme.typography.headlineMedium,
        )
        Text(
            state.progress?.let {
                stringResource(R.string.onboarding_progress, it.done, it.total)
            } ?: stringResource(R.string.onboarding_activation_subtitle),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = Spacing.xs, bottom = Spacing.md),
        )

        state.checklist.forEach { row ->
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(bottom = Spacing.sm)
                    .cardStyle(flush = true)
                    .clickable(enabled = row.actionable) {
                        when (row.item) {
                            ActivationChecklist.Item.NOTIFICATIONS -> actions.askNotifications()
                            ActivationChecklist.Item.EBAY -> actions.connectEbay()
                        }
                    }
                    .padding(Spacing.md),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        if (row.done) {
                            stringResource(R.string.checked_prefix, stringResource(row.item.title))
                        } else {
                            stringResource(row.item.title)
                        },
                        style = MaterialTheme.typography.titleMedium,
                    )
                }
                Text(
                    if (row.done) {
                        stringResource(R.string.onboarding_activation_done)
                    } else if (!row.actionable) {
                        // Said plainly rather than showing a dead button: the
                        // system will not put the dialog up a second time. One
                        // positional format string rather than a concatenation,
                        // because a translator has to be able to reorder the two
                        // halves and put the separator where their language
                        // wants it.
                        stringResource(
                            R.string.onboarding_permission_blocked_detail,
                            stringResource(row.item.detail),
                        )
                    } else {
                        stringResource(row.item.detail)
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
