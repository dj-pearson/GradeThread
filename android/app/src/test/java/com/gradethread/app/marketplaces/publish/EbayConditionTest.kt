package com.gradethread.app.marketplaces.publish

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** US-1352: the condition vocabulary the composer sends to eBay. */
class EbayConditionTest {

    @Test
    fun `new without tags is NEW_OTHER, not LIKE_NEW`() {
        // eBay id 1500, not 2750: most clothing categories reject 2750, so the
        // old labelling sent an invalid condition (eBay error 25021).
        assertEquals("NEW_OTHER", EbayCondition.NEW_OTHER.wire)
        assertEquals("New without tags", EbayCondition.NEW_OTHER.label)
        assertEquals("Like new", EbayCondition.LIKE_NEW.label)
    }

    @Test
    fun `resolve picks a concrete default for the picker`() {
        assertEquals(EbayCondition.USED_EXCELLENT, EbayCondition.resolve(null))
        assertEquals(EbayCondition.USED_EXCELLENT, EbayCondition.resolve("WHO_KNOWS"))
        assertEquals(EbayCondition.NEW, EbayCondition.resolve("NEW"))
    }

    @Test
    fun `displayLabel invents nothing`() {
        // A stored value we don't recognise is shown verbatim rather than
        // misreported as "Excellent" — the row must not lie about the data.
        assertEquals("Pre-owned – Good", EbayCondition.displayLabel("USED_GOOD"))
        assertEquals("MYSTERY_GRADE", EbayCondition.displayLabel("MYSTERY_GRADE"))
        assertNull(EbayCondition.displayLabel(null))
        assertNull(EbayCondition.displayLabel("   "))
    }
}
