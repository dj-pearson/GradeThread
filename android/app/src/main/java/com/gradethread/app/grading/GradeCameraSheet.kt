package com.gradethread.app.grading

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.view.CameraController
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.view.LifecycleCameraController
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.gradethread.app.capture.PhotoProcessor
import com.gradethread.app.ui.theme.Spacing
import kotlinx.coroutines.launch
import java.io.File

/**
 * US-2802: take one grading photo IN THE APP.
 *
 * Live Capture's whole claim is that the app watched the photo being taken, so
 * it cannot be satisfied by the library picker no matter how good the photo is.
 * That is why this exists beside [ConsumerGradeScreen]'s picker rather than
 * replacing it.
 *
 * ⚠ THIS RUNS PhotoProcessor, and US-2658 is why. The camera path here did NOT
 * run it once while the library path did, so the same garment uploaded at full
 * sensor resolution with CameraX's EXIF intact if shot in-app, and at 2048px
 * with no metadata if picked. The processor is what strips metadata AND bakes
 * the orientation into the pixels — eBay and the grading pipeline both ignore
 * the EXIF rotation tag, so a shot kept upright only by that tag arrives
 * sideways. `ConsumerGradeEntryWiringTest` asserts BOTH paths still call it.
 *
 * A second CameraX setup rather than a refactor of CaptureScreen: that screen
 * carries slot auto-advance, per-slot resolution caps and permission recovery,
 * and destabilising it to share thirty lines of boilerplate is the worse trade.
 * The property that must not drift is the processor call, and that is guarded.
 */
@Composable
fun GradeCameraSheet(onCapture: (ByteArray) -> Unit, onCancel: () -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()

    var granted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }
    var failed by remember { mutableStateOf(false) }

    val permission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted = it }

    LaunchedEffect(Unit) {
        if (!granted) permission.launch(Manifest.permission.CAMERA)
    }

    if (!granted) {
        Column(
            modifier.fillMaxSize().padding(Spacing.xl),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                "Camera access is needed to take a photo here. " +
                    "You can add one from your library instead.",
                style = MaterialTheme.typography.bodyMedium,
            )
            Button(onClick = onCancel, modifier = Modifier.padding(top = Spacing.md)) {
                Text("Back")
            }
        }
        return
    }

    val controller = remember {
        LifecycleCameraController(context).apply {
            setEnabledUseCases(CameraController.IMAGE_CAPTURE)
        }
    }
    DisposableEffect(lifecycleOwner) {
        controller.bindToLifecycle(lifecycleOwner)
        onDispose { controller.unbind() }
    }

    fun capture() {
        val dir = File(context.filesDir, "consumer-grade-camera").apply { mkdirs() }
        val raw = File(dir, "shot_${System.currentTimeMillis()}.jpg")
        controller.takePicture(
            ImageCapture.OutputFileOptions.Builder(raw).build(),
            ContextCompat.getMainExecutor(context),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                    scope.launch {
                        val processed = runCatching {
                            PhotoProcessor.process(raw, dir)
                        }.getOrNull()
                        val bytes = processed?.file?.readBytes()
                        // Both files have served their purpose the moment the
                        // bytes are in hand: the draft holds them in memory and
                        // the uploader posts them from there. Left behind, every
                        // retake would keep two full-size JPEGs in filesDir,
                        // which is app storage the person never gets back and
                        // no other code path ever visits.
                        raw.delete()
                        processed?.file?.delete()
                        if (bytes == null || bytes.isEmpty()) {
                            // Surfaced rather than swallowed: the alternative to
                            // showing this is uploading raw sensor bytes, and
                            // the person would have no way to know either
                            // happened.
                            failed = true
                        } else {
                            onCapture(bytes)
                        }
                    }
                }

                override fun onError(exception: ImageCaptureException) {
                    failed = true
                }
            },
        )
    }

    Box(modifier.fillMaxSize()) {
        AndroidView(
            factory = { ctx -> PreviewView(ctx).apply { this.controller = controller } },
            modifier = Modifier.fillMaxSize(),
        )
        Column(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(Spacing.lg),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            if (failed) {
                Text(
                    "That shot could not be saved. Take it again.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            Button(onClick = {
                failed = false
                capture()
            }, modifier = Modifier.fillMaxWidth()) {
                Text("Take the photo")
            }
            Button(onClick = onCancel, modifier = Modifier.fillMaxWidth()) {
                Text("Cancel")
            }
        }
    }
}
