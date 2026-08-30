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
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
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
fun DisclosureScreen(itemId: String, onClose: () -> Unit = {}, viewModel: DisclosureViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()
    LaunchedEffect(itemId) { viewModel.bind(itemId) }

    DisclosureContent(
        state = state,
        actions = DisclosureActions(
            select = viewModel::select,
            saveAnnotated = viewModel::saveAnnotated,
            applyToListing = viewModel::applyToListing,
            close = onClose,
        ),
    )
}

/**
 * Everything the disclosure screen can do (US-2902 AC3).
 *
 * `bind` is NOT here on purpose. It is a LaunchedEffect keyed on itemId - a
 * lifecycle concern belonging to the wrapper, not an action a person takes -
 * and putting it in this record would invite a golden to call it and load
 * nothing.
 */
@Immutable
data class DisclosureActions(
    val select: (DisclosurePhoto) -> Unit = {},
    val saveAnnotated: () -> Unit = {},
    val applyToListing: () -> Unit = {},
    val close: () -> Unit = {},
)

/**
 * The condition-disclosure screen with no ViewModel attached (US-2902 AC3).
 *
 * ⚠ WORTH CAPTURING BECAUSE OF WHAT IT IS. This is the screen that decides what
 * a BUYER is told about a garment's flaws. A layout regression here does not
 * cost a seller a click - it changes what was disclosed, on the record, for an
 * item someone has already bought. Nothing else in the app has that property.
 *
 * The layout is unchanged from the version inside DisclosureScreen; only the
 * callbacks are rebound.
 */
@Composable
fun DisclosureContent(state: DisclosureViewModel.State, actions: DisclosureActions, modifier: Modifier = Modifier) {
    Column(
        // Default is Modifier, so the chain is identical to the pre-extraction
        // one and the goldens recorded against it cannot have moved.
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(stringResource(R.string.disclosure_flaw_disclosure), style = MaterialTheme.typography.titleLarge)

        state.errorMessage?.let {
            InfoCard(stringResource(R.string.disclosure_that_didn_t_work), it, tone = InfoTone.Error)
        }
        state.banner?.let { InfoCard(stringResource(R.string.disclosure_done), it, tone = InfoTone.Success) }

        when {
            state.loading -> Hint(stringResource(R.string.disclosure_loading))

            // Not graded is a different answer from "no flaws found", and the
            // fix is different too — grade the item first.
            state.data?.graded != true -> Hint(
                stringResource(R.string.disclosure_not_graded),
            )

            !state.hasDefects -> Hint(stringResource(R.string.disclosure_no_flaws))

            else -> {
                state.data?.disclosure?.plain?.takeIf { it.isNotBlank() }?.let { text ->
                    Column(
                        Modifier.fillMaxWidth().cardStyle(),
                        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
                    ) {
                        Text(
                            pluralStringResource(R.plurals.disclosure_noted, state.defectCount, state.defectCount),
                            style = MaterialTheme.typography.bodyLarge,
                        )
                        Text(text, style = MaterialTheme.typography.bodyMedium)
                    }
                }

                if (state.annotatable.isEmpty()) {
                    Hint(
                        stringResource(R.string.disclosure_unplaced),
                    )
                } else {
                    Text(stringResource(R.string.disclosure_photos), style = MaterialTheme.typography.titleMedium)
                    Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
                        state.annotatable.forEach { photo ->
                            FilterChip(
                                selected = state.selected?.id == photo.id,
                                onClick = { actions.select(photo) },
                                label = {
                                    Text(
                                        stringResource(
                                            R.string.disclosure_photo_tab,
                                            photo.imageType,
                                            photo.annotations.size,
                                        ),
                                    )
                                },
                            )
                        }
                    }

                    when {
                        state.rendering -> Hint(stringResource(R.string.disclosure_rendering))
                        state.preview != null -> Image(
                            bitmap = state.preview!!.asImageBitmap(),
                            contentDescription = pluralStringResource(
                                R.plurals.disclosure_preview_spoken,
                                state.selected?.annotations?.size ?: 0,
                                state.selected?.annotations?.size ?: 0,
                            ),
                            contentScale = ContentScale.FillWidth,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }

                    BrandSecondaryButton(
                        text = stringResource(R.string.disclosure_save_this_annotated_photo),
                        enabled = state.preview != null && !state.busy,
                        modifier = Modifier.fillMaxWidth(),
                    ) { actions.saveAnnotated() }
                }

                BrandPrimaryButton(
                    text = stringResource(
                        if (state.busy) {
                            R.string.disclosure_working
                        } else {
                            R.string.disclosure_add_to_listing
                        },
                    ),
                    enabled = !state.busy,
                    modifier = Modifier.fillMaxWidth(),
                ) { actions.applyToListing() }
                Hint(stringResource(R.string.disclosure_edits_description))
            }
        }

        BrandSecondaryButton(text = stringResource(R.string.disclosure_back), modifier = Modifier.fillMaxWidth()) {
            actions.close()
        }
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
