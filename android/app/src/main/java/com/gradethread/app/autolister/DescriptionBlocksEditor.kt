package com.gradethread.app.autolister

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import com.gradethread.app.R
import com.gradethread.app.ui.theme.Spacing

/**
 * US-2964: the description, as the ordered list of blocks it actually is.
 *
 * The Android port of the web composer's description card. The draft editor used
 * to hold one plain text box, and that is what made the same fact appear in more
 * than one place with only one of them updatable - a seller who fixed a
 * measurement was left with prose advertising the old number.
 *
 * So the description is rows now. Each row is one block: a switch, a tag saying
 * who owns its content, and either an in-place field (the seller's own prose) or
 * a summary of the fields it reads (everything derived). NOTHING here renders
 * the description - the edge service does, and the preview at the bottom shows
 * exactly what it returned, which is exactly what the marketplace receives.
 *
 * Reorder is up/down rather than drag: the pinned rows have to stay where they
 * are (US-2682), and a drag that snapped back would be worse than a control that
 * is simply absent on those two.
 */
@Composable
fun DescriptionBlocksEditor(
    state: DescriptionBlocksViewModel.State,
    rowContext: DescriptionBlocks.RowContext,
    onToggle: (Int) -> Unit,
    onSetText: (Int, String) -> Unit,
    onMove: (Int, Int) -> Unit,
    onRemove: (Int) -> Unit,
    onAddSnippet: (String) -> Unit,
    onRegenerate: (DescriptionBlockKey) -> Unit,
    modifier: Modifier = Modifier,
) {
    var editing by remember { mutableIntStateOf(-1) }
    var previewOpen by remember { mutableStateOf(false) }
    var snippetMenuOpen by remember { mutableStateOf(false) }

    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
        Text(
            stringResource(R.string.blocks_heading),
            style = MaterialTheme.typography.titleSmall,
        )

        if (state.unavailable) {
            Text(
                stringResource(R.string.blocks_unavailable),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
        if (state.converted) {
            Text(
                stringResource(R.string.blocks_converted),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (state.loading) {
            Text(
                stringResource(R.string.blocks_loading),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        state.blocks.forEachIndexed { index, block ->
            BlockRow(
                block = block,
                index = index,
                // A move onto a pinned row is refused by `DescriptionBlocks.move`
                // anyway; the control is absent rather than inert so the seller
                // is not offered a button that does nothing.
                canMoveUp = index > 0 &&
                    !DescriptionBlocks.isPinned(state.blocks[index - 1].key),
                canMoveDown = index < state.blocks.size - 1 &&
                    !DescriptionBlocks.isPinned(state.blocks[index + 1].key),
                rowContext = rowContext,
                editing = editing == index,
                regenerating = state.regenerating == block.key,
                busy = state.regenerating != null,
                onToggle = { onToggle(index) },
                onEditToggle = { editing = if (editing == index) -1 else index },
                onSetText = { onSetText(index, it) },
                onMove = onMove,
                onRemove = {
                    editing = -1
                    onRemove(index)
                },
                onRegenerate = { onRegenerate(block.key) },
            )
        }

        if (state.snippets.isNotEmpty()) {
            Row {
                TextButton(onClick = { snippetMenuOpen = true }) {
                    Text(stringResource(R.string.blocks_add_snippet))
                }
                DropdownMenu(
                    expanded = snippetMenuOpen,
                    onDismissRequest = { snippetMenuOpen = false },
                ) {
                    for (snippet in state.snippets) {
                        DropdownMenuItem(
                            text = { Text(snippet.name) },
                            onClick = {
                                snippetMenuOpen = false
                                onAddSnippet(snippet.id)
                            },
                        )
                    }
                }
            }
        }

        TextButton(onClick = { previewOpen = !previewOpen }) {
            Text(
                stringResource(
                    R.string.blocks_preview_toggle,
                    state.preview.length,
                ),
            )
        }
        if (previewOpen) {
            if (state.preview.isEmpty()) {
                Text(
                    stringResource(R.string.blocks_preview_empty),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                Text(
                    state.preview,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (state.previewPending) {
            Text(
                stringResource(R.string.blocks_preview_updating),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        state.message?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }
    }
}

@Composable
private fun BlockRow(
    block: DescriptionBlock,
    index: Int,
    canMoveUp: Boolean,
    canMoveDown: Boolean,
    rowContext: DescriptionBlocks.RowContext,
    editing: Boolean,
    regenerating: Boolean,
    busy: Boolean,
    onToggle: () -> Unit,
    onEditToggle: () -> Unit,
    onSetText: (String) -> Unit,
    onMove: (Int, Int) -> Unit,
    onRemove: () -> Unit,
    onRegenerate: () -> Unit,
) {
    val label = DescriptionBlocks.label(block.key)
    val pinned = DescriptionBlocks.isPinned(block.key)
    // Read outside the semantics lambda, which is not a composable scope.
    val includeDescription = stringResource(R.string.blocks_include, label)

    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = Spacing.xxs),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
        ) {
            Switch(
                checked = block.on,
                onCheckedChange = { onToggle() },
                modifier = Modifier.semantics {
                    contentDescription = includeDescription
                },
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                Text(
                    DescriptionBlocks.label(block.src),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (!editing) {
                    Text(
                        DescriptionBlocks.describe(block, rowContext),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                    )
                }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
            // The nine standard sections are switched off, not removed, so their
            // position survives and toggling one back on restores it. Only the
            // rows a seller ADDED offer a delete.
            if (!pinned) {
                TextButton(enabled = canMoveUp, onClick = { onMove(index, index - 1) }) {
                    Text(stringResource(R.string.blocks_move_up))
                }
                TextButton(enabled = canMoveDown, onClick = { onMove(index, index + 1) }) {
                    Text(stringResource(R.string.blocks_move_down))
                }
            }
            if (DescriptionBlocks.isEditable(block.key)) {
                TextButton(onClick = onEditToggle) {
                    Text(
                        stringResource(
                            if (editing) R.string.blocks_done else R.string.blocks_edit,
                        ),
                    )
                }
            }
            if (DescriptionBlocks.isRegenerable(block.key)) {
                TextButton(enabled = !busy, onClick = onRegenerate) {
                    Text(
                        stringResource(
                            if (regenerating) {
                                R.string.blocks_rewriting
                            } else {
                                R.string.blocks_rewrite
                            },
                        ),
                    )
                }
            }
            if (DescriptionBlocks.isRemovable(block.key)) {
                TextButton(onClick = onRemove) {
                    Text(stringResource(R.string.blocks_remove))
                }
            }
        }

        if (editing) {
            OutlinedTextField(
                value = block.text.orEmpty(),
                onValueChange = onSetText,
                label = { Text(label) },
                minLines = 3,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
