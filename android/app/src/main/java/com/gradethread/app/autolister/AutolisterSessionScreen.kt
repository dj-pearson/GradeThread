package com.gradethread.app.autolister

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import coil.compose.AsyncImage
import com.gradethread.app.R
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-2408: the AutoLister batch screen.
 *
 * A batch is many garments in one roll of photos, so the whole screen is built
 * around the one question that matters: which photos belong to which item. The
 * model can propose an answer and check its own work, but nothing it says is
 * applied without a tap — a wrong merge publishes one listing carrying another
 * item's photos.
 */
@Composable
fun AutolisterSessionScreen(onClose: () -> Unit, viewModel: AutolisterSessionViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()
    var selected by remember { mutableStateOf(setOf<String>()) }

    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(AutolisterGroups.MAX_PHOTOS),
    ) { uris -> viewModel.importPhotos(uris) }

    if (state.loading) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }

    LazyColumn(
        Modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        item {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    stringResource(R.string.autolister_session_title),
                    style = MaterialTheme.typography.headlineMedium,
                    modifier = Modifier.weight(1f),
                )
                BrandPrimaryButton(
                    text = stringResource(R.string.autolister_add_photos),
                    enabled = state.busy == null && state.remainingCapacity > 0,
                ) {
                    picker.launch(
                        PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                    )
                }
            }
        }

        state.busy?.let { busy -> item { BusyBanner(busy, state) } }

        state.errorMessage?.let { message ->
            item {
                Column(Modifier.fillMaxWidth().cardStyle()) {
                    Text(
                        message,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.error,
                    )
                    TextButton(onClick = viewModel::dismissError) {
                        Text(stringResource(R.string.common_dismiss))
                    }
                }
            }
        }

        state.sentPhotoCount?.let { count ->
            item {
                Column(Modifier.fillMaxWidth().cardStyle()) {
                    Text(
                        stringResource(R.string.autolister_sent, count),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    TextButton(onClick = viewModel::dismissError) {
                        Text(stringResource(R.string.common_dismiss))
                    }
                }
            }
        }

        if (state.photos.isEmpty()) {
            item {
                Text(
                    stringResource(R.string.autolister_empty),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.fillMaxWidth().cardStyle(),
                )
            }
        }

        // The two metered passes. Their cost is stated up front because each
        // window is a billed AI action and a 120-photo roll is three of them.
        if (state.photos.isNotEmpty()) {
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                    BrandSecondaryButton(
                        text = stringResource(R.string.autolister_propose, state.proposeWindows),
                        enabled = state.canPropose,
                    ) { viewModel.proposeGroups() }
                    BrandSecondaryButton(
                        text = stringResource(R.string.autolister_verify),
                        enabled = state.canVerify,
                    ) { viewModel.verifyGroups() }
                }
            }
        }

        items(state.session.suggestions, key = { it.type + it.groupIds.joinToString() }) { s ->
            SuggestionCard(s, viewModel)
        }

        items(state.groups, key = { it.id }) { group ->
            GroupCard(group, state, selected, viewModel) { selected = it }
        }

        if (state.ungrouped.isNotEmpty()) {
            item {
                Text(
                    stringResource(R.string.autolister_ungrouped, state.ungrouped.size),
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(top = Spacing.sm),
                )
            }
            item {
                PhotoStrip(
                    photos = state.ungrouped,
                    selected = selected,
                    coverId = null,
                    onTap = { id -> selected = selected.toggle(id) },
                )
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                    BrandSecondaryButton(
                        text = stringResource(R.string.autolister_group_selected),
                        enabled = selected.isNotEmpty(),
                    ) {
                        viewModel.groupSelected(selected.toList())
                        selected = emptySet()
                    }
                    if (selected.isNotEmpty()) {
                        BrandSecondaryButton(text = stringResource(R.string.autolister_remove)) {
                            selected.forEach(viewModel::removePhoto)
                            selected = emptySet()
                        }
                    }
                }
            }
        }

        if (state.photos.isNotEmpty()) {
            item {
                BrandPrimaryButton(
                    text = stringResource(R.string.autolister_send),
                    modifier = Modifier.fillMaxWidth().padding(top = Spacing.sm),
                    enabled = state.canSend,
                ) { viewModel.sendToDesktop() }
            }
            item {
                Text(
                    stringResource(R.string.autolister_send_help),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        if (state.waiting.isNotEmpty()) {
            item {
                Text(
                    stringResource(R.string.autolister_waiting_header),
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(top = Spacing.sm),
                )
            }
            items(state.waiting, key = { it.id }) { waiting ->
                Column(Modifier.fillMaxWidth().cardStyle()) {
                    Text(
                        stringResource(
                            R.string.autolister_waiting_row,
                            waiting.photoCount,
                            waiting.groupCount,
                        ),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    TextButton(onClick = { viewModel.discardWaiting(waiting.id) }) {
                        Text(stringResource(R.string.autolister_discard))
                    }
                }
            }
        }

        item {
            BrandSecondaryButton(
                text = stringResource(R.string.common_back),
                modifier = Modifier.fillMaxWidth().padding(top = Spacing.sm),
            ) { onClose() }
        }
    }
}

private fun Set<String>.toggle(id: String): Set<String> = if (id in this) this - id else this + id

@Composable
private fun BusyBanner(busy: AutolisterSessionViewModel.Busy, state: AutolisterSessionViewModel.State) {
    Column(Modifier.fillMaxWidth().cardStyle()) {
        Text(
            when (busy) {
                AutolisterSessionViewModel.Busy.IMPORTING ->
                    stringResource(R.string.autolister_busy_importing, state.done, state.total)
                AutolisterSessionViewModel.Busy.PROPOSING ->
                    stringResource(R.string.autolister_busy_proposing)
                AutolisterSessionViewModel.Busy.VERIFYING ->
                    stringResource(R.string.autolister_busy_verifying)
                AutolisterSessionViewModel.Busy.SENDING ->
                    stringResource(R.string.autolister_busy_sending)
            },
            style = MaterialTheme.typography.bodyMedium,
        )
        if (state.total > 0) {
            LinearProgressIndicator(
                progress = { state.done.toFloat() / state.total.toFloat() },
                modifier = Modifier.fillMaxWidth().padding(top = Spacing.xs),
            )
        }
        if (state.skipped > 0) {
            Text(
                stringResource(R.string.autolister_skipped, state.skipped),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun SuggestionCard(suggestion: GroupSuggestion, viewModel: AutolisterSessionViewModel) {
    Column(Modifier.fillMaxWidth().cardStyle()) {
        Text(
            suggestion.reason.ifBlank { stringResource(R.string.autolister_suggestion_fallback) },
            style = MaterialTheme.typography.bodyMedium,
        )
        Row {
            TextButton(onClick = { viewModel.applySuggestion(suggestion) }) {
                Text(stringResource(R.string.autolister_apply))
            }
            TextButton(onClick = { viewModel.dismissSuggestion(suggestion) }) {
                Text(stringResource(R.string.common_dismiss))
            }
        }
    }
}

@Composable
private fun GroupCard(
    group: SessionGroup,
    state: AutolisterSessionViewModel.State,
    selected: Set<String>,
    viewModel: AutolisterSessionViewModel,
    onSelected: (Set<String>) -> Unit,
) {
    val photos = state.session.photosOf(group.id)
    Column(Modifier.fillMaxWidth().cardStyle()) {
        Text(
            pluralStringResource(R.plurals.autolister_group_size, photos.size, photos.size),
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
        )
        PhotoStrip(
            photos = photos,
            selected = selected,
            coverId = group.coverId,
            onTap = { id -> onSelected(selected.toggle(id)) },
        )
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            val inThisGroup = selected.filter { id -> photos.any { it.id == id } }
            if (inThisGroup.size == 1) {
                TextButton(onClick = {
                    viewModel.setCover(group.id, inThisGroup.first())
                    onSelected(emptySet())
                }) { Text(stringResource(R.string.autolister_set_cover)) }
            }
            if (inThisGroup.isNotEmpty() && inThisGroup.size < photos.size) {
                TextButton(onClick = {
                    viewModel.splitFromGroup(group.id, inThisGroup)
                    onSelected(emptySet())
                }) { Text(stringResource(R.string.autolister_split)) }
            }
            // Photos picked from somewhere ELSE move in here. Same selection,
            // different verb — which one applies depends on where the seller
            // tapped, and offering both would be a puzzle.
            val fromElsewhere = selected.filterNot { id -> photos.any { it.id == id } }
            if (fromElsewhere.isNotEmpty()) {
                TextButton(onClick = {
                    viewModel.moveToGroup(fromElsewhere, group.id)
                    onSelected(emptySet())
                }) { Text(stringResource(R.string.autolister_move_here)) }
            }
            TextButton(onClick = { viewModel.ungroup(group.id) }) {
                Text(stringResource(R.string.autolister_ungroup))
            }
        }
    }
}

@Composable
private fun PhotoStrip(photos: List<SessionPhoto>, selected: Set<String>, coverId: String?, onTap: (String) -> Unit) {
    val coverLabel = stringResource(R.string.autolister_cover)
    val photoLabel = stringResource(R.string.autolister_photo)
    LazyRow(
        Modifier.fillMaxWidth().padding(vertical = Spacing.xs),
        horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        items(photos, key = { it.id }) { photo ->
            val isSelected = photo.id in selected
            AsyncImage(
                model = photo.displayUrl,
                contentDescription = if (photo.id == coverId) coverLabel else photoLabel,
                contentScale = ContentScale.Crop,
                modifier = Modifier
                    .size(84.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant)
                    .border(
                        width = if (isSelected) 3.dp else 1.dp,
                        color = if (isSelected) {
                            MaterialTheme.colorScheme.primary
                        } else {
                            MaterialTheme.colorScheme.outlineVariant
                        },
                        shape = RoundedCornerShape(12.dp),
                    )
                    .clickable { onTap(photo.id) },
            )
        }
    }
}
