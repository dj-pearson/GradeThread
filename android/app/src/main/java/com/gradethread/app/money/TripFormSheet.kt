package com.gradethread.app.money

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import com.gradethread.app.ui.components.LabeledDropdown
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/**
 * US-3000: log a mileage trip.
 *
 * All validation lives in [TripDraft] -- this file only binds fields to it, so
 * the rules are unit-tested without a Compose harness. Same split, and the same
 * free-text date field, as [ExpenseFormSheet]: a date that REJECTS what it
 * cannot parse is honest about what it stored, where a picker that silently
 * substitutes today is not.
 *
 * MILES AND THE PURPOSE ARE THE ONLY REQUIRED FIELDS, and the purpose defaults
 * to a sourcing trip. This form is filled in standing beside a car; anything it
 * insists on that the seller has to think about is a reason the trip never gets
 * logged at all, and an unlogged trip is worth nothing in April.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TripFormSheet(initial: TripDraft, onDismiss: () -> Unit, onSave: (TripDraft) -> Unit) {
    // Keyed on the row being edited so reopening the sheet for a DIFFERENT trip
    // reseeds the fields; keying on the whole draft would discard the seller's
    // typing on every keystroke.
    var draft by remember(initial.id) { mutableStateOf(initial) }
    var dateText by remember(initial.id) {
        mutableStateOf(CalendarDateField.iso(initial.tripDateMs))
    }

    val parsedDate = remember(dateText) { parseTripDate(dateText) }
    val dateError = if (dateText.isNotBlank() && parsedDate == null) {
        "Use YYYY-MM-DD."
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
                if (initial.id == null) "Log a trip" else "Edit this trip",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(bottom = Spacing.sm),
            )

            OutlinedTextField(
                value = draft.milesText,
                onValueChange = { draft = draft.copy(milesText = it) },
                label = { Text("Miles") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                singleLine = true,
                isError = draft.milesText.isNotBlank() && !draft.isValid,
                modifier = Modifier.fillMaxWidth().padding(bottom = Spacing.xs),
            )

            LabeledDropdown(
                label = "What for",
                selected = draft.purpose,
                options = TripDraft.PURPOSES.map { it.first },
                optionLabel = { TripDraft.label(it) },
                onSelect = { draft = draft.copy(purpose = it) },
                modifier = Modifier.fillMaxWidth().padding(bottom = Spacing.xs),
            )

            OutlinedTextField(
                value = dateText,
                onValueChange = { dateText = it },
                label = { Text("Date") },
                supportingText = {
                    Text(dateError ?: parsedDate?.let { friendly(it) } ?: "YYYY-MM-DD")
                },
                isError = dateError != null,
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(bottom = Spacing.xs),
            )

            OutlinedTextField(
                value = draft.startLocation,
                onValueChange = { draft = draft.copy(startLocation = it) },
                label = { Text("From (optional)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(bottom = Spacing.xs),
            )

            OutlinedTextField(
                value = draft.endLocation,
                onValueChange = { draft = draft.copy(endLocation = it) },
                label = { Text("To (optional)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(bottom = Spacing.xs),
            )

            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().padding(bottom = Spacing.xs),
            ) {
                // A note, not arithmetic. The miles field is what gets deducted,
                // so doubling it here would silently disagree with what the
                // seller typed -- and every reseller enters the round trip.
                Text(
                    "Round trip",
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(end = Spacing.sm),
                )
                Switch(
                    checked = draft.roundTrip,
                    onCheckedChange = { draft = draft.copy(roundTrip = it) },
                )
            }

            validation?.takeIf { draft.milesText.isNotBlank() }?.let { message ->
                Text(
                    message,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(bottom = Spacing.xs),
                )
            }

            BrandPrimaryButton(
                text = "Save",
                // Disabled rather than failing on submit: the button state is
                // the only place the seller learns the miles are not usable yet.
                enabled = validation == null && dateError == null,
                modifier = Modifier.fillMaxWidth().padding(bottom = Spacing.xs),
            ) {
                // US-2339 / AC3: anchored through CalendarDateField, not the
                // device zone. A date typed here and a date pulled from the
                // server have to mean the same Long, or the next sync moves it.
                val tripDate = parsedDate
                    ?.let { CalendarDateField.startOfDayMs(it) }
                    ?: draft.tripDateMs
                onSave(draft.copy(tripDateMs = tripDate))
            }
            BrandSecondaryButton(
                text = "Cancel",
                modifier = Modifier.fillMaxWidth(),
            ) {
                onDismiss()
            }
        }
    }
}

private fun parseTripDate(text: String): LocalDate? = runCatching { LocalDate.parse(text.trim()) }.getOrNull()

private fun friendly(date: LocalDate, locale: Locale = Locale.getDefault()): String = runCatching {
    date.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale))
}.getOrElse { date.toString() }
