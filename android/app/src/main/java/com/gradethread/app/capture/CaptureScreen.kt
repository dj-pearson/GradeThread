package com.gradethread.app.capture

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.view.CameraController
import androidx.camera.view.LifecycleCameraController
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.R
import com.gradethread.app.platform.rememberShutterSound
import com.gradethread.app.platform.rememberHapticFeedback
import com.gradethread.app.sync.db.DatabaseProvider
import com.gradethread.app.ui.text
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
fun CaptureScreen(
    /** US-1334: fired once the item exists and extraction has started. */
    onPublished: (String) -> Unit = {},
    publishViewModel: CapturePublishViewModel = hiltViewModel(),
) {
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

    // US-1327: library import — the Photo Picker needs NO storage permission.
    val pickerLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(PhotoImport.MAX_PICK),
    ) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            val outputDir = File(context.filesDir, "captures")
            // US-2639: an imported serial shot gets the same cap a captured one
            // does. The slot is only decided by recordCapture's auto-advance
            // below, which runs AFTER processing — so the destinations are
            // predicted here, and PhotoIntakeStoreTest pins the prediction
            // against the real function.
            val caps = store?.plannedDestinations(uris.size)
                ?.map { PhotoProcessor.uploadCapFor(it.serverPhotoType) }
                ?: emptyList()
            PhotoImport.importPicked(context, uris, outputDir, slotCaps = caps).forEach { result ->
                result.getOrNull()?.let { imported ->
                    store?.recordCapture(imported.processed.file.absolutePath)
                }
            }
            store?.persist(db)
        }
    }

    val publish by publishViewModel.state.collectAsState()
    // US-2978: onPublished is not among this effect keys, so the block that runs
    // carries whichever closure existed when publishedItemId last changed. The
    // window is narrower than BarcodeScanScreen milliseconds rather than the
    // life of a camera session but the fix is the same and costs nothing.
    val currentOnPublished by rememberUpdatedState(onPublished)
    LaunchedEffect(publish.publishedItemId) {
        publish.publishedItemId?.let { itemId ->
            publishViewModel.onNavigated()
            currentOnPublished(itemId)
        }
    }

    val intake = store ?: return
    val state by intake.state.collectAsState()

    // US-2498: the strip is the resolved profile's slots, not a compiled-in
    // list. `apply` is a no-op once the profile matches, so this settles after
    // one pass and carries any shot already taken into the new strip.
    val fetchedProfile by publishViewModel.profile.collectAsState()
    LaunchedEffect(fetchedProfile, intake) { intake.apply(fetchedProfile) }
    val profile by intake.profile.collectAsState()

    if (!granted) {
        // AC4: the denied-state fallback.
        Column(
            modifier = Modifier.fillMaxSize().padding(Spacing.xl),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                if (denied) {
                    stringResource(R.string.capture_permission_blocked)
                } else {
                    stringResource(R.string.capture_permission_needed)
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

    // US-2658: a camera shot that could not be processed. Surfaced rather than
    // swallowed, because the alternative to showing it is uploading raw sensor
    // bytes, and the seller would have no way to know either happened.
    var captureError by remember { mutableStateOf(false) }

    fun capture() {
        val dir = File(context.filesDir, "captures").apply { mkdirs() }
        // PINNED before the shutter round trip, and used for BOTH the filename
        // and the slot the result is filed under. Only the filename was pinned
        // before; recordCapture read activeSlot at callback time, so tapping
        // another chip mid-shutter filed the shot in the wrong slot. iOS pins
        // the same way (PhotoIntakeView.swift:1019-1028).
        val slot = state.activeSlot
        val raw = File(dir, "${slot}_${System.currentTimeMillis()}.jpg")
        val options = ImageCapture.OutputFileOptions.Builder(raw).build()
        controller.takePicture(
            options,
            ContextCompat.getMainExecutor(context),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                    haptics.success()
                    shutter.play()
                    // US-2658: THE CAMERA PATH RUNS PhotoProcessor TOO. It did
                    // not, and the library picker did, so the same garment
                    // uploaded at full sensor resolution with CameraX's EXIF
                    // intact if it was shot here and at 2048px with no metadata
                    // at all if it was picked. The processor is what strips
                    // metadata and what bakes the orientation into the pixels;
                    // eBay ignores the EXIF tag, so a shot kept upright only by
                    // that tag lists sideways.
                    scope.launch {
                        // US-2639: the SLOT's cap, not a global one — and this
                        // is why US-2658 had to pin `slot` before the shutter.
                        // Resolving it here from a live activeSlot would apply
                        // whichever chip the seller happened to be on when the
                        // callback fired, so a serial shot could land at the
                        // default while a front shot got the macro cap.
                        val cap = PhotoProcessor.uploadCapFor(
                            CaptureSlot.fromStorageKey(slot)?.serverPhotoType ?: slot,
                        )
                        val processed = runCatching { PhotoProcessor.process(raw, dir, cap) }
                        // The raw file goes either way. On success it is
                        // superseded; on failure it must not linger where a
                        // later change could pick it up, which is the whole
                        // point of failing closed here.
                        raw.delete()
                        val out = processed.getOrNull()
                        if (out == null) {
                            captureError = true
                            haptics.error()
                            return@launch
                        }
                        captureError = false
                        intake.recordCapture(out.file.absolutePath, slot)
                        intake.persist(db) // draft after every shot
                    }
                }

                override fun onError(exception: ImageCaptureException) {
                    haptics.error()
                    captureError = true
                }
            },
        )
    }

    // US-1382: what the last share drain did, when it needs saying. Read HERE
    // because this is where the shared photos landed - a toast fired from a
    // background drain would be gone before anyone looked.
    val shareNotice by com.gradethread.app.intake.IntakeDrainer.lastMessage.collectAsState()

    CaptureContent(
        intake = intake,
        publish = publish,
        actions = CaptureActions(
            // The camera, the picker and Room all need a real Context, and a
            // golden has none of the three.
            shutter = ::capture,
            importFromLibrary = {
                pickerLauncher.launch(
                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                )
            },
            setActiveSlot = { slot ->
                haptics.light()
                intake.setActiveSlot(slot)
                scope.launch { intake.persist(db) }
            },
            revealSlot = { slot ->
                intake.reveal(slot)
                scope.launch { intake.persist(db) }
            },
            publish = { if (!publish.publishing) publishViewModel.publish(state, profile) },
            dismissShareNotice = com.gradethread.app.intake.IntakeDrainer::clearMessage,
            dismissCaptureError = { captureError = false },
        ),
        shareNotice = shareNotice,
        captureError = captureError,
    ) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx -> PreviewView(ctx).apply { this.controller = controller } },
        )
    }
}

