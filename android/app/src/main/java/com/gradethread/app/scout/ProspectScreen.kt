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
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.capture.PhotoProcessor
import com.gradethread.app.marketplaces.CustomTabsLauncher
import com.gradethread.app.platform.rememberHapticFeedback
import com.gradethread.app.ui.text
import com.gradethread.app.ui.components.InfoCard
import com.gradethread.app.ui.components.InfoTone
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle
import java.io.File
import kotlinx.coroutines.launch

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
    // Resolved here because the ViewModel that stores it has no Context.
    val untitled = stringResource(R.string.prospect_untitled_item)
    val haptics = rememberHapticFeedback()
    val state by viewModel.state.collectAsState()

    // The system camera writes into our own cache dir behind a content:// grant
    // — nothing else on the device can read the shot.
    var pendingCapture by remember { mutableStateOf<File?>(null) }
    // WHICH SLOT the seller tapped. The launchers come back with a file or a
    // uri and no memory of what was asked for, so the role has to survive the
    // round trip here or it gets guessed from position later, which is the bug
    // this screen exists to stop (US-3027).
    var pendingRole by remember { mutableStateOf(ProspectPhotoRole.FRONT) }
    var cameraDenied by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    val takePicture = rememberLauncherForActivityResult(
        ActivityResultContracts.TakePicture(),
    ) { saved ->
        val raw = pendingCapture
        val role = pendingRole
        pendingCapture = null
        // US-2658 AC3 / US-3027: the RAW camera file never reaches the wire.
        // PhotoProcessor is what downsizes and what destroys EXIF - a fresh
        // Bitmap.compress copies none of it - and these bytes are base64'd
        // straight into the scan request, so a raw file here ships the seller's
        // GPS coordinates to identify a jumper.
        if (saved && raw != null) scope.launch { useProcessed(viewModel, role, raw) }
    }

    fun launchCamera() {
        val dir = File(context.cacheDir, "prospect-capture").apply { mkdirs() }
        val file = File(dir, "prospect_${pendingRole.wire}_${System.nanoTime()}.jpg")
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
        val role = pendingRole
        uri?.let {
            scope.launch {
                // Staged into our own cache first, because PhotoProcessor reads
                // a File and the picker hands back a content:// uri.
                useProcessed(viewModel, role, stageProspectPhoto(context, it))
            }
        }
    }

    ProspectContent(
        state,
        ProspectActions(
            // Both photo routes stay in the wrapper: one needs a camera
            // permission and a FileProvider grant, the other a photo picker.
            // Neither exists in a screenshot test, and neither belongs in a
            // body whose job is to lay out what has already been chosen.
            takePhoto = { role ->
                haptics.light()
                cameraDenied = false
                pendingRole = role
                val granted = ContextCompat.checkSelfPermission(
                    context,
                    Manifest.permission.CAMERA,
                ) == PackageManager.PERMISSION_GRANTED
                if (granted) launchCamera() else requestCamera.launch(Manifest.permission.CAMERA)
            },
            pickPhoto = { role ->
                haptics.light()
                pendingRole = role
                pickPhoto.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
            },
            removePhoto = viewModel::removePhoto,
            setCost = viewModel::setCost,
            run = viewModel::run,
            buy = { viewModel.buy(untitled) },
            reset = viewModel::reset,
            openItem = onOpenItem,
            close = onClose,
        ),
        cameraDenied = cameraDenied,
    )
}

/** Everything this screen can be asked to do (US-2902 AC3). */
@Immutable
data class ProspectActions(
    val takePhoto: (ProspectPhotoRole) -> Unit = {},
    val pickPhoto: (ProspectPhotoRole) -> Unit = {},
    val removePhoto: (ProspectPhotoRole) -> Unit = {},
    val setCost: (String) -> Unit = {},
    val run: () -> Unit = {},
    val buy: () -> Unit = {},
    val reset: () -> Unit = {},
    val openItem: (String) -> Unit = {},
    val close: () -> Unit = {},
)

/**
 * Prospect with no ViewModel attached (US-2902 AC3).
 *
 * ⚠ A SELLER READS THIS STANDING IN A SHOP, DECIDING WHETHER TO BUY. The verdict
 * and the estimated margin are the whole product, and the cost field is
 * optional - so the same result renders with and without a number attached, and
 * both are captured.
 *
 * ⚠ AND A PLAN WALL IS NOT AN ERROR. It renders as a WARNING with a different
 * heading and it disables the check button, because the shell is already
 * offering the upgrade and a second tap only hits the same wall. Both failures
 * are captured side by side; the tone and the heading are the only difference.
 */
