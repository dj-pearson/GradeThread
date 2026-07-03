package com.gradethread.app.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.gradethread.app.sync.SyncStatus
import com.gradethread.app.ui.theme.BrandPalette
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1322: the slim shell banner reflecting sync state (iOS SyncStatusBar).
 * Renders NOTHING when idle — quiet by default. Tapping a pending/attention
 * row opens the pending-changes inspector (wired by its story).
 */
@Composable
fun SyncStatusBar(
    status: SyncStatus,
    pendingCount: Int,
    stuckCount: Int,
    onInspect: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val descriptor = descriptorFor(status, pendingCount, stuckCount) ?: return
    val tappable = onInspect != null && (status == SyncStatus.PENDING || status == SyncStatus.NEEDS_ATTENTION)

    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(descriptor.background)
            .let { if (tappable) it.clickable { onInspect?.invoke() } else it }
            .padding(horizontal = Spacing.md, vertical = Spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = descriptor.icon,
            contentDescription = null,
            tint = descriptor.foreground,
            modifier = Modifier.size(16.dp).padding(end = 4.dp),
        )
        Text(
            descriptor.label,
            style = MaterialTheme.typography.labelMedium,
            color = descriptor.foreground,
        )
    }
}

private data class Descriptor(
    val label: String,
    val icon: ImageVector,
    val background: androidx.compose.ui.graphics.Color,
    val foreground: androidx.compose.ui.graphics.Color,
)

private fun descriptorFor(
    status: SyncStatus,
    pendingCount: Int,
    stuckCount: Int,
): Descriptor? = when (status) {
    SyncStatus.IDLE -> null
    SyncStatus.NEEDS_ATTENTION -> Descriptor(
        label = "$stuckCount change${if (stuckCount == 1) "" else "s"} need attention",
        icon = Icons.Outlined.Warning,
        background = BrandPalette.Red.copy(alpha = 0.15f),
        foreground = BrandPalette.Red,
    )
    SyncStatus.SYNCING -> Descriptor(
        label = "Syncing…",
        icon = Icons.Outlined.Refresh,
        background = BrandPalette.Navy.copy(alpha = 0.10f),
        foreground = BrandPalette.Navy,
    )
    SyncStatus.PENDING -> Descriptor(
        label = "$pendingCount change${if (pendingCount == 1) "" else "s"} waiting to sync",
        icon = Icons.Outlined.Info,
        background = BrandPalette.Amber.copy(alpha = 0.15f),
        foreground = BrandPalette.Amber,
    )
    SyncStatus.OFFLINE -> Descriptor(
        label = if (pendingCount > 0) "Offline — $pendingCount change${if (pendingCount == 1) "" else "s"} queued" else "Offline",
        icon = Icons.Outlined.Info,
        background = BrandPalette.Night.copy(alpha = 0.10f),
        foreground = BrandPalette.Night,
    )
    SyncStatus.RECONNECTING -> Descriptor(
        label = "Reconnecting…",
        icon = Icons.Outlined.Refresh,
        background = BrandPalette.Navy.copy(alpha = 0.10f),
        foreground = BrandPalette.Navy,
    )
}
