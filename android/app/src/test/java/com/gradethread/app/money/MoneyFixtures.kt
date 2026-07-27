package com.gradethread.app.money

import com.gradethread.app.sync.db.ExpenseEntity
import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.sync.db.SaleEntity
import com.gradethread.app.sync.db.SourceEntity
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * Row builders for the money/dashboard rollup tests.
 *
 * Shared because these entities carry 30+ columns and every rollup test needs
 * two or three of them — inlining the factories per file made the assertions
 * impossible to find, and a drifting copy would let a test pass against a shape
 * the app no longer produces.
 *
 * Times are built in a FIXED zone so the month/day bucketing assertions don't
 * depend on where CI runs.
 */
object MoneyFixtures {

    /** Deliberately not UTC: a UTC-only test can't catch local-day bucketing bugs. */
    val ZONE: ZoneId = ZoneId.of("America/Chicago")

    fun ms(year: Int, month: Int, day: Int, hour: Int = 12): Long =
        LocalDateTime.of(year, month, day, hour, 0)
            .atZone(ZONE).toInstant().toEpochMilli()

    fun dayMs(date: LocalDate): Long =
        date.atStartOfDay(ZONE).toInstant().toEpochMilli()

    fun item(
        id: String,
        status: String = "cataloged",
        acquiredPrice: Double? = null,
        listingPrice: Double? = null,
        targetPrice: Double? = null,
        title: String = "Item $id",
        sourceId: String? = null,
        acquiredDate: Long? = null,
        createdAt: Long = 0L,
        updatedAt: Long = 0L,
    ) = InventoryItemEntity(
        id = id,
        userId = "u1",
        title = title,
        brand = null,
        sku = null,
        size = null,
        color = null,
        material = null,
        status = status,
        itemCategory = null,
        garmentType = null,
        garmentCategory = null,
        itemDescription = null,
        style = null,
        sourcedBy = null,
        acquiredDate = acquiredDate,
        container = null,
        compSetJson = null,
        sourceId = sourceId,
        locationBin = null,
        consignorId = null,
        consignmentSplitPct = null,
        acquiredPrice = acquiredPrice,
        targetPrice = targetPrice,
        listingPrice = listingPrice,
        gradeValue = null,
        gradeLabel = null,
        certificateUrl = null,
        gradeReportId = null,
        disputeStatus = null,
        conditionNotes = null,
        measurementsJson = null,
        primaryPhotoUrl = null,
        createdAt = createdAt,
        updatedAt = updatedAt,
    )

    fun sale(
        id: String,
        itemId: String,
        salePrice: Double = 100.0,
        platformFees: Double = 0.0,
        paymentProcessingFees: Double? = null,
        shippingCollected: Double? = null,
        shippingCost: Double? = null,
        gradingCost: Double? = null,
        otherCosts: Double? = null,
        status: String = "completed",
        saleDate: Long = 0L,
    ) = SaleEntity(
        id = id,
        inventoryItemId = itemId,
        listingId = null,
        salePrice = salePrice,
        platformFees = platformFees,
        paymentProcessingFees = paymentProcessingFees,
        shippingCollected = shippingCollected,
        shippingCost = shippingCost,
        gradingCost = gradingCost,
        otherCosts = otherCosts,
        tax = null,
        netProfit = null,
        status = status,
        buyerUsername = null,
        platformOrderId = null,
        payoutReference = null,
        saleDate = saleDate,
        soldAt = null,
        shippedAt = null,
        trackingNumber = null,
        createdAt = 0L,
    )

    fun expense(
        id: String,
        amount: Double,
        spentOn: Long,
        category: String = "supplies",
        itemId: String? = null,
    ) = ExpenseEntity(
        id = id,
        category = category,
        expenseDescription = null,
        amount = amount,
        spentOn = spentOn,
        inventoryItemId = itemId,
        listingId = null,
        createdAt = 0L,
    )

    fun source(id: String, name: String) = SourceEntity(
        id = id,
        userId = "u1",
        name = name,
        sourceType = "thrift",
        notes = null,
        archivedAt = null,
        createdAt = 0L,
        updatedAt = 0L,
    )
}
