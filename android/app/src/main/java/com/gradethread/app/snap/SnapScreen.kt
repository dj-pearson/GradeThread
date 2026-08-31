package com.gradethread.app.snap

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.hilt.navigation.compose.hiltViewModel
import coil.compose.AsyncImage
import com.gradethread.app.R
import com.gradethread.app.platform.rememberHapticFeedback
import com.gradethread.app.ui.text
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.gradeColor
import java.io.File

/**
 * US-1335: Snap-to-Value (iOS `SnapView`) — one photo in, an instant condition
 * grade and a resale range out, nudging toward a certified grade or a listing.
 */
@Composable
fun SnapScreen(
    onCertifiedGrade: () -> Unit,
    onList: () -> Unit,
    modifier: Modifier = Modifier,
    viewModel: SnapViewModel = hiltViewModel(),
) {
    val context = LocalContext.current
    val haptics = rememberHapticFeedback()
    val state by viewModel.state.collectAsState()

    // The system camera writes into our own files dir and we hand it a
    // content:// grant — no shared external storage, so nothing else on the
    // device can read the shot.
    var pendingCapture by remember { mutableStateOf<File?>(null) }
    var cameraDenied by remember { mutableStateOf(false) }

    val takePicture = rememberLauncherForActivityResult(
        ActivityResultContracts.TakePicture(),
    ) { saved ->
        val file = pendingCapture
        pendingCapture = null
        if (saved && file != null) viewModel.setPhoto(file)
    }

    fun launchCamera() {
        val dir = File(context.cacheDir, "snap-capture").apply { mkdirs() }
        val file = File(dir, "snap_${System.nanoTime()}.jpg")
        pendingCapture = file
        takePicture.launch(
            FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file),
        )
    }

    val requestCamera = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        // iOS US-1181: a previously-denied camera used to drop the user into
        // the system picker's blank denial state with no way out. Say what
        // happened and offer the one action that fixes it.
        if (granted) launchCamera() else cameraDenied = true
    }

    val pickPhoto = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia(),
    ) { uri -> uri?.let { viewModel.setPhoto(stageFromUri(context, it)) } }

    SnapContent(
        state,
        SnapActions(
            setBrand = viewModel::setBrand,
            setKeyword = viewModel::setKeyword,
            // The camera permission check, the FileProvider grant and the photo
            // picker all stay in the wrapper. None of them exists in a
            // screenshot test, and none of them is layout.
            takePhoto = {
                haptics.light()
                cameraDenied = false
                val granted = ContextCompat.checkSelfPermission(
                    context,
                    Manifest.permission.CAMERA,
                ) == PackageManager.PERMISSION_GRANTED
                if (granted) launchCamera() else requestCamera.launch(Manifest.permission.CAMERA)
            },
            pickPhoto = {
                haptics.light()
                pickPhoto.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
            },
            openSettings = {
                context.startActivity(
                    Intent(
                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", context.packageName, null),
                    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            },
            // Haptics move here with the gestures they belong to: a body that
            // is only layout should not be reaching for the vibrator.
            evaluate = {
                haptics.medium()
                viewModel.evaluate()
            },
            certifiedGrade = {
                haptics.medium()
                onCertifiedGrade()
            },
            list = {
                haptics.light()
                onList()
            },
        ),
        modifier = modifier,
        cameraDenied = cameraDenied,
    )
}

/** Everything this screen can be asked to do (US-2902 AC3). */
@Immutable
data class SnapActions(
    val setBrand: (String) -> Unit = {},
    val setKeyword: (String) -> Unit = {},
    val takePhoto: () -> Unit = {},
    val pickPhoto: () -> Unit = {},
    val openSettings: () -> Unit = {},
    val evaluate: () -> Unit = {},
    val certifiedGrade: () -> Unit = {},
    val list: () -> Unit = {},
)

/**
 * Snap to Value with no ViewModel attached (US-2902 AC3).
 *
 * ⚠ A PLAN WALL IS NOT A FAILURE, AND HERE THE BUTTON CHANGES. `isUpgradePrompt`
 * turns the error card's action from "try again" into the upgrade path,
 * because retrying a plan wall hits the same wall. Both render the same card
 * with the same message slot, so only a capture sees which button came out.
 *
 * ⚠ AND THE RESULT IS A VALUATION SOMEBODY ACTS ON. `hasHints` says whether the
 * seller narrowed it with a brand or keyword, which is the difference between
 * a confident answer and a guess off one photo.
 */
@Composable
fun SnapContent(
    state: SnapViewModel.State,
    actions: SnapActions,
    modifier: Modifier = Modifier,
    cameraDenied: Boolean = false,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Text(
            stringResource(R.string.snap_intro),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        PhotoArea(state.photo)

        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            BrandSecondaryButton(
                text = stringResource(R.string.snap_take_photo),
                modifier = Modifier.weight(1f),
                onClick = actions.takePhoto,
            )
            BrandSecondaryButton(
                text = stringResource(R.string.snap_library),
                modifier = Modifier.weight(1f),
                onClick = actions.pickPhoto,
            )
        }

        if (cameraDenied) {
            Column(Modifier.fillMaxWidth()) {
                Text(
                    stringResource(R.string.snap_camera_denied),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
                BrandSecondaryButton(
                    text = stringResource(R.string.snap_open_settings),
                    modifier = Modifier.fillMaxWidth(),
                    onClick = actions.openSettings,
                )
            }
        }

        OutlinedTextField(
            value = state.brand,
            onValueChange = actions.setBrand,
            label = { Text(stringResource(R.string.snap_brand_optional_unlocks_value)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = state.keyword,
            onValueChange = actions.setKeyword,
            label = { Text(stringResource(R.string.snap_item_e_g_better_sweater_optional)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )

        BrandPrimaryButton(
            text = stringResource(
                if (state.loading) R.string.snap_reading else R.string.snap_whats_it_worth,
            ),
            enabled = state.canEvaluate,
            modifier = Modifier.fillMaxWidth(),
            onClick = actions.evaluate,
        )

        if (state.loading) {
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
        }

        state.errorMessage?.let { message ->
            ErrorCard(
                message = message,
                // A plan wall can't be retried away; the only useful action is
                // the upsell the server is already pointing at.
                isUpgradePrompt = state.isUpgradePrompt,
                canRetry = state.canEvaluate,
                onRetry = actions.evaluate,
                onUpgrade = actions.certifiedGrade,
            )
        }

        state.result?.let { result ->
            ResultCard(
                result = result,
                hasHints = state.hasHints,
                onCertifiedGrade = actions.certifiedGrade,
                onList = actions.list,
            )
        }
    }
}

@Composable
private fun PhotoArea(photo: File?) {
    if (photo != null) {
        AsyncImage(
            model = photo,
            contentDescription = stringResource(R.string.snap_the_garment_you_re_grading),
            contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxWidth().heightIn(max = 280.dp),
        )
    } else {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(200.dp)
                .background(
                    MaterialTheme.colorScheme.surfaceVariant,
                    RoundedCornerShape(12.dp),
                ),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                stringResource(R.string.snap_photo_placeholder),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun ErrorCard(
    message: String,
    isUpgradePrompt: Boolean,
    canRetry: Boolean,
    onRetry: () -> Unit,
    onUpgrade: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(
                MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.4f),
                RoundedCornerShape(12.dp),
            )
            .padding(Spacing.sm),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(message, style = MaterialTheme.typography.bodyMedium)
        if (isUpgradePrompt) {
            BrandPrimaryButton(
                text = stringResource(R.string.snap_get_a_certified_grade),
                modifier = Modifier.fillMaxWidth(),
            ) {
                onUpgrade()
            }
        } else {
            BrandSecondaryButton(
                text = stringResource(R.string.snap_try_again),
                enabled = canRetry,
                modifier = Modifier.fillMaxWidth(),
            ) { onRetry() }
        }
    }
}

@Composable
private fun ResultCard(result: SnapResponse, hasHints: Boolean, onCertifiedGrade: () -> Unit, onList: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(
                MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                RoundedCornerShape(12.dp),
            )
            .padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f)) {
                Text(
                    SnapDisplay.scoreText(result.grade),
                    style = MaterialTheme.typography.displaySmall,
                    color = gradeColor(result.grade.overallScore),
                )
                Text(
                    SnapDisplay.gradeSubtitle(result.grade).text(),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    SnapDisplay.valueRange(result.value),
                    style = MaterialTheme.typography.titleLarge,
                )
                Text(
                    SnapDisplay.valueSubtitle(result.value, hasHints).text(),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        Text(
            result.disclaimer,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            BrandPrimaryButton(
                text = stringResource(R.string.snap_get_certified_grade),
                modifier = Modifier.weight(1f),
            ) {
                onCertifiedGrade()
            }
            BrandSecondaryButton(text = stringResource(R.string.snap_list_it), modifier = Modifier.weight(1f)) {
                onList()
            }
        }
    }
}

/**
 * Copy a picked photo into our own cache so the processor has a real path.
 *
 * The picker's `content://` grant is scoped to this Activity result and can be
 * revoked the moment the screen goes away — reading it lazily at send time
 * would fail exactly when a user backgrounded the app mid-flow.
 */
private fun stageFromUri(context: android.content.Context, uri: Uri): File {
    val dir = File(context.cacheDir, "snap-import").apply { mkdirs() }
    val staged = File(dir, "pick_${System.nanoTime()}.jpg")
    context.contentResolver.openInputStream(uri)?.use { input ->
        staged.outputStream().use { input.copyTo(it) }
    }
    return staged
}
