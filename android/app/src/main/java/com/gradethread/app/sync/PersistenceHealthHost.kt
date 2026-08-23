package com.gradethread.app.sync

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import com.gradethread.app.R
import com.gradethread.app.ui.theme.Spacing

/**
 * US-2792: the "couldn't save on this device" notice.
 *
 * PersistenceHealth has published [PersistenceHealth.noticeNeeded] since
 * US-1322 with nothing subscribed to it, so a Room write failing on a full disk
 * was counted, breadcrumbed, and shown to nobody. This is the missing half.
 *
 * Shaped after PlanGateHost, and for the same reason its comment gives: a
 * condition that can be raised from anywhere belongs in one shell-level host
 * rather than in every screen that might be on top when it happens. It renders
 * NOTHING until the failures are persistent, so it costs a state read.
 *
 * Dismissing calls [PersistenceHealth.acknowledgeNotice], which resets the
 * counter — so the notice re-arms only on NEW trouble rather than reappearing
 * on the next recomposition.
 */
@Composable
fun PersistenceHealthHost(modifier: Modifier = Modifier) {
    val needed by PersistenceHealth.noticeNeeded.collectAsState()
    if (!needed) return

    Row(
        modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.errorContainer)
            .padding(horizontal = Spacing.md, vertical = Spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            stringResource(R.string.persistence_notice),
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
            color = MaterialTheme.colorScheme.onErrorContainer,
            modifier = Modifier.weight(1f),
        )
        // Acknowledge rather than snooze: the count resets, so this reappears
        // only if saving fails again. A timed snooze would hide a disk that is
        // still full.
        TextButton(onClick = PersistenceHealth::acknowledgeNotice) {
            Text(stringResource(R.string.common_ok))
        }
    }
}