/** Everything this screen can be asked to do (US-2902 AC3). */
@Immutable
data class CaptureActions(
    val shutter: () -> Unit = {},
    val importFromLibrary: () -> Unit = {},
    val setActiveSlot: (CaptureSlot) -> Unit = {},
    val revealSlot: (CaptureSlot) -> Unit = {},
    val publish: () -> Unit = {},
    val dismissShareNotice: () -> Unit = {},
    val dismissCaptureError: () -> Unit = {},
)

/**
 * The capture surface, with no camera and no ViewModel attached (US-2902 AC3).
 *
 * ⚠ THE PREVIEW IS A SLOT because a CameraX `PreviewView` needs a bound
 * lifecycle and a real device camera, neither of which a screenshot test has.
 * Everything around it - the slot strip, the two dismissable banners, the
 * publish button - is the part that can actually be wrong, so that is the part
 * held still by a golden.
 *
 * ⚠ AND [intake] IS PASSED WHOLE rather than picked apart. `visibleSlots`,
 * `hiddenExtraSlots` and `allRequiredFilled` are derived from the profile AND
 * the captured photos together, and a caller that recomputed them would be a
 * second answer to the question of which slots exist.
 */
@Composable
fun CaptureContent(
    intake: PhotoIntakeStore,
    publish: CapturePublishViewModel.State,
    actions: CaptureActions,
    modifier: Modifier = Modifier,
    shareNotice: String? = null,
    captureError: Boolean = false,
    preview: @Composable () -> Unit = {},
) {
    val state by intake.state.collectAsState()
    val profile by intake.profile.collectAsState()

    Column(modifier.fillMaxSize()) {
        shareNotice?.let { notice ->
            Text(
                notice,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onErrorContainer,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.errorContainer)
                    .padding(horizontal = Spacing.md, vertical = Spacing.xs)
                    .clickable(onClick = actions.dismissShareNotice),
            )
        }

        // US-2658: the shot that did not survive processing. Tappable to
        // dismiss, like the drain notice above, and cleared by the next good
        // shot so it cannot outlive the problem it describes.
        if (captureError) {
            Text(
                stringResource(R.string.capture_process_failed),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onErrorContainer,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.errorContainer)
                    .padding(horizontal = Spacing.md, vertical = Spacing.xs)
                    .clickable(onClick = actions.dismissCaptureError),
            )
        }

        // US-2498 AC2: a slot this build has no capture case for. Saying so is
        // the whole point — the seller is being offered fewer shots than their
        // category asks for, and silence reads as "there is nothing else".
        val unsupported = profile.unsupportedRoleTypes
        if (unsupported.isNotEmpty()) {
            Text(
                pluralStringResource(R.plurals.capture_slots_need_update, unsupported.size, unsupported.size),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = Spacing.md, vertical = Spacing.xs),
            )
        }

        // Hint for the active slot — the profile's wording when it has one.
        Text(
            state.activeCaptureSlot.hint.text(),
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.padding(horizontal = Spacing.md, vertical = Spacing.xs),
        )

        // The slot strip: active highlight, tap to switch, Add menu.
        var addMenuOpen by remember { mutableStateOf(false) }
        LazyRow(
            horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = Spacing.md),
        ) {
            items(intake.visibleSlots, key = { it.storageKey }) { slot ->
                FilterChip(
                    selected = slot == state.activeCaptureSlot,
                    onClick = { actions.setActiveSlot(slot) },
                    label = {
                        Text(
                            if (state.photoFor(slot) != null) {
                                stringResource(R.string.checked_prefix, slot.label.text())
                            } else {
                                slot.label.text()
                            },
                        )
                    },
                )
            }
            item {
                IconButton(onClick = actions.importFromLibrary) {
                    Icon(
                        Icons.Outlined.Menu,
                        contentDescription = stringResource(R.string.capture_import_from_library),
                    )
                }
            }
            item {
                Box {
                    IconButton(onClick = { addMenuOpen = true }) {
                        Icon(
                            Icons.Filled.AddCircle,
                            contentDescription = stringResource(R.string.capture_add_photo_slot),
                        )
                    }
                    DropdownMenu(expanded = addMenuOpen, onDismissRequest = { addMenuOpen = false }) {
                        intake.hiddenExtraSlots.forEach { slot ->
                            DropdownMenuItem(
                                text = { Text(slot.label.text()) },
                                onClick = {
                                    addMenuOpen = false
                                    actions.revealSlot(slot)
                                },
                            )
                        }
                    }
                }
            }
        }

        // Live preview.
        Box(Modifier.weight(1f).fillMaxWidth()) {
            preview()
            // Shutter.
            Box(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = Spacing.xl)
                    .size(72.dp)
                    .background(MaterialTheme.colorScheme.primary, CircleShape),
            ) {
                IconButton(onClick = actions.shutter, modifier = Modifier.fillMaxSize()) {
                    Box(
                        Modifier
                            .size(56.dp)
                            .background(MaterialTheme.colorScheme.onPrimary, CircleShape),
                    )
                }
            }
        }

        // US-1334: the handoff. Publishing creates the item, enqueues the
        // uploads and starts the extraction; the screen only navigates.
        publish.errorMessage?.let { message ->
            Text(
                message.text(),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(horizontal = Spacing.md),
            )
        }
        if (intake.allRequiredFilled) {
            BrandPrimaryButton(
                text = if (publish.publishing) {
                    stringResource(R.string.common_saving)
                } else {
                    stringResource(R.string.common_continue)
                },
                modifier = Modifier.fillMaxWidth().padding(Spacing.md),
            ) { actions.publish() }
        }
    }
}
