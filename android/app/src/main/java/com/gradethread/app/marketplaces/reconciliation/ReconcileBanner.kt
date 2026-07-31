package com.gradethread.app.marketplaces.reconciliation

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.R
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1356: the tab-independent "you have unmatched eBay listings" banner.
 *
 * Renders nothing when the queue is empty or the seller snoozed it, so it costs
 * no space in the normal case.
 */
@Composable
fun ReconcileBanner(
    onOpen: () -> Unit,
    viewModel: ReconcileBannerViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    LaunchedEffect(Unit) { viewModel.refresh() }

    if (!state.visible(System.currentTimeMillis())) return

    Row(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.secondaryContainer)
            .padding(horizontal = Spacing.md, vertical = Spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            state.count.label,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
            color = MaterialTheme.colorScheme.onSecondaryContainer,
            modifier = Modifier.weight(1f),
        )
        TextButton(onClick = onOpen) { Text(stringResource(R.string.reconcile_banner_open)) }
        // Dismiss, not hide-forever: it comes back tomorrow, and sooner if more
        // unmatched listings appear.
        TextButton(onClick = viewModel::snooze) { Text(stringResource(R.string.common_later)) }
    }
}
