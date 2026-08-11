package com.gradethread.app.marketplaces

import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import com.gradethread.app.R
import com.gradethread.app.money.Money
import com.gradethread.app.sync.db.ListingEntity
import com.gradethread.app.ui.components.StatusBadge
import com.gradethread.app.ui.components.statusLabel
import com.gradethread.app.ui.theme.GradeThreadTheme
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle
import java.util.Locale

/**
 * US-1351: the display shape of one listing, on any platform.
 *
 * A pure model, separate from the composable, so the wording rules (what a null
 * quantity says, when a listing counts as imported) are unit-tested instead of
 * only being visible in a screenshot.
 */
data class ListingCardModel(
    val id: String,
    val platform: String,
    val platformLabel: String,
    val priceText: String,
    val quantity: Int?,
    val status: String,
    val externalUrl: String?,
    /** Server-owned last push failure — shown, never swallowed (US-1511). */
    val publishError: String?,
    /**
     * eBay authored this listing, so its price and quantity are mirrors the
     * seller edits on eBay rather than here (US-1086 provenance).
     */
    val isImported: Boolean,
) {
    companion object {

        /** Canonical platform names, matching the web's MARKETPLACE_LABELS. */
        private val PLATFORM_LABELS = mapOf(
            "ebay" to "eBay",
            "poshmark" to "Poshmark",
            "mercari" to "Mercari",
            "depop" to "Depop",
            "grailed" to "Grailed",
            "facebook" to "Facebook",
            "offerup" to "OfferUp",
            "shopify" to "Shopify",
            "etsy" to "Etsy",
            "whatnot" to "Whatnot",
            "vinted" to "Vinted",
            "other" to "Other",
        )

        /** Unknown platforms title-case rather than render as a raw slug. */
        fun platformLabel(platform: String): String =
            PLATFORM_LABELS[platform.lowercase()]
                ?: platform.replaceFirstChar { it.uppercaseChar() }

        /**
         * WHICH quantity wording applies — the decision, not the words.
         *
         * Three states, not two: `0` is out of stock — the offer is still
         * published but nothing is buyable, which is exactly when a seller needs
         * telling. Null means no sync has ever reported a quantity; saying
         * "Qty 1" there would be an invention, and "Out of stock" would be a
         * lie.
         *
         * Pure, so the three-way choice stays unit-tested; [quantityText]
         * resolves it. The test asserts a resource id rather than English, which
         * is what let this file be translated at all (US-2368).
         */
        @StringRes
        fun quantityRes(quantity: Int?): Int = when {
            quantity == null -> R.string.listing_qty_unknown
            quantity <= 0 -> R.string.listing_out_of_stock
            else -> R.string.listing_qty
        }

        fun from(
            listing: ListingEntity,
            locale: Locale = Locale.getDefault(),
        ): ListingCardModel = ListingCardModel(
            id = listing.id,
            platform = listing.platform,
            platformLabel = platformLabel(listing.platform),
            priceText = Money.format(listing.listingPrice, locale),
            quantity = listing.quantity,
            status = listing.listingStatus,
            externalUrl = listing.externalUrl?.takeIf { it.isNotBlank() },
            publishError = listing.publishError?.takeIf { it.isNotBlank() },
            // Legacy rows carry no origin. Falling back to the offer id keeps
            // the old heuristic honest: only listings GradeThread published get
            // a Sell API offer, so no offer means eBay authored it.
            isImported = when (listing.listingOrigin) {
                "ebay" -> true
                "gradethread" -> false
                else -> listing.platform == "ebay" && listing.platformOfferId == null
            },
        )
    }
}

/** The quantity line in the reader's language. */
@Composable
fun quantityText(quantity: Int?): String {
    val res = ListingCardModel.quantityRes(quantity)
    return if (res == R.string.listing_qty) stringResource(res, quantity!!) else stringResource(res)
}

/** One line for TalkBack — the card's four facts read as a sentence. */
@Composable
fun ListingCardModel.spokenDescription(): String = stringResource(
    R.string.a11y_listing_card,
    platformLabel,
    priceText,
    quantityText(quantity),
    statusLabel(status),
)

/**
 * US-1351: the unified listing card — price, quantity, status and platform, the
 * same on every surface that shows a listing.
 */
@Composable
fun ListingCard(
    model: ListingCardModel,
    modifier: Modifier = Modifier,
    onOpenExternal: ((String) -> Unit)? = null,
    /** US-1357: opens the promotion + sale sheet. Null hides the action. */
    onPromote: (() -> Unit)? = null,
    /**
     * US-2490: opens the post-publish edit sheet. Null hides the action, which
     * is how an imported listing is handled: eBay authored it, so eBay owns its
     * lifecycle, and the server refuses an edit here with a 409. An absent
     * button beats a disabled one nobody can explain.
     */
    onEdit: (() -> Unit)? = null,
) {
    // Hoisted: `semantics { }` is not a composable scope.
    val spoken = model.spokenDescription()
    Column(
        modifier
            .fillMaxWidth()
            .cardStyle()
            .semantics(mergeDescendants = true) { contentDescription = spoken },
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                model.platformLabel,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            StatusBadge(model.status)
        }
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(model.priceText, style = MaterialTheme.typography.titleMedium)
            Text(
                quantityText(model.quantity),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (model.isImported) {
            Text(
                stringResource(R.string.listingcard_imported_readonly),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        model.publishError?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
        Row {
            model.externalUrl?.let { url ->
                onOpenExternal?.let { open ->
                    TextButton(
                        onClick = { open(url) },
                        modifier = Modifier.padding(top = Spacing.xxs),
                    ) { Text(stringResource(R.string.listingcard_view_on, model.platformLabel)) }
                }
            }
            onPromote?.let { promote ->
                TextButton(
                    onClick = promote,
                    modifier = Modifier.padding(top = Spacing.xxs),
                ) { Text(stringResource(R.string.listingcard_promote)) }
            }
            onEdit?.let { edit ->
                TextButton(
                    onClick = edit,
                    modifier = Modifier.padding(top = Spacing.xxs),
                ) { Text(stringResource(R.string.listingcard_edit)) }
            }
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun ListingCardPreview() {
    GradeThreadTheme {
        Column(
            Modifier.padding(Spacing.md),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            ListingCard(
                ListingCardModel(
                    id = "1",
                    platform = "ebay",
                    platformLabel = "eBay",
                    priceText = "$48.00",
                    quantity = 1,
                    status = "active",
                    externalUrl = "https://www.ebay.com/itm/1",
                    publishError = null,
                    isImported = true,
                ),
                onOpenExternal = {},
            )
            ListingCard(
                ListingCardModel(
                    id = "2",
                    platform = "poshmark",
                    platformLabel = "Poshmark",
                    priceText = "$32.00",
                    quantity = 0,
                    status = "drafted",
                    externalUrl = null,
                    publishError = "eBay rejected the last update: title too long.",
                    isImported = false,
                ),
            )
        }
    }
}
