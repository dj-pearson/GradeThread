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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.tooling.preview.Preview
import com.gradethread.app.R
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
    /**
     * US-2976: @Composable, so a caller can resolve a @StringRes option label.
     * Every enum whose label became a resource id has to read it from a
     * composition, and a plain lambda cannot.
     */
    optionLabel: @Composable (T) -> String,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
    /** Shown when nothing is selected — e.g. "No source". */
    placeholder: String = "",
    enabled: Boolean = true,
) {
    var expanded by remember { mutableStateOf(false) }
    // `selected?.let(optionLabel)` does not compile once optionLabel is
    // @Composable: `let` is an ordinary higher-order function and cannot carry
    // a composable into it.
    val display = if (selected != null) optionLabel(selected) else placeholder
    // Hoisted: `semantics { }` is not a composable scope, so stringResource
    // cannot be called inside it.
    val fieldDescription = stringResource(R.string.a11y_field_value, label, display)

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
                    .semantics { contentDescription = fieldDescription },
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
