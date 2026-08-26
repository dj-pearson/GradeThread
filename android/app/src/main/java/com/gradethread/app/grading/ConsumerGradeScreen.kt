package com.gradethread.app.grading

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.R
import com.gradethread.app.ai.AiItemFields
import com.gradethread.app.billing.ConsumerCreditPackSheet
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing

/**
 * US-2815: grade one garment from photos, on Android.
 *
 * The Kotlin counterpart of iOS `ConsumerGradeView`, and the last piece of a
 * client whose every other half already existed on iOS and nowhere here.
 *
 * ONE SLOT PER REQUIRED SHOT rather than a free multi-select: the route rejects
 * duplicate image types, and it abstains when front/back/label is missing —
 * after charging, after a vision call per image, then refunding. Asking for the
 * three by name means the refusal happens here instead.
 */
@Composable
fun ConsumerGradeScreen(
    modifier: Modifier = Modifier,
    onViewGrade: (String) -> Unit = {},
    viewModel: ConsumerGradeViewModel = hiltViewModel(),
) {
    val step by viewModel.flow.step.collectAsState()
    val draft by viewModel.draft.collectAsState()
    // US-2802: which slot the camera is open for, or null.
    var cameraSlot by remember { mutableStateOf<String?>(null) }

    val slot = cameraSlot
    if (slot != null) {
        GradeCameraSheet(
            onCapture = { bytes ->
                viewModel.addCameraShot(bytes, slot)
                cameraSlot = null
            },
            onCancel = { cameraSlot = null },
            modifier = modifier,
        )
        return
    }

    if (step is ConsumerGradeFlow.Step.Ready) {
        // State hoisted rather than the ViewModel forwarded: DraftStep takes
        // values and callbacks, so it previews and tests without Hilt.
        DraftStep(
            draft = draft,
            onTitleChange = viewModel::setTitle,
            onTypeChange = viewModel::setType,
            onCategoryChange = viewModel::setCategory,
            onPick = viewModel::addShot,
            onTakePhoto = { cameraSlot = it },
            onSubmit = viewModel::submit,
            modifier = modifier,
        )
    } else {
        ProgressStep(
            step = step,
            onViewGrade = onViewGrade,
            onPurchase = viewModel::creditsPurchased,
            onRecheck = viewModel::recheckCredits,
            modifier = modifier,
        )
    }
}

