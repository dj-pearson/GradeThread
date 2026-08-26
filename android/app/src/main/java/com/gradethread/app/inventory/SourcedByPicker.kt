package com.gradethread.app.inventory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.foundation.text.KeyboardOptions
import com.gradethread.app.R
import com.gradethread.app.ui.components.LabeledDropdown

/**
 * US-2886: "Sourced by" is a pick from the workspace roster, not a typed name.
 *
 * Web parity with `src/components/flipdesk/sourced-by-select.tsx`, and the same
 * on iOS in `SourcedByField.swift`. The value written out is still the plain
 * NAME, because that is what `inventory_items.sourced_by` stores everywhere.
 *
 * @param value the currently stored name, or blank
 * @param onValueChange called with the picked (or newly added) name
 * @param sourcers the synced roster, archived entries included — this filters them
 * @param onAddPerson performs the add; returns the name to select, or null on
 *   failure. Null means the row was not written, so the picker says so instead
 *   of pretending.
 */
@Composable
fun SourcedByPicker(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    sourcers: SourcerRoster,
    onAddPerson: (String, (String?) -> Unit) -> Unit,
    modifier: Modifier = Modifier,
) {
    var adding by remember { mutableStateOf(false) }
    var draftName by remember { mutableStateOf("") }
    var failed by remember { mutableStateOf(false) }

    val trimmed = value.trim()
    // An archived person stays visible while they are the current value, and a
    // name typed before this field became a picker stays selectable — otherwise
    // opening an old item would silently drop its attribution.
    val roster = sourcers.entries
    val names = buildList {
        if (trimmed.isNotEmpty() && roster.none { it.name.equals(trimmed, ignoreCase = true) }) {
            add(trimmed)
        }
        addAll(
            roster
                .filter { it.archivedAt == null || it.name.equals(trimmed, ignoreCase = true) }
                .map { it.name },
        )
    }.distinct()

    Column(modifier) {
        LabeledDropdown(
            label = label,
            selected = trimmed.ifEmpty { null },
            options = names,
            optionLabel = { it },
            onSelect = onValueChange,
            placeholder = stringResource(R.string.sourced_by_not_set),
            modifier = Modifier.fillMaxWidth(),
        )

        if (adding) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = draftName,
                    onValueChange = {
                        draftName = it
                        failed = false
                    },
                    label = { Text(stringResource(R.string.sourced_by_new_name)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.Words,
                    ),
                    modifier = Modifier.weight(1f),
                )
                TextButton(
                    onClick = {
                        val name = draftName.trim()
                        if (name.isEmpty()) return@TextButton
                        onAddPerson(name) { saved ->
                            if (saved == null) {
                                failed = true
                            } else {
                                onValueChange(saved)
                                draftName = ""
                                adding = false
                                failed = false
                            }
                        }
                    },
                    enabled = draftName.isNotBlank(),
                ) { Text(stringResource(R.string.sourced_by_add)) }
                TextButton(
                    onClick = {
                        draftName = ""
                        adding = false
                        failed = false
                    },
                ) { Text(stringResource(R.string.common_cancel)) }
            }
            if (failed) {
                Text(
                    text = stringResource(R.string.sourced_by_add_failed),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        } else {
            TextButton(onClick = { adding = true }) {
                Text(stringResource(R.string.sourced_by_add_person))
            }
        }
    }
}
