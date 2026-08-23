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
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.ai.AiItemFields
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

    if (step is ConsumerGradeFlow.Step.Ready) {
        // State hoisted rather than the ViewModel forwarded: DraftStep takes
        // values and callbacks, so it previews and tests without Hilt.
        DraftStep(
            draft = draft,
            onTitleChange = viewModel::setTitle,
            onTypeChange = viewModel::setType,
            onCategoryChange = viewModel::setCategory,
            onPick = viewModel::addShot,
            onSubmit = viewModel::submit,
            modifier = modifier,
        )
    } else {
        ProgressStep(step, onViewGrade, modifier)
    }
}

@Composable
private fun DraftStep(
    draft: ConsumerGradeViewModel.Draft,
    onTitleChange: (String) -> Unit,
    onTypeChange: (String) -> Unit,
    onCategoryChange: (String) -> Unit,
    onPick: (android.net.Uri, String) -> Unit,
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
                label = { Text("What is it?") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        item {
            VocabularyRow("Kind", Vocabulary.TYPE, draft.garmentType, onTypeChange)
        }

        item {
            VocabularyRow("Garment", Vocabulary.CATEGORY, draft.garmentCategory, onCategoryChange)
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
                TextButton(onClick = {
                    pendingSlot = slot
                    picker.launch(
                        PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                    )
                }) {
                    Text(if (draft.shots.containsKey(slot)) "Replace" else "Add")
                }
            }
        }

        item {
            // Named BEFORE paying. The route's abstain refunds the money and not
            // the vision spend, and by then the person has already waited.
            Text(
                if (draft.missing.isEmpty()) {
                    "Ready to grade."
                } else {
                    "Still needed: " +
                        draft.missing.joinToString(", ") { PhotoGradeError.friendlyName(it) }
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        if (draft.loadFailed) {
            item {
                Text(
                    "That photo could not be read. Try another.",
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
                Text("Grade this garment")
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
                Text("Uploading photos")
            }

            is ConsumerGradeFlow.Step.Paying -> Busy("Checking your grades")

            is ConsumerGradeFlow.Step.NeedsCredits -> Notice(
                title = "You are out of grades",
                body = step.offer?.let { "A ${it.credits}-grade pack covers this one." }
                    ?: "Top up to grade this garment.",
            )

            // NOT a bare spinner: the purchase completed on the device and the
            // balance moves server-side, so someone who just paid is owed a
            // sentence.
            is ConsumerGradeFlow.Step.AwaitingCredits ->
                Busy("Purchase received, adding your grades")

            is ConsumerGradeFlow.Step.CreditsDelayed -> Notice(
                title = "Your grades are taking a moment",
                body = "The purchase went through. This usually lands within a minute.",
            )

            // Indeterminate on purpose: the server sends nothing until it is
            // done, so a percentage here would be invented.
            is ConsumerGradeFlow.Step.Grading ->
                Busy(step.statusText.ifEmpty { "Grading" })

            is ConsumerGradeFlow.Step.NeedsPhotos -> Notice(
                title = "We need a clearer set",
                body = step.messages.firstOrNull() ?: "Retake the flagged shots and try again.",
            )

            is ConsumerGradeFlow.Step.Graded -> {
                Text("Graded", style = MaterialTheme.typography.titleMedium)
                Button(onClick = { onViewGrade(step.submissionId) }) { Text("See the grade") }
            }

            is ConsumerGradeFlow.Step.Failed -> Notice(
                title = "That did not go through",
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
            "You have not been charged.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
