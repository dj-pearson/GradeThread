package com.gradethread.app.capture

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.view.CameraController
import androidx.camera.view.LifecycleCameraController
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import android.annotation.SuppressLint
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.gradethread.app.R
import com.gradethread.app.platform.rememberHapticFeedback
import com.gradethread.app.ui.theme.Spacing
import java.util.concurrent.Executors

/**
 * US-1332: full-screen barcode scanner that returns a SKU (iOS
 * `BarcodeScanView`).
 *
 * [onScanned] fires at most once per presentation — the dedup disarms after
 * the first hit and the caller dismisses — so it is safe to treat as
 * single-shot.
 */
// LINT SUPPRESSED WITH A REASON, not to quieten a gate. The check wants
// FEATURE_CAMERA_ANY so a ChromeOS device with only a front camera still
// qualifies. For a BARCODE SCANNER that is the wrong trade: a camera facing
// the user cannot read a tag on a garment held in front of it, so a
// selfie-only device would pass the check and then fail at the only thing it
// was opened to do. The rear-camera requirement is the product behaviour and
// the message below depends on it — see the comment at the call.
@SuppressLint("UnsupportedChromeOsCameraSystemFeature")
@Composable
fun BarcodeScanScreen(onScanned: (String) -> Unit, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val haptics = rememberHapticFeedback()

    var granted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }
    var error by remember { mutableStateOf<BarcodeError?>(null) }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { result ->
        granted = result
        // Unlike the notes mic, asking on entry is right here: the whole
        // screen is a camera, so the request is self-evidently in context.
        if (!result) error = BarcodeError.PermissionDenied
    }
    LaunchedEffect(Unit) {
        if (!granted) permissionLauncher.launch(Manifest.permission.CAMERA)
    }

    if (!granted) {
        ScannerMessage(
            message = (error ?: BarcodeError.PermissionDenied).message,
            settingsRecoverable = (error ?: BarcodeError.PermissionDenied).isSettingsRecoverable,
            onDismiss = onDismiss,
        )
        return
    }

    val currentError = error
    if (currentError != null) {
        ScannerMessage(
            message = currentError.message,
            settingsRecoverable = currentError.isSettingsRecoverable,
            onDismiss = onDismiss,
        )
        return
    }

    // A dedicated executor keeps ML Kit's decode off the main thread; the
    // analyzer's callbacks are serialized on it, which is what lets
    // BarcodeDedup stay lock-free.
    val executor = remember { Executors.newSingleThreadExecutor() }
    val controller = remember { LifecycleCameraController(context) }

    // US-2978: the effect below keys on lifecycleOwner, which never changes for
    // the life of this screen — so without these it would capture whichever
    // onScanned/onDismiss existed at first composition and call THAT forever. A
    // caller that recomposes with a new lambda (a different target item, say)
    // would have its scan delivered to the old closure, silently.
    //
    // rememberUpdatedState rather than adding the lambdas to the effect keys:
    // restarting this effect tears down and rebuilds the CameraX analyzer and
    // the dedup, so keying on a lambda that changes on every recomposition
    // would rebuild the camera pipeline constantly.
    val currentOnScanned by rememberUpdatedState(onScanned)
    val currentOnDismiss by rememberUpdatedState(onDismiss)

    DisposableEffect(lifecycleOwner) {
        // Fresh dedup per presentation, so returning to the scanner can
        // re-read the SAME barcode rather than mysteriously doing nothing.
        val analyzer = BarcodeAnalyzer(
            onDetected = { raw ->
                val sku = normalizeScannedSku(raw)
                if (sku.isNotEmpty()) {
                    haptics.success()
                    currentOnScanned(sku)
                    currentOnDismiss()
                }
            },
        )
        // US-2792: a device with no REAR camera gets its own sentence. Without
        // this it fell into the catch below and was told "Couldn't start the
        // scanner", which reads as a transient fault and invites a retry that
        // can never work. FEATURE_CAMERA means a camera facing AWAY from the
        // screen — FEATURE_CAMERA_ANY would also match a selfie-only device and
        // hand it the wrong message.
        val hasRearCamera =
            context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA)
        if (!hasRearCamera) {
            error = BarcodeError.NoCamera
        } else {
            val started = runCatching {
                controller.setEnabledUseCases(CameraController.IMAGE_ANALYSIS)
                controller.setImageAnalysisAnalyzer(executor, analyzer)
                controller.bindToLifecycle(lifecycleOwner)
            }
            if (started.isFailure) error = BarcodeError.ConfigurationFailed
        }
        onDispose {
            controller.clearImageAnalysisAnalyzer()
            controller.unbind()
            analyzer.close()
            executor.shutdown()
        }
    }

    Box(Modifier.fillMaxSize()) {
        AndroidView(
            factory = { ctx -> PreviewView(ctx).apply { this.controller = controller } },
            modifier = Modifier.fillMaxSize(),
        )
        Column(
            modifier = Modifier.align(Alignment.BottomCenter).padding(Spacing.xl),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = stringResource(R.string.barcode_point_camera),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface,
            )
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) }
        }
    }
}

/** Error / permission fallback — mirrors the iOS denied explainer. */
@Composable
private fun ScannerMessage(message: String, settingsRecoverable: Boolean, onDismiss: () -> Unit) {
    val context = LocalContext.current
    Column(
        modifier = Modifier.fillMaxSize().padding(Spacing.xl),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = message,
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
        )
        // Only permission failures get an Open Settings affordance — sending
        // someone to Settings for a busy camera is a dead end.
        if (settingsRecoverable) {
            Button(
                onClick = {
                    val intent = Intent(
                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", context.packageName, null),
                    ).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
                    runCatching { context.startActivity(intent) }
                },
                modifier = Modifier.padding(top = Spacing.md),
            ) { Text(stringResource(R.string.common_open_settings)) }
        }
        TextButton(onClick = onDismiss, modifier = Modifier.padding(top = Spacing.xs)) {
            Text(stringResource(R.string.common_cancel))
        }
    }
}
