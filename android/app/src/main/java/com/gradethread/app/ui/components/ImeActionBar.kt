package com.gradethread.app.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.gradethread.app.ui.theme.GradeThreadTheme
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1303: the keyboard action bar (iOS KeyboardToolbar). Android's IME
 * carries its own action key, so MOST fields should just set
 * `keyboardOptions(imeAction = …)` — this bar exists for multi-field forms
 * that need an explicit Done/next affordance above the keyboard (numeric
 * pads without a done key, measurement grids). Place it at the bottom of the
 * screen; `imePadding` pins it above the keyboard while one of the fields is
 * focused.
 */
@Composable
fun ImeActionBar(
    modifier: Modifier = Modifier,
    doneTitle: String = "Done",
    onDone: (() -> Unit)? = null,
) {
    val focusManager = LocalFocusManager.current
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .imePadding(),
        tonalElevation = 3.dp,
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.xs),
            horizontalArrangement = Arrangement.End,
        ) {
            TextButton(onClick = {
                focusManager.clearFocus()
                onDone?.invoke()
            }) {
                Text(doneTitle, style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}


@Preview(showBackground = true)
@Composable
private fun ImeActionBarPreview() {
    GradeThreadTheme {
        ImeActionBar()
    }
}
