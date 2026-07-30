package com.gradethread.app.disclosure

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.ui.components.InfoCard
import com.gradethread.app.ui.components.InfoTone
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-1360: show the graded flaws, mark them on the photo, and put the
 * disclosure in front of the buyer.
 */
@Composable
fun DisclosureScreen(
    itemId: String,
    onClose: () -> Unit = {},
    viewModel: DisclosureViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    LaunchedEffect(itemId) { viewModel.bind(itemId) }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text("Flaw disclosure", style = MaterialTheme.typography.titleLarge)

        state.errorMessage?.let { InfoCard("That didn't work", it, tone = InfoTone.Error) }
        state.banner?.let { InfoCard("Done", it, tone = InfoTone.Success) }

        when {
            state.loading -> Hint("Loading…")

            // Not graded is a different answer from "no flaws found", and the
            // fix is different too — grade the item first.
            state.data?.graded != true -> Hint(
                "This item hasn't been graded yet. Grade it and its flaws show up here.",
            )

            !state.hasDefects -> Hint("The grade found no flaws worth disclosing.")

            else -> {
                state.data?.disclosure?.plain?.takeIf { it.isNotBlank() }?.let { text ->
                    Column(
                        Modifier.fillMaxWidth().cardStyle(),
                        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
                    ) {
                        Text(
                            "${state.defectCount} noted",
                            style = MaterialTheme.typography.bodyLarge,
                        )
                        Text(text, style = MaterialTheme.typography.bodyMedium)
                    }
                }

                if (state.annotatable.isEmpty()) {
                    Hint(
                        "The grade couldn't place these flaws on a photo, so there's " +
                            "nothing to mark up — the written disclosure still applies.",
                    )
                } else {
                    Text("Photos", style = MaterialTheme.typography.titleMedium)
                    Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
                        state.annotatable.forEach { photo ->
                            FilterChip(
                                selected = state.selected?.id == photo.id,
                                onClick = { viewModel.select(photo) },
                                label = {
                                    Text("${photo.imageType} (${photo.annotations.size})")
                                },
                            )
                        }
                    }

                    when {
                        state.rendering -> Hint("Marking up the photo…")
                        state.preview != null -> Image(
                            bitmap = state.preview!!.asImageBitmap(),
                            contentDescription = "Photo with ${
                                state.selected?.annotations?.size ?: 0
                            } flaws marked",
                            contentScale = ContentScale.FitWidth,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }

                    BrandSecondaryButton(
                        text = "Save this annotated photo",
                        enabled = state.preview != null && !state.busy,
                        modifier = Modifier.fillMaxWidth(),
                    ) { viewModel.saveAnnotated() }
                }

                BrandPrimaryButton(
                    text = if (state.busy) "Working…" else "Add to the live eBay listing",
                    enabled = !state.busy,
                    modifier = Modifier.fillMaxWidth(),
                ) { viewModel.applyToListing() }
                Hint("This edits the description buyers see on the live listing.")
            }
        }

        BrandSecondaryButton(text = "Back", modifier = Modifier.fillMaxWidth()) { onClose() }
    }
}

@Composable
private fun Hint(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}
