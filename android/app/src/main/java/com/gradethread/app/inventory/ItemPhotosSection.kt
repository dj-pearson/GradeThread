package com.gradethread.app.inventory

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import coil.compose.AsyncImage
import com.gradethread.app.capture.FlipdeskPhotoType
import com.gradethread.app.capture.PhotoImport
import com.gradethread.app.capture.PhotoProfile
import com.gradethread.app.sync.db.ItemPhotoEntity
import com.gradethread.app.ui.text
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1344: the canvas photos strip — add, reorder, set cover, remove, plus the
 * item-level overflow (duplicate, delete, share certificate).
 */
@Composable
fun ItemPhotosSection(
    itemId: String,
    onDuplicated: (String) -> Unit,
    onDeleted: () -> Unit,
    onShareCertificate: (() -> Unit)?,
    modifier: Modifier = Modifier,
    viewModel: ItemPhotosViewModel = hiltViewModel(),
) {
    LaunchedEffect(itemId) { viewModel.bind(itemId) }
    val confirmed by viewModel.photos.collectAsState()
    val state by viewModel.state.collectAsState()
    val profile by viewModel.profile.collectAsState()
    val ordered = viewModel.displayed(confirmed)

    // US-2978: the callback is not among this effect's keys, so the block
    // carries whichever closure existed when the key last changed. Read it
    // through rememberUpdatedState rather than adding it to the keys —
    // restarting on a lambda that changes every recomposition would re-run
    // the effect for no reason.
    val currentOnDuplicated by rememberUpdatedState(onDuplicated)
    val currentOnDeleted by rememberUpdatedState(onDeleted)
    LaunchedEffect(state.duplicatedItemId) {
        state.duplicatedItemId?.let {
            viewModel.onNavigated()
            currentOnDuplicated(it)
        }
    }
    LaunchedEffect(state.deleted) { if (state.deleted) currentOnDeleted() }

    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(PhotoImport.MAX_PICK),
    ) { uris -> viewModel.add(itemId, uris, confirmed) }

    var overflowOpen by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }

    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                stringResource(R.string.photos_count, ordered.size),
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            Box {
                TextButton(onClick = { overflowOpen = true }) { Text(stringResource(R.string.photos_more)) }
                DropdownMenu(overflowOpen, onDismissRequest = { overflowOpen = false }) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.photos_duplicate_item)) },
                        onClick = {
                            overflowOpen = false
                            viewModel.duplicateItem(itemId)
                        },
                    )
                    onShareCertificate?.let { share ->
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.photos_share_certificate)) },
                            onClick = {
                                overflowOpen = false
                                share()
                            },
                        )
                    }
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.photos_delete_item)) },
                        onClick = {
                            overflowOpen = false
                            confirmDelete = true
                        },
                    )
                }
            }
        }

        val missing = remember(confirmed, profile) {
            PhotoOrdering.missingRequiredSlots(confirmed, profile)
        }
        if (missing.isNotEmpty()) {
            // Named, not counted: "2 photos missing" makes the seller work out
            // which two.
            Text(
                stringResource(
                    R.string.photos_still_needed,
                    // `map` is inline, so text() stays in a composable scope;
                    // joinToString is not.
                    missing.map { it.label.text() }.joinToString(),
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }

        if (ordered.isEmpty()) {
            Text(
                stringResource(R.string.photos_no_photos_yet),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                items(ordered, key = { it.id }) { photo ->
                    val index = ordered.indexOfFirst { it.id == photo.id }
                    PhotoTile(
                        photo = photo,
                        profile = profile,
                        onRetag = { type, role -> viewModel.retag(photo.id, type, role) },
                        isCover = index == 0,
                        canMoveLeft = index > 0,
                        canMoveRight = index < ordered.lastIndex,
                        onMoveLeft = {
                            viewModel.move(confirmed, index, index - 1)
                            viewModel.commitOrder()
                        },
                        onMoveRight = {
                            viewModel.move(confirmed, index, index + 1)
                            viewModel.commitOrder()
                        },
                        onSetCover = { viewModel.setCover(confirmed, index) },
                        onRemove = { viewModel.remove(confirmed, photo.id) },
                    )
                }
            }
        }

        BrandSecondaryButton(
            text = stringResource(R.string.photos_add_photos),
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth(),
        ) {
            picker.launch(
                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
            )
        }

        state.errorMessage?.let { message ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    message.text(),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = viewModel::dismissError) { Text(stringResource(R.string.photos_dismiss)) }
            }
        }
    }

    if (confirmDelete) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text(stringResource(R.string.photos_delete_this_item)) },
            text = {
                Text(
                    stringResource(R.string.photos_delete_body),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = false
                    viewModel.deleteItem(itemId)
                }) {
                    Text(stringResource(R.string.photos_delete))
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = false }) { Text(stringResource(R.string.photos_cancel)) }
            },
        )
    }
}

