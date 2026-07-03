package com.gradethread.app.capture

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.view.CameraController
import androidx.camera.view.LifecycleCameraController
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AddCircle
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.gradethread.app.platform.rememberShutterSound
import com.gradethread.app.platform.rememberHapticFeedback
import com.gradethread.app.sync.db.DatabaseProvider
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.Spacing
import kotlinx.coroutines.launch
import java.io.File

/**
 * US-1324: the photo-first capture surface. CameraX preview + capture into
 * the slot strip; a capture lands in the active slot and auto-advances; the
 * whole session persists to Room after every mutation so process death
 * recovers the draft.
 */
@Composable
fun CaptureScreen() {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val haptics = rememberHapticFeedback()
    val shutter = rememberShutterSound()
    val scope = rememberCoroutineScope()
    val db = remember { DatabaseProvider.open(context.applicationContext) }

    var store by remember { mutableStateOf<PhotoIntakeStore?>(null) }
    LaunchedEffect(Unit) { store = PhotoIntakeStore.restore(db) } // draft recovery

    var granted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }
    var denied by remember { mutableStateOf(false) }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { result ->
        granted = result
        denied = !result
    }
    LaunchedEffect(Unit) {
        if (!granted) permissionLauncher.launch(Manifest.permission.CAMERA)
    }

    val intake = store ?: return
    val state by intake.state.collectAsState()

    if (!granted) {
        // AC4: the denied-state fallback.
        Column(
            modifier = Modifier.fillMaxSize().padding(Spacing.xl),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                if (denied) {
                    "Camera access is off. Enable it in Settings to capture photos — or add photos from your library instead."
                } else {
                    "Camera permission needed to capture garment photos."
                },
                style = MaterialTheme.typography.bodyMedium,
            )
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
        val dir = File(context.filesDir, "captures").apply { mkdirs() }
        val file = File(dir, "${state.activeSlot}_${System.currentTimeMillis()}.jpg")
        val options = ImageCapture.OutputFileOptions.Builder(file).build()
        controller.takePicture(
            options,
            ContextCompat.getMainExecutor(context),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                    haptics.success()
                    shutter.play()
                    intake.recordCapture(file.absolutePath)
                    scope.launch { intake.persist(db) } // draft after every shot
                }

                override fun onError(exception: ImageCaptureException) {
                    haptics.error()
                }
            },
        )
    }

    Column(Modifier.fillMaxSize()) {
        // Hint for the active slot.
        Text(
            state.active.hint,
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.padding(horizontal = Spacing.md, vertical = Spacing.xs),
        )

        // The slot strip: active highlight, tap to switch, Add menu.
        var addMenuOpen by remember { mutableStateOf(false) }
        LazyRow(
            horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = Spacing.md),
        ) {
            items(intake.visibleSlots, key = { it.wire }) { slot ->
                FilterChip(
                    selected = slot == state.active,
                    onClick = {
                        haptics.light()
                        intake.setActiveSlot(slot)
                        scope.launch { intake.persist(db) }
                    },
                    label = {
                        Text(if (state.photoFor(slot) != null) "✓ ${slot.label}" else slot.label)
                    },
                )
            }
            item {
                Box {
                    IconButton(onClick = { addMenuOpen = true }) {
                        Icon(Icons.Filled.AddCircle, contentDescription = "Add photo slot")
                    }
                    DropdownMenu(expanded = addMenuOpen, onDismissRequest = { addMenuOpen = false }) {
                        intake.hiddenExtraSlots.forEach { slot ->
                            DropdownMenuItem(
                                text = { Text(slot.label) },
                                onClick = {
                                    addMenuOpen = false
                                    intake.reveal(slot)
                                    scope.launch { intake.persist(db) }
                                },
                            )
                        }
                    }
                }
            }
        }

        // Live preview.
        Box(Modifier.weight(1f).fillMaxWidth()) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    PreviewView(ctx).apply { this.controller = controller }
                },
            )
            // Shutter.
            Box(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = Spacing.xl)
                    .size(72.dp)
                    .background(MaterialTheme.colorScheme.primary, CircleShape),
            ) {
                IconButton(onClick = ::capture, modifier = Modifier.fillMaxSize()) {
                    Box(
                        Modifier
                            .size(56.dp)
                            .background(MaterialTheme.colorScheme.onPrimary, CircleShape),
                    )
                }
            }
        }

        if (intake.allRequiredFilled) {
            BrandPrimaryButton(
                text = "Continue",
                modifier = Modifier.fillMaxWidth().padding(Spacing.md),
            ) { /* the intake-handoff story wires the next step */ }
        }
    }
}
