package com.gradethread.app.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.tooling.preview.Preview
import com.gradethread.app.ui.theme.GradeThreadTheme
import com.gradethread.app.ui.theme.MinTouchTarget

/**
 * US-1330: a labelled single-select. The repo had no picker component, so the
 * category / status / source fields share this one.
 *
 * Read-only text field rather than an editable one: the value must be one of
 * [options], and a free-text box that silently discards what you typed is
 * worse than one you can't type into.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun <T> LabeledDropdown(
    label: String,
    selected: T?,
    options: List<T>,
    optionLabel: (T) -> String,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
    /** Shown when nothing is selected — e.g. "No source". */
    placeholder: String = "",
    enabled: Boolean = true,
) {
    var expanded by remember { mutableStateOf(false) }
    val display = selected?.let(optionLabel) ?: placeholder

    Column(modifier) {
        ExposedDropdownMenuBox(
            expanded = expanded && enabled,
            onExpandedChange = { if (enabled) expanded = it },
        ) {
            OutlinedTextField(
                value = display,
                onValueChange = {},
                readOnly = true,
                enabled = enabled,
                label = { Text(label) },
                trailingIcon = {
                    ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded && enabled)
                },
                modifier = Modifier
                    // Read-only anchor: the field can't be typed into, so the
                    // menu must open on a tap anywhere in it.
                    .menuAnchor(MenuAnchorType.PrimaryNotEditable)
                    .fillMaxWidth()
                    .heightIn(min = MinTouchTarget)
                    // Announce the field's purpose AND its value together.
                    .semantics { contentDescription = "$label, $display" },
            )
            ExposedDropdownMenu(
                expanded = expanded && enabled,
                onDismissRequest = { expanded = false },
            ) {
                options.forEach { option ->
                    DropdownMenuItem(
                        text = { Text(optionLabel(option)) },
                        onClick = {
                            onSelect(option)
                            expanded = false
                        },
                    )
                }
            }
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun LabeledDropdownPreview() {
    GradeThreadTheme {
        LabeledDropdown(
            label = "Category",
            selected = "Clothing",
            options = listOf("Clothing", "Shoes"),
            optionLabel = { it },
            onSelect = {},
        )
    }
}
