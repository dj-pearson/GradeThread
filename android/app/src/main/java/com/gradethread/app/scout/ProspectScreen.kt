package com.gradethread.app.scout

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.marketplaces.CustomTabsLauncher
import com.gradethread.app.platform.rememberHapticFeedback
import com.gradethread.app.ui.components.InfoCard
import com.gradethread.app.ui.components.InfoTone
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle
import java.io.File

/**
 * US-1374: in-store prospecting — snap it, don't type it.
 */
@Composable
fun ProspectScreen(
    onOpenItem: (String) -> Unit = {},
    onClose: () -> Unit = {},
    viewModel: ProspectViewModel = hiltViewModel(),
) {
    val context = LocalContext.current
    val haptics = rememberHapticFeedback()
    val state by viewModel.state.collectAsState()

    // The system camera writes into our own cache dir behind a content:// grant
    // — nothing else on the device can read the shot.
    var pendingCapture by remember { mutableStateOf<File?>(null) }
    var cameraDenied by remember { mutableStateOf(false) }

    val takePicture = rememberLauncherForActivityResult(
        ActivityResultContracts.TakePicture(),
    ) { saved ->
        val file = pendingCapture
        pendingCapture = null
        if (saved && file != null) viewModel.addPhoto(file)
    }

    fun launchCamera() {
        val dir = File(context.cacheDir, "prospect-capture").apply { mkdirs() }
        val file = File(dir, "prospect_${System.nanoTime()}.jpg")
        pendingCapture = file
        takePicture.launch(
            FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file),
        )
    }

    val requestCamera = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> if (granted) launchCamera() else cameraDenied = true }

    val pickPhoto = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia(),
    ) { uri ->
        uri?.let { viewModel.addPhoto(stageProspectPhoto(context, it)) }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Text("Prospect", style = MaterialTheme.typography.titleLarge)
        Text(
            "Photograph the front and the brand tag. We'll work out what it is, what it " +
                "sells for, and whether it's worth buying.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Text(
            "${state.photos.size} of ${ProspectDisplay.MAX_PHOTOS} photos",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        state.photos.forEach { photo ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    photo.name,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { viewModel.removePhoto(photo) }) { Text("Remove") }
            }
        }

        if (state.canAddMorePhotos) {
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                BrandSecondaryButton(text = "Take photo", modifier = Modifier.weight(1f)) {
                    haptics.light()
                    cameraDenied = false
                    val granted = ContextCompat.checkSelfPermission(
                        context,
                        Manifest.permission.CAMERA,
                    ) == PackageManager.PERMISSION_GRANTED
                    if (granted) launchCamera() else requestCamera.launch(Manifest.permission.CAMERA)
                }
                BrandSecondaryButton(text = "Library", modifier = Modifier.weight(1f)) {
                    haptics.light()
                    pickPhoto.launch(
                        PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                    )
                }
            }
        }
        if (cameraDenied) {
            InfoCard(
                "Camera is off",
                "Turn camera access on in Settings, or pick a photo from your library instead.",
                tone = InfoTone.Warning,
            )
        }

        OutlinedTextField(
            value = state.costText,
            onValueChange = viewModel::setCost,
            label = { Text("What does it cost?") },
            prefix = { Text("$") },
            supportingText = { Text("Optional, but there's no buy-or-walk verdict without it.") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.fillMaxWidth(),
        )

        state.errorMessage?.let {
            InfoCard(
                if (state.planWall != null) "Not on your plan" else "That didn't work",
                it,
                tone = if (state.planWall != null) InfoTone.Warning else InfoTone.Error,
            )
        }

        state.response?.let { response -> ResultCard(response, state, context) }

        state.boughtItemId?.let { itemId ->
            BrandSecondaryButton(text = "Open it in inventory", modifier = Modifier.fillMaxWidth()) {
                onOpenItem(itemId)
            }
        }

        BrandPrimaryButton(
            text = if (state.running) "Checking…" else "Check it",
            // A plan wall can't be retried: the shell is already offering the
            // upgrade, and a second tap only hits the same wall.
            enabled = state.canRun && state.planWall == null,
            modifier = Modifier.fillMaxWidth(),
        ) { viewModel.run() }

        if (state.canBuy) {
            BrandPrimaryButton(
                text = if (state.buying) "Adding…" else "Add to inventory",
                enabled = !state.buying,
                modifier = Modifier.fillMaxWidth(),
            ) { viewModel.buy() }
        }

        BrandSecondaryButton(text = "Start over", modifier = Modifier.fillMaxWidth()) {
            viewModel.reset()
        }
        BrandSecondaryButton(text = "Back", modifier = Modifier.fillMaxWidth()) { onClose() }
    }
}

@Composable
private fun ResultCard(
    response: ProspectResponse,
    state: ProspectViewModel.State,
    context: android.content.Context,
) {
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        if (!response.identified) {
            // Naming the failure as "we couldn't read it" rather than showing an
            // empty result: the seller can fix this with a better photo, and
            // that is the only useful thing to tell them.
            Text("Couldn't read that one", style = MaterialTheme.typography.titleMedium)
            Text(
                response.note
                    ?: "Try a clearer shot of the brand tag, or a straight-on photo of the front.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            return
        }

        Text(state.verdict, style = MaterialTheme.typography.titleLarge)
        Text(
            ProspectDisplay.buyTitle(response.item),
            style = MaterialTheme.typography.bodyLarge,
            fontWeight = FontWeight.Medium,
        )
        response.item.brand?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Text(
            "Sells for ${ProspectDisplay.priceRange(response.stats)}",
            style = MaterialTheme.typography.bodyMedium,
        )
        ProspectDisplay.marginLabel(response.decision)?.let {
            Text(it, style = MaterialTheme.typography.bodyMedium)
        }
        ProspectDisplay.sellThroughLabel(response.sellThrough)?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        response.grade?.let { grade ->
            Text(
                "Graded ${"%.1f".format(grade.value)} · " +
                    "${Math.round(grade.confidence * 100)}% confident",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        response.decision?.reason?.takeIf { it.isNotBlank() }?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        state.caveat?.let {
            InfoCard("Take this with a pinch of salt", it, tone = InfoTone.Warning)
        }

        response.ebaySoldSearchUrl?.let { url ->
            TextButton(onClick = { CustomTabsLauncher.open(context, url) }) {
                Text("See the sold listings")
            }
        }
        response.disclaimer?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** Copy a picked image into our own cache so the edge upload has a real file. */
private fun stageProspectPhoto(context: android.content.Context, uri: android.net.Uri): File {
    val dir = File(context.cacheDir, "prospect-capture").apply { mkdirs() }
    val file = File(dir, "prospect_${System.nanoTime()}.jpg")
    context.contentResolver.openInputStream(uri)?.use { input ->
        file.outputStream().use { output -> input.copyTo(output) }
    }
    return file
}
