package com.gradethread.app.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.gradethread.app.BuildConfig
import com.gradethread.app.platform.AppConfig
import com.gradethread.app.ui.theme.BrandDestructiveButton
import com.gradethread.app.ui.theme.MinTouchTarget
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1383: settings (iOS `SettingsView`).
 *
 * Replaces the `SectionPlaceholder` this destination rendered — including the
 * only route to signing out, which meant the app had no way to leave an account.
 *
 * US-1388: the workspace switcher lives in the Account section. It shows even
 * with one workspace — "whose inventory am I looking at" is the question it
 * answers, and hiding it when the answer is "yours" makes that ambiguous.
 */
@Composable
fun SettingsScreen(
    onOpenMarketplaces: () -> Unit,
    onOpenCredits: () -> Unit,
    onOpenPlans: () -> Unit = {},
    onOpenSupport: () -> Unit = {},
    onOpenTeam: () -> Unit = {},
    modifier: Modifier = Modifier,
    viewModel: SettingsViewModel = hiltViewModel(),
    feedbackViewModel: com.gradethread.app.feedback.FeedbackViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var languagePickerOpen by androidx.compose.runtime.remember {
        androidx.compose.runtime.mutableStateOf(false)
    }

    LaunchedEffect(Unit) { viewModel.loadProfile() }

    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Text(
            stringResource(R.string.settings_title),
            style = MaterialTheme.typography.titleLarge,
            modifier = Modifier.padding(horizontal = Spacing.md, vertical = Spacing.xs),
        )

        state.notice?.let { message ->
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Spacing.md),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    message,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = viewModel::dismissNotice) { Text(stringResource(R.string.settings_ok)) }
            }
        }

        // ── Profile ──────────────────────────────────────────────────────────
        SectionHeader(stringResource(R.string.settings_section_account))
        Row(Modifier.fillMaxWidth().padding(horizontal = Spacing.md, vertical = Spacing.xs)) {
            Column(Modifier.weight(1f)) {
                Text(
                    state.profile?.fullName?.takeIf { it.isNotBlank() }
                        ?: state.email
                        ?: stringResource(R.string.settings_signed_in),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                state.email?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        // US-1388: which workspace this session is scoped to, and the switch.
        com.gradethread.app.workspace.WorkspaceSwitcherRow()

        // US-2407: directly under the switcher, because "which workspace" and
        // "who is in it" are the same question asked twice.
        SettingRow(
            title = stringResource(R.string.settings_team),
            subtitle = stringResource(R.string.settings_team_subtitle),
            onClick = onOpenTeam,
        )

        // ── Plan & credits ───────────────────────────────────────────────────
        SectionHeader(stringResource(R.string.settings_section_plan))
        val profile = state.profile
        if (profile == null) {
            Text(
                stringResource(
                    if (state.loadingProfile) {
                        R.string.settings_plan_loading
                    } else {
                        // Named as unavailable rather than shown as "Free":
                        // telling a paying seller they're on the free plan
                        // because a request failed is worse than admitting we
                        // don't know.
                        R.string.settings_plan_unavailable
                    },
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = Spacing.md),
            )
        } else {
            SettingRow(
                title = stringResource(R.string.settings_plan),
                subtitle = profile.plan.replaceFirstChar { it.uppercase() },
                // US-1367: the plan row is where someone looks when they want to
                // change it, so it opens the paywall rather than just reporting.
                onClick = onOpenPlans,
            )
            SettingRow(
                title = stringResource(R.string.settings_grading_credits),
                subtitle = stringResource(
                    R.string.settings_credits_subtitle,
                    profile.creditBalance,
                    profile.gradesUsedThisMonth,
                ),
                onClick = onOpenCredits,
            )
        }

        // ── Connections ──────────────────────────────────────────────────────
        SectionHeader(stringResource(R.string.settings_section_connections))
        SettingRow(
            title = stringResource(R.string.settings_ebay),
            subtitle = stringResource(R.string.settings_ebay_subtitle),
            onClick = onOpenMarketplaces,
        )

        // ── Preferences ──────────────────────────────────────────────────────
        SectionHeader(stringResource(R.string.settings_section_preferences))
        ToggleRow(
            title = stringResource(R.string.settings_show_cost),
            subtitle = stringResource(R.string.settings_show_cost_subtitle),
            checked = state.showCostOnRows,
            onChange = viewModel::setShowCostOnRows,
        )
        ToggleRow(
            title = stringResource(R.string.settings_confirm_bulk),
            subtitle = stringResource(R.string.settings_confirm_bulk_subtitle),
            checked = state.confirmBulkActions,
            onChange = viewModel::setConfirmBulkActions,
        )
        ToggleRow(
            title = stringResource(R.string.settings_haptics),
            subtitle = stringResource(R.string.settings_haptics_subtitle),
            checked = state.hapticsEnabled,
            onChange = viewModel::setHapticsEnabled,
        )
        ToggleRow(
            title = stringResource(R.string.settings_background_refresh),
            subtitle = stringResource(R.string.settings_background_refresh_subtitle),
            checked = state.backgroundRefreshEnabled,
            onChange = viewModel::setBackgroundRefreshEnabled,
        )
        ToggleRow(
            title = stringResource(R.string.settings_analytics),
            // Precise about the split: crash reports are how we find the bug
            // that lost someone's photos, and conflating the two would make
            // opting out of product analytics feel riskier than it is.
            subtitle = stringResource(R.string.settings_analytics_subtitle),
            checked = state.analyticsEnabled,
            onChange = viewModel::setAnalyticsEnabled,
        )

        // ── Security ─────────────────────────────────────────────────────────
        SectionHeader(stringResource(R.string.settings_section_security))
        SettingRow(
            title = stringResource(R.string.settings_change_password),
            subtitle = stringResource(R.string.settings_change_password_subtitle),
            enabled = !state.busy,
            onClick = viewModel::changePassword,
        )

        // US-1393: the in-app language override. Hidden while only one
        // language ships — a picker whose only option is the one you already
        // have is noise, and it would offer a change that does nothing.
        if (com.gradethread.app.platform.locale.AppLocale.hasChoice) {
            SettingRow(
                title = stringResource(R.string.settings_language),
                subtitle = com.gradethread.app.platform.locale.AppLocale.label(
                    com.gradethread.app.platform.locale.AppLocale.current(),
                    stringResource(R.string.settings_language_system),
                ),
                onClick = { languagePickerOpen = true },
            )
        }

        // ── Help ─────────────────────────────────────────────────────────────
        SectionHeader(stringResource(R.string.settings_section_help))
        SettingRow(
            title = stringResource(R.string.settings_support),
            subtitle = stringResource(R.string.settings_support_subtitle),
            onClick = onOpenSupport,
        )
        // US-1387: the sheet's ViewModel is hoisted to THIS screen, so closing
        // the sheet to go and check a version number does not throw away what
        // was typed.
        SettingRow(
            title = stringResource(R.string.settings_feedback),
            subtitle = stringResource(R.string.settings_feedback_subtitle),
            onClick = feedbackViewModel::open,
        )

        // ── Diagnostics ──────────────────────────────────────────────────────
        SectionHeader(stringResource(R.string.settings_section_diagnostics))
        SettingRow(
            title = stringResource(R.string.settings_app_version),
            subtitle = stringResource(
                R.string.settings_app_version_value,
                BuildConfig.VERSION_NAME,
                BuildConfig.VERSION_CODE,
            ),
        )
        // The endpoint, not the keys: which backend a build points at is a
        // routing fact worth seeing in a support thread, and it's already public
        // (CLAUDE.md). Anything secret stays out of this screen.
        SettingRow(
            title = stringResource(R.string.settings_edge_endpoint),
            subtitle = AppConfig.edgeApiUrl,
        )

        // ── Danger zone ──────────────────────────────────────────────────────
        SectionHeader(stringResource(R.string.settings_section_danger))
        Column(Modifier.fillMaxWidth().padding(Spacing.md)) {
            BrandDestructiveButton(
                text = stringResource(R.string.settings_sign_out),
                enabled = !state.busy,
                modifier = Modifier.fillMaxWidth().padding(bottom = Spacing.xs),
            ) { viewModel.ask(SettingsViewModel.Confirm.SIGN_OUT) }
            TextButton(
                onClick = { viewModel.ask(SettingsViewModel.Confirm.DELETE_ACCOUNT) },
                modifier = Modifier.fillMaxWidth(),
            ) { Text(stringResource(R.string.settings_delete_account)) }
        }
    }

    if (languagePickerOpen) {
        com.gradethread.app.platform.locale.LanguagePicker(
            onDismiss = { languagePickerOpen = false },
        )
    }

    // US-1387: renders nothing until opened.
    com.gradethread.app.feedback.FeedbackSheet(
        onOpenSupport = onOpenSupport,
        viewModel = feedbackViewModel,
    )

    state.pendingConfirm?.let { confirm ->
        when (confirm) {
            SettingsViewModel.Confirm.SIGN_OUT -> AlertDialog(
                onDismissRequest = viewModel::cancelConfirm,
                title = { Text(stringResource(R.string.settings_sign_out_2)) },
                text = {
                    Text(
                        // Says what it costs. Anything not yet synced is lost, and
                        // the seller is the only one who can decide whether to
                        // wait for signal first.
                        stringResource(R.string.settings_sign_out_body),
                    )
                },
                confirmButton = {
                    TextButton(onClick = viewModel::confirmSignOut) { Text(stringResource(R.string.settings_sign_out)) }
                },
                dismissButton = {
                    TextButton(onClick = viewModel::cancelConfirm) { Text(stringResource(R.string.settings_cancel)) }
                },
            )

            SettingsViewModel.Confirm.DELETE_ACCOUNT -> AlertDialog(
                onDismissRequest = viewModel::cancelConfirm,
                title = { Text(stringResource(R.string.settings_delete_your_account)) },
                text = {
                    Text(stringResource(R.string.settings_delete_account_body))
                },
                confirmButton = {
                    TextButton(onClick = viewModel::confirmDeleteAccount) { Text(stringResource(R.string.settings_continue)) }
                },
                dismissButton = {
                    TextButton(onClick = viewModel::cancelConfirm) { Text(stringResource(R.string.settings_cancel)) }
                },
            )
        }
    }
}

@Composable
private fun SectionHeader(title: String) {
    HorizontalDivider(Modifier.padding(top = Spacing.xs))
    Text(
        title,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(horizontal = Spacing.md, vertical = Spacing.xs),
    )
}

@Composable
private fun SettingRow(
    title: String,
    subtitle: String,
    enabled: Boolean = true,
    onClick: (() -> Unit)? = null,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .then(
                if (onClick != null) {
                    Modifier.clickable(enabled = enabled, onClick = onClick)
                } else {
                    Modifier
                },
            )
            .padding(horizontal = Spacing.md, vertical = Spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyMedium)
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun ToggleRow(
    title: String,
    subtitle: String,
    checked: Boolean,
    onChange: (Boolean) -> Unit,
) {
    val spoken = stringResource(
        R.string.settings_toggle_spoken,
        title,
        stringResource(
            if (checked) R.string.settings_toggle_on else R.string.settings_toggle_off,
        ),
    )
    Row(
        Modifier
            .fillMaxWidth()
            // The whole row toggles, not just the switch: a 32dp switch is a
            // miss-prone target next to a two-line label.
            .clickable { onChange(!checked) }
            .padding(horizontal = Spacing.md, vertical = Spacing.xs)
            .semantics { contentDescription = spoken },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyMedium)
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            // 48dp floor, matching the brand controls: the switch itself is
            // shorter than Android's a11y touch-target minimum.
            modifier = Modifier
                .padding(start = Spacing.xs)
                .defaultMinSize(minHeight = MinTouchTarget),
        )
    }
}
