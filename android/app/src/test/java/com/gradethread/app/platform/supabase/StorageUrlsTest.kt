package com.gradethread.app.platform.supabase

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** US-1307: nil-safe storage URL building (iOS StorageURL, US-993). */
class StorageUrlsTest {

    private val base = "https://api.gradethread.com"

    @Test
    fun buildsTheFourEndpoints() {
        assertEquals(
            "$base/storage/v1/object/item-photos/u1/p.jpg",
            StorageUrls.objectUrl(base, "item-photos", "u1/p.jpg"),
        )
        assertEquals(
            "$base/storage/v1/object/public/item-photos/u1/p.jpg",
            StorageUrls.publicObjectUrl(base, "item-photos", "u1/p.jpg"),
        )
        assertEquals(
            "$base/storage/v1/object/sign/submission-images/u1/s.jpg",
            StorageUrls.signUrl(base, "submission-images", "u1/s.jpg"),
        )
        assertEquals(
            "$base/storage/v1/object/upload/sign/item-photos/u1/p.jpg",
            StorageUrls.uploadSignUrl(base, "item-photos", "u1/p.jpg"),
        )
    }

    @Test
    fun trailingSlashOnBase_isNormalized() {
        assertEquals(
            "$base/storage/v1/object/b/p",
            StorageUrls.objectUrl("$base/", "b", "p"),
        )
    }

    @Test
    fun badBases_yieldNullNotCrashes() {
        assertNull(StorageUrls.objectUrl(null, "b", "p"))
        assertNull(StorageUrls.objectUrl("", "b", "p"))
        assertNull(StorageUrls.objectUrl("   ", "b", "p"))
        assertNull(StorageUrls.objectUrl("http://api.gradethread.com", "b", "p"))
        // A base carrying its own path would silently nest — rejected.
        assertNull(StorageUrls.objectUrl("https://api.gradethread.com/extra", "b", "p"))
    }
}