@Composable
private fun DraftStep(
    draft: ConsumerGradeViewModel.Draft,
    onTitleChange: (String) -> Unit,
    onTypeChange: (String) -> Unit,
    onCategoryChange: (String) -> Unit,
    onPick: (android.net.Uri, String) -> Unit,
    onTakePhoto: (String) -> Unit,
    onSubmit: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // remember, not a plain var: a composable body re-runs, and a bare local
    // would be null again by the time the picker calls back — every pick would
    // land in no slot at all.
    var pendingSlot by remember { mutableStateOf<String?>(null) }

    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia(),
    ) { uri ->
        val slot = pendingSlot
        pendingSlot = null
        if (uri != null && slot != null) onPick(uri, slot)
    }

    LazyColumn(
        modifier = modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        item {
            OutlinedTextField(
                value = draft.title,
                onValueChange = onTitleChange,
                label = { Text(stringResource(R.string.consumergrade_title_label)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        item {
            VocabularyRow(stringResource(R.string.consumergrade_kind), Vocabulary.TYPE, draft.garmentType, onTypeChange)
        }

        item {
            VocabularyRow(
                stringResource(R.string.consumergrade_garment),
                Vocabulary.CATEGORY,
                draft.garmentCategory,
                onCategoryChange,
            )
        }

        items(PhotoGradeContract.requiredGradingTypes) { slot ->
            Row(
                Modifier.fillMaxWidth().padding(vertical = Spacing.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    PhotoGradeError.friendlyName(slot).replaceFirstChar { it.uppercase() },
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { onTakePhoto(slot) }) { Text(stringResource(R.string.consumergrade_take)) }
                TextButton(onClick = {
                    pendingSlot = slot
                    picker.launch(
                        PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                    )
                }) {
                    Text(
                        stringResource(
                            if (draft.shots.containsKey(slot)) {
                                R.string.consumergrade_replace
                            } else {
                                R.string.consumergrade_library
                            },
                        ),
                    )
                }
            }
        }

        item {
            // Named BEFORE paying. The route's abstain refunds the money and not
            // the vision spend, and by then the person has already waited.
            Text(
                if (draft.missing.isEmpty()) {
                    stringResource(R.string.consumergrade_ready)
                } else {
                    stringResource(
                        R.string.consumergrade_still_needed,
                        draft.missing.joinToString(", ") { PhotoGradeError.friendlyName(it) },
                    )
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        item {
            // US-2802: a STATUS, not an advert. Live Capture is earned by how
            // the photos were taken, so the honest thing to show is which
            // side of that line this submission is on.
            Text(
                stringResource(
                    if (draft.isLiveCapture) {
                        R.string.consumergrade_live_capture_earned
                    } else {
                        R.string.consumergrade_live_capture_hint
                    },
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        if (draft.loadFailed) {
            item {
                Text(
                    stringResource(R.string.consumergrade_photo_unreadable),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }

        item {
            Button(
                onClick = onSubmit,
                enabled = draft.canSubmit,
                modifier = Modifier.fillMaxWidth().padding(top = Spacing.sm),
            ) {
                Text(stringResource(R.string.consumergrade_submit))
            }
        }
    }
}

/** Which vocabulary a row offers. */
private enum class Vocabulary { TYPE, CATEGORY }

/**
 * A compact chooser.
 *
 * Takes the ENUM rather than a `List<String>`: the Compose compiler cannot infer
 * the stability of a List parameter even when its items are stable, so passing
 * one makes every recomposition of this row unskippable. Resolving the list
 * inside keeps the signature stable, and the values are constants anyway.
 */
@Composable
private fun VocabularyRow(
    label: String,
    vocabulary: Vocabulary,
    selected: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val values = when (vocabulary) {
        Vocabulary.TYPE -> AiItemFields.garmentTypes
        Vocabulary.CATEGORY -> AiItemFields.garmentCategories
    }
    Column(modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.labelMedium)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            values.take(VISIBLE_VALUES).forEach { value ->
                TextButton(onClick = { onSelect(value) }) {
                    Text(
                        value,
                        fontWeight = if (value == selected) FontWeight.Bold else FontWeight.Normal,
                    )
                }
            }
        }
    }
}

private const val VISIBLE_VALUES = 4

/**
 * The non-ready half.
 *
 * THE MONEY PART GOES FIRST IN THE STATES THAT ARE NOT CHARGES: an abstain and
 * a credits prompt are both no-charge and both are commonly read as failures.
 */
@Composable
private fun ProgressStep(
    step: ConsumerGradeFlow.Step,
    onViewGrade: (String) -> Unit,
    onPurchase: (String) -> Unit,
    onRecheck: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier.fillMaxSize().padding(Spacing.lg),
        verticalArrangement = Arrangement.spacedBy(Spacing.md),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        when (step) {
            is ConsumerGradeFlow.Step.Ready -> Unit

            is ConsumerGradeFlow.Step.Uploading -> {
                // Determinate: the one phase with a real number.
                LinearProgressIndicator(
                    progress = { step.fraction.toFloat() },
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(stringResource(R.string.consumergrade_uploading))
            }

            is ConsumerGradeFlow.Step.Paying -> Busy(stringResource(R.string.consumergrade_checking_grades))

            // US-2830: a price and a way to pay it. This used to be the
            // notice alone — the flow quoted a pack size and offered no
            // control of any kind, after the seller had already uploaded
            // every photo.
            is ConsumerGradeFlow.Step.NeedsCredits -> {
                Notice(
                    title = stringResource(R.string.consumergrade_out_of_grades),
                    body = step.offer?.let {
                        stringResource(R.string.consumergrade_pack_covers_this, it.credits)
                    } ?: stringResource(R.string.consumergrade_top_up),
                )
                ConsumerCreditPackSheet(
                    onPurchase = { onPurchase(step.submissionId) },
                )
            }

            // NOT a bare spinner: the purchase completed on the device and the
            // balance moves server-side, so someone who just paid is owed a
            // sentence.
            is ConsumerGradeFlow.Step.AwaitingCredits ->
                Busy(stringResource(R.string.consumergrade_purchase_received))

            is ConsumerGradeFlow.Step.CreditsDelayed -> {
                Notice(
                    title = stringResource(R.string.consumergrade_credits_delayed_title),
                    body = stringResource(R.string.consumergrade_credits_delayed_body),
                )
                // The state says "check again" and, until now, gave nobody
                // anything to check with. A grant that missed the poll
                // window is not a failure and may already have landed.
                BrandSecondaryButton(
                    text = stringResource(R.string.consumergrade_check_again),
                    modifier = Modifier.fillMaxWidth(),
                ) { onRecheck(step.submissionId) }
            }

            // Indeterminate on purpose: the server sends nothing until it is
            // done, so a percentage here would be invented.
            is ConsumerGradeFlow.Step.Grading ->
                Busy(step.statusText.ifEmpty { stringResource(R.string.consumergrade_grading) })

            is ConsumerGradeFlow.Step.NeedsPhotos -> Notice(
                title = stringResource(R.string.consumergrade_needs_photos_title),
                body = step.messages.firstOrNull()
                    ?: stringResource(R.string.consumergrade_needs_photos_body),
            )

            is ConsumerGradeFlow.Step.Graded -> {
                Text(
                    stringResource(R.string.consumergrade_graded),
                    style = MaterialTheme.typography.titleMedium,
                )
                Button(onClick = { onViewGrade(step.submissionId) }) {
                    Text(stringResource(R.string.consumergrade_see_grade))
                }
            }

            is ConsumerGradeFlow.Step.Failed -> Notice(
                title = stringResource(R.string.consumergrade_failed_title),
                body = step.message,
            )
        }
    }
}

@Composable
private fun Busy(label: String, modifier: Modifier = Modifier) {
    Column(
        modifier,
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator()
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/**
 * Every caller above is a no-charge state, so the reassurance is unconditional
 * here rather than a parameter — and a future state that DOES follow a charge
 * must not reuse this without changing it.
 */
@Composable
private fun Notice(title: String, body: String, modifier: Modifier = Modifier) {
    Column(
        modifier,
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(title, style = MaterialTheme.typography.titleSmall)
        Text(body, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(
            stringResource(R.string.consumergrade_not_charged),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
