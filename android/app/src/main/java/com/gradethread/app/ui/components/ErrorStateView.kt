package com.gradethread.app.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.GradeThreadTheme
import com.gradethread.app.ui.theme.Spacing
import kotlinx.coroutines.launch

/**
 * US-1303: the shared "couldn't load" state with an always-visible retry
 * (iOS ErrorStateView, US-971). Data screens render this in their failed
 * branch so the user recovers in place instead of backing out. The retry is
 * suspend: the button shows a spinner and disables itself while it runs (a
 * double-tap can't fire two loads); the parent store is expected to move its
 * phase off failed on success, swapping this view out.
 */
@Composable
fun ErrorStateView(
    message: String,
    modifier: Modifier = Modifier,
    title: String = "Couldn't load",
    icon: ImageVector = Icons.Outlined.Warning,
    retryTitle: String = "Try again",
    secondaryTitle: String? = null,
    onSecondary: (() -> Unit)? = null,
    retry: suspend () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var isRetrying by remember { mutableStateOf(false) }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(Spacing.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(40.dp),
        )
        Text(title, style = MaterialTheme.typography.headlineSmall)
        Text(
            message,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        if (isRetrying) {
            CircularProgressIndicator(modifier = Modifier.size(24.dp))
        } else {
            BrandSecondaryButton(text = retryTitle) {
                scope.launch {
                    isRetrying = true
                    try {
                        retry()
                    } finally {
                        isRetrying = false
                    }
                }
            }
        }
        if (secondaryTitle != null && onSecondary != null) {
            TextButton(onClick = onSecondary, enabled = !isRetrying) {
                Text(secondaryTitle)
            }
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun ErrorStatePreview() {
    GradeThreadTheme {
        ErrorStateView(
            message = "Check your connection and try again.",
            secondaryTitle = "Back",
            onSecondary = {},
        ) {}
    }
}
