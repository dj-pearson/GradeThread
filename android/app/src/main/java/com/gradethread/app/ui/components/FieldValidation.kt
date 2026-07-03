package com.gradethread.app.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.tooling.preview.Preview
import com.gradethread.app.ui.theme.GradeThreadTheme
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1303: inline field validation (iOS InlineFieldValidation + FieldError).
 * The error renders under the field AND is announced to TalkBack via the
 * error semantics — never color-only.
 */

/** Small error line under a field. Null/blank renders nothing. */
@Composable
fun FieldError(message: String?, modifier: Modifier = Modifier) {
    if (message.isNullOrBlank()) return
    Text(
        text = message,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.error,
        modifier = modifier
            .padding(top = Spacing.xxs)
            .semantics {
                error(message)
                // US-1304: announced when it APPEARS, not only when focused.
                liveRegion = LiveRegionMode.Polite
            },
    )
}

/**
 * A branded text field with built-in inline validation: `errorMessage`
 * non-null puts the field into its error state and renders + announces the
 * message. Controlled (value/onValueChange), mirroring the app convention.
 */
@Composable
fun ValidatedTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    errorMessage: String? = null,
    singleLine: Boolean = true,
    enabled: Boolean = true,
) {
    Column(modifier) {
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            label = { Text(label) },
            isError = errorMessage != null,
            singleLine = singleLine,
            enabled = enabled,
        )
        FieldError(errorMessage)
    }
}

@Preview(showBackground = true)
@Composable
private fun ValidatedTextFieldPreview() {
    GradeThreadTheme {
        Column(Modifier.padding(Spacing.md)) {
            ValidatedTextField(value = "", onValueChange = {}, label = "Email")
            ValidatedTextField(
                value = "not-an-email",
                onValueChange = {},
                label = "Email",
                errorMessage = "Enter a valid email address.",
                modifier = Modifier.padding(top = Spacing.sm),
            )
        }
    }
}
