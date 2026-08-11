package com.gradethread.app.money

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import com.gradethread.app.R
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-2491: what the unsold stock is worth.
 *
 * The headline is a LIQUIDATION estimate — a comp median discounted by grade,
 * by the seller's own sell-through speed and by how long the item has sat. The
 * card says so, because the same number presented as "your inventory is worth
 * this" would be the most flattering possible lie about a shelf that has not
 * sold.
 *
 * Items the server could not value are counted separately and their reason
 * named. Folding them in at zero would understate the total in a direction the
 * seller has no way to notice.
 */
@Composable
fun InventoryEquityCard(
    summary: EquitySummary?,
    trend: EquityTrend?,
    loading: Boolean,
    errorMessage: String?,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier.fillMaxWidth().padding(horizontal = Spacing.md, vertical = Spacing.xs).cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Text(
            stringResource(R.string.equity_title),
            style = MaterialTheme.typography.titleMedium,
        )

        if (errorMessage != null) {
            Text(
                errorMessage,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
            TextButton(onClick = onRetry) { Text(stringResource(R.string.common_try_again)) }
            return@Column
        }

        if (summary == null) {
            Text(
                stringResource(
                    if (loading) R.string.equity_loading else R.string.equity_not_loaded,
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            return@Column
        }

        val aggregate = summary.aggregate
        Text(
            Money.format(Equity.dollars(aggregate.totalEquityCents)),
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.SemiBold,
        )
        // Named, not decorated. "If I had to move it" is the whole meaning of
        // the number above.
        Text(
            stringResource(R.string.equity_subtitle),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        if (Equity.hasRange(aggregate)) {
            Text(
                stringResource(
                    R.string.equity_range,
                    Money.format(Equity.dollars(aggregate.totalLowCents)),
                    Money.format(Equity.dollars(aggregate.totalHighCents)),
                ),
                style = MaterialTheme.typography.bodySmall,
            )
        }

        Text(
            pluralStringResource(
                R.plurals.equity_valued_count,
                aggregate.valuedCount,
                aggregate.valuedCount,
            ),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        // The unvalued items and WHY. A seller who grades forty of these gets a
        // real number for them, and that is only actionable if it is said.
        if (aggregate.unvaluedCount > 0) {
            Text(
                stringResource(
                    R.string.equity_unvalued,
                    aggregate.unvaluedCount,
                    aggregate.unvaluedByReason.noGrade,
                    aggregate.unvaluedByReason.noComps,
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Equity.movementCents(trend ?: EquityTrend())?.let { movement ->
            Text(
                stringResource(
                    if (movement < 0) R.string.equity_movement_down else R.string.equity_movement_up,
                    Money.format(Equity.dollars(kotlin.math.abs(movement))),
                ),
                style = MaterialTheme.typography.bodySmall,
            )
        }

        val topCategories = Equity.topBuckets(aggregate.byCategory)
        if (topCategories.isNotEmpty()) {
            Text(
                stringResource(R.string.equity_by_category),
                style = MaterialTheme.typography.labelLarge,
                modifier = Modifier.padding(top = Spacing.xxs),
            )
            for ((name, bucket) in topCategories) {
                Row(Modifier.fillMaxWidth()) {
                    Text(
                        name,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        Money.format(Equity.dollars(bucket.cents)),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }
    }
}
