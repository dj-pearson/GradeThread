package com.gradethread.app.plangate

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1367 AC3: the shell-level plan gate.
 *
 * Placed once, above the section content, so a 402 raised by any request in any
 * tab reaches the seller. The interceptor that feeds it
 * ([com.gradethread.app.platform.net.PlanGateNotifier]) has been publishing
 * since US-1306 with nothing subscribed — the signals existed and went nowhere.
 */
@Composable
fun PlanGateHost(
    onUpgrade: () -> Unit,
    viewModel: PlanGateViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()

    state.warning?.let { warning ->
        Row(
            Modifier
                .fillMaxWidth()
                .background(MaterialTheme.colorScheme.tertiaryContainer)
                .padding(horizontal = Spacing.md, vertical = Spacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(
                Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
            ) {
                Text(
                    PlanGatePresentation.warningMessage(warning),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                    color = MaterialTheme.colorScheme.onTertiaryContainer,
                )
                LinearProgressIndicator(
                    progress = { PlanGatePresentation.progress(warning) },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            TextButton(onClick = onUpgrade) { Text("Upgrade") }
            // "Later", not "never": the allowance keeps filling, and the wall is
            // still coming.
            TextButton(onClick = viewModel::dismissWarning) { Text("Later") }
        }
    }

    state.gate?.let { gate ->
        AlertDialog(
            onDismissRequest = viewModel::dismissGate,
            title = { Text(gate.title) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                    gate.usageDetail?.let { Text(it) }
                    Text(gate.recommendation)
                }
            },
            confirmButton = {
                if (PlanGatePresentation.offersUpgrade(gate)) {
                    TextButton(
                        onClick = {
                            viewModel.dismissGate()
                            onUpgrade()
                        },
                    ) { Text("See plans") }
                }
            },
            dismissButton = {
                TextButton(onClick = viewModel::dismissGate) { Text("Not now") }
            },
        )
    }
}
