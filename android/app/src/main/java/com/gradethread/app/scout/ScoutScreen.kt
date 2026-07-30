package com.gradethread.app.scout

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.AssistChip
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.marketplaces.CustomTabsLauncher
import com.gradethread.app.ui.components.InfoCard
import com.gradethread.app.ui.components.InfoTone
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-1374: ScoutAI — grade what you don't own.
 */
@Composable
fun ScoutScreen(
    onOpenProspect: () -> Unit = {},
    onClose: () -> Unit = {},
    viewModel: ScoutViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    val context = LocalContext.current

    Column(
        Modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text("Scout", style = MaterialTheme.typography.titleLarge)
        Text(
            "Search live eBay listings. Each one is graded from its own photos and " +
                "ranked by what you'd make on it.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        OutlinedTextField(
            value = state.keyword,
            onValueChange = viewModel::setKeyword,
            label = { Text("Keyword") },
            singleLine = true,
            enabled = !state.scanning,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = state.brand,
            onValueChange = viewModel::setBrand,
            label = { Text("Brand (optional)") },
            singleLine = true,
            enabled = !state.scanning,
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            // Shows which category the scan actually used, so a bad
            // auto-resolution is visible rather than blamed on the results.
            "Searching in ${state.categoryLabel}",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        state.errorMessage?.let {
            InfoCard(
                if (state.planWall != null) "Not on your plan" else "That didn't work",
                it,
                tone = if (state.planWall != null) InfoTone.Warning else InfoTone.Error,
            )
        }

        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(Spacing.xxs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ScoutSort.entries.forEach { option ->
                FilterChip(
                    selected = option == state.sort,
                    onClick = { viewModel.setSort(option) },
                    label = { Text(option.label) },
                )
            }
            FilterChip(
                selected = state.actionableOnly,
                onClick = viewModel::toggleActionableOnly,
                label = { Text("Worth buying") },
            )
        }

        Text(state.summary, style = MaterialTheme.typography.bodySmall)

        LazyColumn(
            Modifier.fillMaxWidth().weight(1f),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            items(state.candidates, key = { it.itemId }) { candidate ->
                CandidateCard(candidate) {
                    candidate.itemWebUrl?.let { CustomTabsLauncher.open(context, it) }
                }
            }
            state.response?.disclaimer?.let { disclaimer ->
                item {
                    Text(
                        disclaimer,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        BrandPrimaryButton(
            // The retry is hidden on a plan wall: tapping it would hit the same
            // wall, and a button that never works reads as a broken app.
            text = if (state.scanning) "Scanning…" else "Scan",
            enabled = state.canScan && state.planWall == null,
            modifier = Modifier.fillMaxWidth(),
        ) { viewModel.scan() }
        BrandSecondaryButton(text = "Prospect in store", modifier = Modifier.fillMaxWidth()) {
            onOpenProspect()
        }
        BrandSecondaryButton(text = "Back", modifier = Modifier.fillMaxWidth()) { onClose() }
    }
}

@Composable
private fun CandidateCard(candidate: ScoutCandidate, onOpen: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().clickable { onOpen() }.cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                candidate.title,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
                maxLines = 2,
                modifier = Modifier.weight(1f),
            )
            if (candidate.actionable) {
                AssistChip(onClick = {}, label = { Text("Worth buying") })
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
            Column(Modifier.weight(1f)) {
                Text("Asking", style = MaterialTheme.typography.labelSmall)
                Text(candidate.askingLabel, style = MaterialTheme.typography.bodyMedium)
            }
            Column(Modifier.weight(1f)) {
                Text("Sells for", style = MaterialTheme.typography.labelSmall)
                Text(candidate.valueLabel, style = MaterialTheme.typography.bodyMedium)
            }
            Column(Modifier.weight(1f)) {
                Text("Profit", style = MaterialTheme.typography.labelSmall)
                Text(
                    candidate.marginLabel,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = if (candidate.underpriced) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.onSurface
                    },
                )
            }
        }
        Text(
            // The grade is shown WITH its confidence, always. A 9.2 read off a
            // stranger's blurry photo is not the same claim as a 9.2 from a
            // proper set, and hiding that gap is how someone overpays.
            "Grade ${candidate.gradeLabel} · " +
                "${Math.round(candidate.gradeConfidence * 100)}% confident",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (candidate.reason.isNotBlank()) {
            Text(
                candidate.reason,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
