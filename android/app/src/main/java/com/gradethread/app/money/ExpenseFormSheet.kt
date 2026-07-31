package com.gradethread.app.money

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import com.gradethread.app.R
import com.gradethread.app.ui.components.LabeledDropdown
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/**
 * US-1364: add / edit an expense (iOS `ExpenseFormSheet`).
 *
 * All validation lives in [ExpenseDraft] — this file only binds fields to it, so
 * the rules are unit-tested without a Compose harness.
 *
 * The date is a plain `YYYY-MM-DD` text field rather than a Material date picker:
 * the picker in Material3 is a large dependency surface for a field sellers
 * overwhelmingly leave at today, and a free-text date that REJECTS what it can't
 * parse (rather than silently substituting today) is honest about what it stored.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ExpenseFormSheet(
    initial: ExpenseDraft,
    onDismiss: () -> Unit,
    onSave: (ExpenseDraft) -> Unit,
) {
    // Keyed on the row being edited so reopening the sheet for a DIFFERENT
    // expense reseeds the fields; keying on the whole draft would discard the
    // seller's typing on every keystroke.
    var draft by remember(initial.id) { mutableStateOf(initial) }
    var dateText by remember(initial.id) {
        mutableStateOf(ExpenseDraft.isoDate(initial.spentOnMs))
    }

    val parsedDate = remember(dateText) { parseIsoDate(dateText) }
    val dateError = if (dateText.isNotBlank() && parsedDate == null) {
        stringResource(R.string.expense_date_invalid)
    } else {
        null
    }
    val validation = draft.validate()

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .padding(horizontal = Spacing.md)
                .padding(bottom = Spacing.xl),
        ) {
            Text(
                if (initial.id == null) {
                    stringResource(R.string.expense_add_title)
                } else {
                    stringResource(R.string.expense_edit_title)
                },
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(bottom = Spacing.sm),
            )

            LabeledDropdown(
                label = stringResource(R.string.common_category),
                selected = draft.category,
                options = ExpenseDraft.CATEGORIES.map { it.first },
                optionLabel = { ExpenseDraft.labelFor(it) },
                onSelect = { draft = draft.copy(category = it) },
                modifier = Modifier.fillMaxWidth().padding(bottom = Spacing.xs),
            )

            OutlinedTextField(
                value = draft.amountText,
                onValueChange = { draft = draft.copy(amountText = it) },
                label = { Text(stringResource(R.string.common_amount)) },
                prefix = { Text(com.gradethread.app.capture.CurrencyAmount.SYMBOL) },
                // Decimal keyboard, but the text is still parsed leniently:
                // some IMEs offer a comma on a decimal pad regardless.
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                singleLine = true,
                isError = draft.amountText.isNotBlank() && !draft.isValid,
                modifier = Modifier.fillMaxWidth().padding(bottom = Spacing.xs),
            )

            OutlinedTextField(
                value = dateText,
                onValueChange = { dateText = it },
                label = { Text(stringResource(R.string.expense_date_spent)) },
                supportingText = {
                    Text(
                        dateError
                            ?: parsedDate?.let { formatFriendly(it) }
                            ?: stringResource(R.string.expense_date_format_hint),
                    )
                },
                isError = dateError != null,
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(bottom = Spacing.xs),
            )

            OutlinedTextField(
                value = draft.description,
                onValueChange = { draft = draft.copy(description = it) },
                label = { Text(stringResource(R.string.expense_note_optional)) },
                modifier = Modifier.fillMaxWidth().padding(bottom = Spacing.xs),
            )

            validation?.takeIf { draft.amountText.isNotBlank() }?.let { message ->
                Text(
                    message,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(bottom = Spacing.xs),
                )
            }

            BrandPrimaryButton(
                text = stringResource(R.string.common_save),
                // Disabled rather than failing on submit: the button state is
                // the only place the seller learns the amount isn't usable yet.
                enabled = validation == null && dateError == null,
                modifier = Modifier.fillMaxWidth().padding(bottom = Spacing.xs),
            ) {
                val spentOn = parsedDate
                    ?.atStartOfDay(ZoneId.systemDefault())
                    ?.toInstant()
                    ?.toEpochMilli()
                    ?: draft.spentOnMs
                onSave(draft.copy(spentOnMs = spentOn))
            }
            BrandSecondaryButton(
                text = stringResource(R.string.common_cancel),
                modifier = Modifier.fillMaxWidth(),
            ) {
                onDismiss()
            }
        }
    }
}

private fun parseIsoDate(text: String): LocalDate? =
    runCatching { LocalDate.parse(text.trim()) }.getOrNull()

private fun formatFriendly(date: LocalDate, locale: Locale = Locale.getDefault()): String =
    runCatching {
        date.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale))
    }.getOrElse { date.toString() }
