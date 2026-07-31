package com.gradethread.app.widget

import com.gradethread.app.money.Money
import com.gradethread.app.money.SalePnL
import com.gradethread.app.sync.ConflictPolicy
import com.gradethread.app.sync.db.ListingEntity
import com.gradethread.app.sync.db.SaleEntity
import java.time.Instant
import java.time.ZoneId
import java.util.Locale

/**
 * US-1380 (iOS `WidgetSnapshotPublisher.compute`): the widget's numbers.
 *
 * Pure, and the zone is a parameter, because "sold today" is a LOCAL-day
 * question. A UTC-only implementation shows a seller in Chicago yesterday's
 * total for the first six hours of every day.
 */
object WidgetRollup {

    fun compute(
        listings: List<ListingEntity>,
        sales: List<SaleEntity>,
        nowMs: Long,
        isSignedIn: Boolean,
        zone: ZoneId = ZoneId.systemDefault(),
    ): WidgetSnapshot {
        if (!isSignedIn) return WidgetSnapshot.signedOut(generatedAt = nowMs)

        // Through the canonical set, case-insensitively: a literal "active"
        // check zeroes the tile on any casing drift and misses relisted rows,
        // which are still live. iOS hit exactly that (US-1258).
        val active = listings.count {
            it.listingStatus.lowercase(Locale.US) in ConflictPolicy.liveListingStatuses
        }

        // Cancelled and refunded orders were never sales (migration 00111).
        val completed = sales.filter { SalePnL.isCompleted(it) }

        val startOfToday = Instant.ofEpochMilli(nowMs)
            .atZone(zone).toLocalDate()
            .atStartOfDay(zone).toInstant().toEpochMilli()
        val today = completed.filter { it.saleDate >= startOfToday }

        val pending = completed.filter { it.payoutReference.isNullOrBlank() }

        return WidgetSnapshot(
            generatedAt = nowMs,
            isSignedIn = true,
            activeListings = active,
            soldTodayCount = today.size,
            soldTodayGross = Money.sum(today) { it.salePrice },
            pendingPayoutCount = pending.size,
            // Floored at zero: fees larger than the sale price are bad data,
            // not a payout the seller owes back.
            pendingPayoutNet = Money.sum(pending) {
                maxOf(0.0, it.salePrice - it.platformFees)
            },
        )
    }
}
