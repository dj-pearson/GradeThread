package com.gradethread.app.ui.shell

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1313: branded placeholder a section shows until its feature story
 * lands. Deliberately minimal — the shell's job is navigation correctness;
 * content arrives with US-1314+.
 */
@Composable
fun SectionPlaceholder(name: String, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.fillMaxSize().padding(Spacing.xl),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(name, style = MaterialTheme.typography.titleMedium)
        Text(
            "Coming with its conversion story.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
