package com.gradethread.app.sync

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.ui.shell.SyncStatusBar

/**
 * US-2792: mounts [SyncStatusBar], which has rendered nowhere since US-1322.
 *
 * A thin seam on purpose. SyncStatusBar is a pure composable over
 * (status, pendingCount, stuckCount) and stays that way — testable, previewable,
 * and unaware of Hilt. This supplies the three values and nothing else.
 *
 * The bar returns early for IDLE, so this costs a state read when there is
 * nothing to say.
 *
 * Signature shape follows ReconcileBanner and detekt's Compose rules: modifier
 * first among the defaulted parameters, and the ViewModel acquired in a DEFAULT
 * ARGUMENT rather than in the body, so a caller (or a preview, or a test) can
 * pass its own without Hilt.
 */
@Composable
fun SyncStatusHost(
    modifier: Modifier = Modifier,
    onInspect: (() -> Unit)? = null,
    viewModel: SyncStatusViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()

    SyncStatusBar(
        status = state.status,
        pendingCount = state.pendingCount,
        stuckCount = state.stuckCount,
        onInspect = onInspect,
        modifier = modifier,
    )
}
