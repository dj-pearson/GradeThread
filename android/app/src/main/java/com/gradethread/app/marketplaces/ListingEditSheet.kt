package com.gradethread.app.marketplaces

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import com.gradethread.app.R
import com.gradethread.app.importer.ImportValue
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing

/**
 * US-2490: what a seller can do to a listing that is already live.
 *
 * Publishing from the phone used to be a one-way door — the listing went up and
 * could not be touched again without a computer. These are the three things
 * that door was missing.
 *
 * The price is its own action rather than part of the save. It goes through the
 * price endpoint, which pushes the offer price WITHOUT re-asserting the title,
 * description, photos or specifics — so a quick price drop cannot accidentally
 * publish a half-finished draft edit sitting in the database.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ListingEditSheet(
    listing: ListingCardModel,
    busy: Boolean,
    onDismiss: () -> Unit,
    onReprice: (Double) -> Unit,
    onRevise: () -> Unit,
    onEnd: () -> Unit,
) {
    var priceText by remember(listing.id) { mutableStateOf("") }
    var confirmingEnd by remember(listing.id) { mutableStateOf(false) }
    // The importer's parser, not toDoubleOrNull: it already handles a comma
    // decimal separator and a currency symbol, which is what a seller types.
    val price = ImportValue.price(priceText)

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier.fillMaxWidth().padding(Spacing.md),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            Text(
                stringResource(R.string.listingedit_title, listing.platformLabel),
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                stringResource(R.string.listingedit_current_price, listing.priceText),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            OutlinedTextField(
                value = priceText,
                onValueChange = { priceText = it },
                label = { Text(stringResource(R.string.listingedit_new_price)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                modifier = Modifier.fillMaxWidth(),
            )
            BrandPrimaryButton(
                text = stringResource(R.string.listingedit_reprice),
                modifier = Modifier.fillMaxWidth(),
                // A blank or unparseable box is not a price. Sending zero would
                // be refused by eBay, and sending the old one is a no-op the
                // seller would read as the button not working.
                enabled = !busy && price != null && price > 0.0,
            ) { price?.let(onReprice) }

            Text(
                stringResource(R.string.listingedit_resubmit_help),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            BrandSecondaryButton(
                text = stringResource(R.string.listingedit_resubmit),
                modifier = Modifier.fillMaxWidth(),
                enabled = !busy,
            ) { onRevise() }

            // Ending is the one action here that cannot be undone by doing it
            // again, so it asks first. Relisting mints a new listing and loses
            // the watchers and the sales history on the old one.
            if (confirmingEnd) {
                Text(
                    stringResource(R.string.listingedit_end_confirm),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
                BrandSecondaryButton(
                    text = stringResource(R.string.listingedit_end_yes),
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !busy,
                ) { onEnd() }
                TextButton(onClick = { confirmingEnd = false }) {
                    Text(stringResource(R.string.listingedit_end_no))
                }
            } else {
                TextButton(onClick = { confirmingEnd = true }, enabled = !busy) {
                    Text(
                        stringResource(R.string.listingedit_end),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        }
    }
}