@Composable
private fun PhotoTile(
    photo: ItemPhotoEntity,
    profile: PhotoProfile,
    onRetag: (String, String?) -> Unit,
    isCover: Boolean,
    canMoveLeft: Boolean,
    canMoveRight: Boolean,
    onMoveLeft: () -> Unit,
    onMoveRight: () -> Unit,
    onSetCover: () -> Unit,
    onRemove: () -> Unit,
) {
    // US-2469: the seller-facing name for this (type, role) pair. This used to
    // be `photo.photoType` rendered raw, which is how a measured chest showed
    // up under the tile as the literal string `measurement_chest`.
    val tagLabel = FlipdeskPhotoType.label(photo.photoType, photo.photoRole, profile).text()
    // Resolved out here: `semantics { }` is not a composable scope, so a
    // stringResource call inside it does not compile.
    val spoken = stringResource(
        if (isCover) R.string.photos_spoken_cover else R.string.photos_spoken,
        tagLabel,
    )
    Column(
        Modifier.width(120.dp).semantics { contentDescription = spoken },
    ) {
        Box {
            AsyncImage(
                // The thumbnail is preferred but can lag a re-encode, so the
                // full URL is the fallback rather than a blank tile.
                model = photo.thumbnailUrl?.takeIf { it.isNotBlank() } ?: photo.photoUrl,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier
                    .size(120.dp)
                    .background(
                        MaterialTheme.colorScheme.surfaceVariant,
                        RoundedCornerShape(8.dp),
                    ),
            )
            if (isCover) {
                Text(
                    stringResource(R.string.photos_cover),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onPrimary,
                    modifier = Modifier
                        .align(Alignment.BottomStart)
                        .padding(Spacing.xxs)
                        .background(
                            MaterialTheme.colorScheme.primary,
                            RoundedCornerShape(4.dp),
                        )
                        .padding(horizontal = 4.dp),
                )
            }
        }
        RetagMenu(
            label = tagLabel,
            photoType = photo.photoType,
            photoRole = photo.photoRole,
            profile = profile,
            onRetag = onRetag,
        )
        Row {
            if (canMoveLeft) {
                TextButton(onClick = onMoveLeft, contentPadding = tight) { Text(stringResource(R.string.photos_text)) }
            }
            if (canMoveRight) {
                TextButton(onClick = onMoveRight, contentPadding = tight) {
                    Text(stringResource(R.string.photos_text_2))
                }
            }
            if (!isCover) {
                TextButton(onClick = onSetCover, contentPadding = tight) { Text(stringResource(R.string.photos_cover)) }
            }
            TextButton(onClick = onRemove, contentPadding = tight) {
                Text(stringResource(R.string.photos_remove), color = MaterialTheme.colorScheme.error)
            }
        }
    }
}

/**
 * US-2469: the retag menu. The photo's own label IS the control — a seller
 * looking at a mislabelled photo taps the wrong label, which is the shortest
 * path there is from noticing to fixing.
 *
 * Two sections, matching web and iOS: this item's own profile first in capture
 * order, then every other type A-Z. Nothing is hidden; anything not suggested
 * is demoted. The grouping rule lives in [PhotoTagOptions] so it can be tested
 * without Compose.
 */
@Composable
private fun RetagMenu(
    label: String,
    photoType: String,
    photoRole: String?,
    profile: PhotoProfile,
    onRetag: (String, String?) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    val menu = remember(photoType, photoRole, profile) {
        PhotoTagOptions.build(photoType, photoRole, profile)
    }
    Box {
        TextButton(onClick = { open = true }, contentPadding = tight) {
            Text(
                label,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        DropdownMenu(open, onDismissRequest = { open = false }) {
            // A photo still on a retired type has no matching choice, so
            // without this row the menu would show nothing selected and the
            // seller would have no idea what they were changing FROM.
            menu.orphan?.let { orphan ->
                DropdownMenuItem(
                    text = {
                        Text(
                            stringResource(R.string.photos_retag_old_tag, orphan.label),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    },
                    enabled = false,
                    onClick = {},
                )
            }
            if (menu.suggested.isNotEmpty()) {
                RetagSectionHeader(
                    stringResource(R.string.photos_retag_suggested, profile.label),
                )
                menu.suggested.forEach { choice ->
                    RetagChoice(choice, menu.current) {
                        open = false
                        onRetag(choice.type, choice.role)
                    }
                }
            }
            RetagSectionHeader(stringResource(R.string.photos_retag_all_types))
            menu.allTypes.forEach { choice ->
                RetagChoice(choice, menu.current) {
                    open = false
                    onRetag(choice.type, choice.role)
                }
            }
        }
    }
}

@Composable
private fun RetagSectionHeader(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = Spacing.sm, vertical = Spacing.xxs),
    )
}

@Composable
private fun RetagChoice(choice: PhotoTagOptions.Choice, current: String, onPick: () -> Unit) {
    val isCurrent = choice.slot == current
    DropdownMenuItem(
        text = { Text(choice.label.text()) },
        enabled = !isCurrent,
        trailingIcon = if (isCurrent) {
            { Text(stringResource(R.string.photos_retag_current)) }
        } else {
            null
        },
        onClick = onPick,
    )
}

private val tight = androidx.compose.foundation.layout.PaddingValues(horizontal = 4.dp)
