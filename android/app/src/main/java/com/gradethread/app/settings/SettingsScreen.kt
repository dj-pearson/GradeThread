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
 * The workspace switcher (AC3) is deliberately absent: US-1388 owns it and hasn't
 * landed. A picker with one entry that can't switch anything is worse than none.
 */
@Composable
fun SettingsScreen(
    onOpenMarketplaces: () -> Unit,
    onOpenCredits: () -> Unit,
    onOpenPlans: () -> Unit = {},
    onOpenSupport: () -> Unit = {},
    modifier: Modifier = Modifier,
    viewModel: SettingsViewModel = hiltViewModel(),
    feedbackViewModel: com.gradethread.app.feedback.FeedbackViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    LaunchedEffect(Unit) { viewModel.loadProfile() }

    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Text(
            "Settings",
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
                TextButton(onClick = viewModel::dismissNotice) { Text("OK") }
            }
        }

        // ── Profile ──────────────────────────────────────────────────────────
        SectionHeader("Account")
        Row(Modifier.fillMaxWidth().padding(horizontal = Spacing.md, vertical = Spacing.xs)) {
            Column(Modifier.weight(1f)) {
                Text(
                    state.profile?.fullName?.takeIf { it.isNotBlank() }
                        ?: state.email
                        ?: "Signed in",
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

        // ── Plan & credits ───────────────────────────────────────────────────
        SectionHeader("Plan & credits")
        val profile = state.profile
        if (profile == null) {
            Text(
                if (state.loadingProfile) {
                    "Loading your plan…"
                } else {
                    // Named as unavailable rather than shown as "Free": telling a
                    // paying seller they're on the free plan because a request
                    // failed is worse than admitting we don't know.
                    "Plan details aren't available offline. Pull down to retry when you're online."
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = Spacing.md),
            )
        } else {
            SettingRow(
                title = "Plan",
                subtitle = profile.plan.replaceFirstChar { it.uppercase() },
                // US-1367: the plan row is where someone looks when they want to
                // change it, so it opens the paywall rather than just reporting.
                onClick = onOpenPlans,
            )
            SettingRow(
                title = "Grading credits",
                subtitle = "${profile.creditBalance} available · " +
                    "${profile.gradesUsedThisMonth} used this month",
                onClick = onOpenCredits,
            )
        }

        // ── Connections ──────────────────────────────────────────────────────
        SectionHeader("Connections")
        SettingRow(
            title = "eBay",
            subtitle = "Connect or manage your linked accounts",
            onClick = onOpenMarketplaces,
        )

        // ── Preferences ──────────────────────────────────────────────────────
        SectionHeader("Preferences")
        ToggleRow(
            title = "Show cost and profit on rows",
            subtitle = "Off by default — sourcing happens in public.",
            checked = state.showCostOnRows,
            onChange = viewModel::setShowCostOnRows,
        )
        ToggleRow(
            title = "Confirm bulk actions",
            subtitle = "Ask before changing several items at once.",
            checked = state.confirmBulkActions,
            onChange = viewModel::setConfirmBulkActions,
        )
        ToggleRow(
            title = "Haptic feedback",
            subtitle = "Vibrate on section changes and key actions.",
            checked = state.hapticsEnabled,
            onChange = viewModel::setHapticsEnabled,
        )
        ToggleRow(
            title = "Background refresh",
            subtitle = "Check for sales and finished grades about every 30 minutes.",
            checked = state.backgroundRefreshEnabled,
            onChange = viewModel::setBackgroundRefreshEnabled,
        )
        ToggleRow(
            title = "Share usage analytics",
            // Precise about the split: crash reports are how we find the bug
            // that lost someone's photos, and conflating the two would make
            // opting out of product analytics feel riskier than it is.
            subtitle = "Product analytics only. Crash reports are always sent.",
            checked = state.analyticsEnabled,
            onChange = viewModel::setAnalyticsEnabled,
        )

        // ── Security ─────────────────────────────────────────────────────────
        SectionHeader("Security")
        SettingRow(
            title = "Change password",
            subtitle = "We'll email you a link to set a new one.",
            enabled = !state.busy,
            onClick = viewModel::changePassword,
        )

        // ── Help ─────────────────────────────────────────────────────────────
        SectionHeader("Help")
        SettingRow(
            title = "Support requests",
            subtitle = "Open a request and read our replies",
            onClick = onOpenSupport,
        )
        // US-1387: the sheet's ViewModel is hoisted to THIS screen, so closing
        // the sheet to go and check a version number does not throw away what
        // was typed.
        SettingRow(
            title = "Send feedback",
            subtitle = "Tell us what worked, what didn't, what you wish existed",
            onClick = feedbackViewModel::open,
        )

        // ── Diagnostics ──────────────────────────────────────────────────────
        SectionHeader("Diagnostics")
        SettingRow(
            title = "App version",
            subtitle = "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
        )
        // The endpoint, not the keys: which backend a build points at is a
        // routing fact worth seeing in a support thread, and it's already public
        // (CLAUDE.md). Anything secret stays out of this screen.
        SettingRow(title = "Edge endpoint", subtitle = AppConfig.edgeApiUrl)

        // ── Danger zone ──────────────────────────────────────────────────────
        SectionHeader("Account actions")
        Column(Modifier.fillMaxWidth().padding(Spacing.md)) {
            BrandDestructiveButton(
                text = "Sign out",
                enabled = !state.busy,
                modifier = Modifier.fillMaxWidth().padding(bottom = Spacing.xs),
            ) { viewModel.ask(SettingsViewModel.Confirm.SIGN_OUT) }
            TextButton(
                onClick = { viewModel.ask(SettingsViewModel.Confirm.DELETE_ACCOUNT) },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Delete account") }
        }
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
                title = { Text("Sign out?") },
                text = {
                    Text(
                        // Says what it costs. Anything not yet synced is lost, and
                        // the seller is the only one who can decide whether to
                        // wait for signal first.
                        "This clears the copy of your inventory, sales and queued " +
                            "changes stored on this device. Anything that hasn't synced " +
                            "yet will be lost.",
                    )
                },
                confirmButton = {
                    TextButton(onClick = viewModel::confirmSignOut) { Text("Sign out") }
                },
                dismissButton = {
                    TextButton(onClick = viewModel::cancelConfirm) { Text("Cancel") }
                },
            )

            SettingsViewModel.Confirm.DELETE_ACCOUNT -> AlertDialog(
                onDismissRequest = viewModel::cancelConfirm,
                title = { Text("Delete your account?") },
                text = {
                    Text(
                        "This removes your account, your inventory and your grade history " +
                            "permanently. It can't be undone.",
                    )
                },
                confirmButton = {
                    TextButton(onClick = viewModel::confirmDeleteAccount) { Text("Continue") }
                },
                dismissButton = {
                    TextButton(onClick = viewModel::cancelConfirm) { Text("Cancel") }
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
    Row(
        Modifier
            .fillMaxWidth()
            // The whole row toggles, not just the switch: a 32dp switch is a
            // miss-prone target next to a two-line label.
            .clickable { onChange(!checked) }
            .padding(horizontal = Spacing.md, vertical = Spacing.xs)
            .semantics { contentDescription = "$title, ${if (checked) "on" else "off"}" },
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
