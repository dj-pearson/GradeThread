package com.gradethread.app.platform.locale

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1393: pick the app's language.
 *
 * Applying it recreates every activity, which is why the sheet dismisses first
 * — a sheet still on screen when its host is torn down flickers, and on some
 * launchers leaves a scrim behind.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LanguagePicker(onDismiss: () -> Unit) {
    val current = AppLocale.current()
    val systemLabel = stringResource(R.string.settings_language_system)

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(bottom = Spacing.xl)) {
            Text(
                stringResource(R.string.settings_language),
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.padding(horizontal = Spacing.md, vertical = Spacing.xs),
            )
            // "Match my phone" first and always present: it is the only option
            // that stays correct when the seller changes their device language.
            (listOf(AppLocale.SYSTEM_TAG) + AppLocale.SUPPORTED.map { it.tag }).forEach { tag ->
                val label = AppLocale.label(tag, systemLabel)
                Text(
                    if (tag == current) stringResource(R.string.checked_prefix, label) else label,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable {
                            onDismiss()
                            AppLocale.apply(tag)
                        }
                        .padding(horizontal = Spacing.md, vertical = Spacing.sm),
                )
            }
        }
    }
}