@Composable
fun ProspectContent(
    state: ProspectViewModel.State,
    actions: ProspectActions,
    modifier: Modifier = Modifier,
    cameraDenied: Boolean = false,
) {
    Column(
        modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Text(stringResource(R.string.prospect_prospect), style = MaterialTheme.typography.titleLarge)
        Text(
            stringResource(R.string.prospect_intro),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Text(
            stringResource(R.string.prospect_photo_count, state.photos.size, ProspectDisplay.MAX_PHOTOS),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        ProspectPhotoRole.entries.forEach { role ->
            PhotoSlot(role, state.photoFor(role), actions)
        }
        if (cameraDenied) {
            InfoCard(
                stringResource(R.string.prospect_camera_off),
                stringResource(R.string.prospect_camera_denied),
                tone = InfoTone.Warning,
            )
        }

        OutlinedTextField(
            value = state.costText,
            onValueChange = actions.setCost,
            label = { Text(stringResource(R.string.prospect_what_does_cost)) },
            prefix = { Text(stringResource(R.string.drafts_currency_prefix)) },
            supportingText = { Text(stringResource(R.string.prospect_optional_but_there_s_no)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.fillMaxWidth(),
        )

        state.errorMessage?.let {
            InfoCard(
                stringResource(
                    if (state.planWall != null) {
                        R.string.prospect_not_on_plan
                    } else {
                        R.string.prospect_failed
                    },
                ),
                // US-2976: the server's sentence when there is one, ours when
                // there is not, with the plan name substituted either way.
                it.text(),
                tone = if (state.planWall != null) InfoTone.Warning else InfoTone.Error,
            )
        }

        state.response?.let { response -> ResultCard(response, state) }

        state.boughtItemId?.let { itemId ->
            BrandSecondaryButton(
                text = stringResource(R.string.prospect_open_inventory),
                modifier = Modifier.fillMaxWidth(),
            ) {
                actions.openItem(itemId)
            }
        }

        BrandPrimaryButton(
            text = stringResource(
                if (state.running) R.string.prospect_checking else R.string.prospect_check_it,
            ),
            // A plan wall can't be retried: the shell is already offering the
            // upgrade, and a second tap only hits the same wall.
            enabled = state.canRun && state.planWall == null,
            modifier = Modifier.fillMaxWidth(),
        ) { actions.run() }

        if (state.canBuy) {
            BrandPrimaryButton(
                text = stringResource(
                    if (state.buying) R.string.prospect_adding else R.string.prospect_add_to_inventory,
                ),
                enabled = !state.buying,
                modifier = Modifier.fillMaxWidth(),
            ) { actions.buy() }
        }

        BrandSecondaryButton(text = stringResource(R.string.prospect_start_over), modifier = Modifier.fillMaxWidth()) {
            actions.reset()
        }
        BrandSecondaryButton(text = stringResource(R.string.prospect_back), modifier = Modifier.fillMaxWidth()) {
            actions.close()
        }
    }
}

/**
 * One named capture slot (US-3027).
 *
 * ⚠ THE NAME IS THE POINT, not decoration. The edge decides who identifies the
 * item purely from the role attached to each photo, so a strip of two unlabelled
 * pictures can never reach eBay visual search - it takes the no-usable-role
 * branch and reads the tag. Naming the slot is how the seller tells us which is
 * which; inferring it from position is what US-2758 measured going wrong, where
 * a care label came back as a midi dress, joggers and a mini skirt.
 *
 * Both slots are optional and either one alone is a valid scan: a tag-only scan
 * sends one photo whose role is `tag`.
 */
@Composable
private fun PhotoSlot(role: ProspectPhotoRole, photo: File?, actions: ProspectActions) {
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Text(stringResource(role.label), style = MaterialTheme.typography.titleSmall)
        Text(
            stringResource(role.hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (photo == null) {
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                BrandSecondaryButton(
                    text = stringResource(R.string.prospect_take_photo),
                    modifier = Modifier.weight(1f),
                ) { actions.takePhoto(role) }
                BrandSecondaryButton(
                    text = stringResource(R.string.prospect_library),
                    modifier = Modifier.weight(1f),
                ) { actions.pickPhoto(role) }
            }
        } else {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    photo.name,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { actions.removePhoto(role) }) {
                    Text(stringResource(R.string.prospect_remove))
                }
            }
        }
    }
}

@Composable
private fun ResultCard(response: ProspectResponse, state: ProspectViewModel.State) {
    // Read here rather than passed in: a custom tab needs a real Context, and
    // taking one as a parameter forced it through the whole screen body.
    val context = LocalContext.current
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        if (!response.identified) {
            // Naming the failure as "we couldn't read it" rather than showing an
            // empty result: the seller can fix this with a better photo, and
            // that is the only useful thing to tell them.
            Text(stringResource(R.string.prospect_couldn_t_read_that_one), style = MaterialTheme.typography.titleMedium)
            Text(
                response.note
                    ?: stringResource(R.string.prospect_retry_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            return
        }

        Text(stringResource(state.verdict), style = MaterialTheme.typography.titleLarge)
        Text(
            ProspectDisplay.buyTitle(response.item)
                ?: stringResource(R.string.prospect_untitled_item),
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
            stringResource(
                R.string.prospect_sells_for,
                ProspectDisplay.priceRange(response.stats).text(),
            ),
            style = MaterialTheme.typography.bodyMedium,
        )
        ProspectDisplay.marginLabel(response.decision)?.let { margin ->
            val roi = margin.roiPercent
            Text(
                if (roi == null) {
                    stringResource(R.string.prospect_margin, margin.profit)
                } else {
                    stringResource(R.string.prospect_margin_with_roi, margin.profit, roi)
                },
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        ProspectDisplay.sellThroughLabel(response.sellThrough)?.let { pace ->
            Text(
                stringResource(
                    R.string.prospect_sell_through,
                    stringResource(pace.pace),
                    pace.daysLow,
                    pace.daysHigh,
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        response.grade?.let { grade ->
            Text(
                stringResource(
                    R.string.prospect_graded,
                    "%.1f".format(grade.value),
                    Math.round(grade.confidence * 100),
                ),
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
            InfoCard(
                stringResource(R.string.prospect_take_this_with_pinch_salt),
                it.text(),
                tone = InfoTone.Warning,
            )
        }

        response.ebaySoldSearchUrl?.let { url ->
            // The eBay app, not a Custom Tab: this is the one screen where the
            // destination app beats the mobile web page, because the seller is
            // already signed in there and the sold search is the reason they
            // opened GradeThread in the aisle.
            TextButton(onClick = { CustomTabsLauncher.openInMarketplaceApp(context, url) }) {
                Text(stringResource(R.string.prospect_see_sold_listings))
            }
            // US-3026: the terms, on screen, before the tap. The link used to say
            // only "See the sold listings", so a thin identification opened the
            // completed search for the brand alone and nothing on the card said
            // so - the seller found out on eBay's page, which is too late.
            response.ebaySoldSearchQuery?.takeIf { it.isNotBlank() }?.let { terms ->
                Text(
                    stringResource(R.string.prospect_sold_search_terms, terms),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            // The wider search. Two links because neither of us can tell in
            // advance which garment eBay has ten of: five right words are right
            // until they return an empty page, and an empty sold page reads as
            // "nothing like this ever sold".
            response.ebayBroadSearchUrl?.let { broadUrl ->
                TextButton(onClick = { CustomTabsLauncher.openInMarketplaceApp(context, broadUrl) }) {
                    Text(
                        stringResource(
                            R.string.prospect_search_wider,
                            response.ebayBroadSearchQuery.orEmpty(),
                        ),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
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

/**
 * Process [raw] and hand the RESULT to the ViewModel, or say it failed.
 *
 * Fails CLOSED, the same way CaptureScreen does: the raw file is deleted either
 * way, so a later change cannot pick it up, and a failure sets an error rather
 * than quietly falling back to the unprocessed bytes. A fallback here would be
 * indistinguishable from success and would ship exactly what this exists to
 * stop.
 */
private suspend fun useProcessed(viewModel: ProspectViewModel, role: ProspectPhotoRole, raw: File) {
    val processed = runCatching { PhotoProcessor.process(raw, raw.parentFile ?: raw) }.getOrNull()
    raw.delete()
    if (processed == null) viewModel.photoUnreadable() else viewModel.setPhoto(role, processed.file)
}

/** Copy a picked image into our own cache so the processor has a real file. */
private fun stageProspectPhoto(context: android.content.Context, uri: android.net.Uri): File {
    val dir = File(context.cacheDir, "prospect-capture").apply { mkdirs() }
    val file = File(dir, "prospect_${System.nanoTime()}.jpg")
    context.contentResolver.openInputStream(uri)?.use { input ->
        file.outputStream().use { output -> input.copyTo(output) }
    }
    return file
}
