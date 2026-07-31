package com.gradethread.app.intake

import android.content.Intent
import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * US-1382: what actually arrives on a share.
 *
 * Senders are inconsistent about this in ways that are invisible until a real
 * user shares from a real gallery, so the unpacking is tested rather than
 * assumed.
 */
@RunWith(RobolectricTestRunner::class)
class ShareIntentTest {

    private fun uri(n: Int) = Uri.parse("content://media/external/images/media/$n")

    @Test
    fun singleSend_isRead() {
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "image/jpeg"
            putExtra(Intent.EXTRA_STREAM, uri(1))
        }

        assertEquals(listOf(uri(1)), ShareIntent.incomingUris(intent))
    }

    @Test
    fun sendMultiple_isRead() {
        val intent = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
            type = "image/*"
            putParcelableArrayListExtra(
                Intent.EXTRA_STREAM,
                arrayListOf(uri(1), uri(2), uri(3)),
            )
        }

        assertEquals(3, ShareIntent.incomingUris(intent).size)
    }

    @Test
    fun aSingleImageSentAsAList_isStillRead() {
        // Plenty of galleries use SEND_MULTIPLE for one photo. Reading only the
        // shape that matches the action drops it silently.
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "image/png"
            putParcelableArrayListExtra(Intent.EXTRA_STREAM, arrayListOf(uri(9)))
        }

        assertEquals(listOf(uri(9)), ShareIntent.incomingUris(intent))
    }

    @Test
    fun moreThanEight_isCapped() {
        val intent = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
            type = "image/*"
            putParcelableArrayListExtra(
                Intent.EXTRA_STREAM,
                ArrayList((1..20).map { uri(it) }),
            )
        }

        assertEquals(IntakeInbox.MAX_PHOTOS, ShareIntent.incomingUris(intent).size)
    }

    @Test
    fun nonImages_areRefused() {
        // The manifest filters to image/*, but an explicit launch can send
        // anything, and staging a PDF as a garment photo helps nobody.
        val text = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, "hello")
        }
        val pdf = Intent(Intent.ACTION_SEND).apply {
            type = "application/pdf"
            putExtra(Intent.EXTRA_STREAM, uri(1))
        }

        assertTrue(ShareIntent.incomingUris(text).isEmpty())
        assertTrue(ShareIntent.incomingUris(pdf).isEmpty())
        assertTrue(ShareIntent.incomingUris(null).isEmpty())
    }

    @Test
    fun anImageShareWithNoStream_isEmpty() {
        val intent = Intent(Intent.ACTION_SEND).apply { type = "image/jpeg" }
        assertTrue(ShareIntent.incomingUris(intent).isEmpty())
    }
}
