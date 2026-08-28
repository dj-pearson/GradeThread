package com.gradethread.app.platform.applock

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.gradethread.app.R
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.GradeThreadTheme
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1315: the opaque lock cover — replaces the shell entirely while locked
 * so nothing financial is composed underneath. Auto-prompts once on entry;
 * the button re-prompts after a cancel/failure.
 */
@Composable
fun LockScreen(onUnlock: () -> Unit) {
    LaunchedEffect(Unit) { onUnlock() }
    Surface(modifier = Modifier.fillMaxSize()) {
        Column(
            // US-2891: mandatory edge-to-edge at API 36. The lock cover is
            // composed by MainActivity with no Scaffold above it, so it owns
            // its own insets; the content is centred today, but a display
            // cutout or a taller status bar would still clip the icon.
            modifier = Modifier.fillMaxSize().safeDrawingPadding().padding(Spacing.xl),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Icon(
                imageVector = Icons.Outlined.Lock,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(48.dp),
            )
            Text(
                stringResource(R.string.applock_locked),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(top = Spacing.md),
            )
            BrandPrimaryButton(
                text = stringResource(R.string.applock_unlock),
                modifier = Modifier.padding(top = Spacing.lg),
            ) { onUnlock() }
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun LockScreenPreview() {
    GradeThreadTheme {
        LockScreen(onUnlock = {})
    }
}
