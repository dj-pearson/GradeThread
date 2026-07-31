package com.gradethread.app.intake

import android.content.Intent
import android.net.Uri
import android.os.Build

/**
 * US-1382: unpacking what a share actually sent.
 *
 * A top-level object rather than a companion on the Activity, matching
 * `OAuthCallback`: the rules are testable, and loading an `@AndroidEntryPoint`
 * Activity class to reach them is not something a unit test should have to do.
 */
object ShareIntent {

    /**
     * The shared images, however the sender packed them.
     *
     * SEND carries one Uri in EXTRA_STREAM; SEND_MULTIPLE carries a list. But
     * senders are inconsistent — plenty of galleries use SEND_MULTIPLE for a
     * single photo — so BOTH shapes are read regardless of the action. Reading
     * only the shape that matches drops real shares silently.
     */
    fun incomingUris(intent: Intent?): List<Uri> {
        if (intent == null) return emptyList()
        // The manifest filters to image/*, but an explicit launch can send
        // anything, and staging a PDF as a garment photo helps nobody.
        if (intent.type?.startsWith("image/") != true) return emptyList()

        val multiple = intent.parcelableUris(Intent.EXTRA_STREAM)
        if (multiple.isNotEmpty()) return multiple.take(IntakeInbox.MAX_PHOTOS)
        return listOfNotNull(intent.parcelableUri(Intent.EXTRA_STREAM))
    }

    @Suppress("DEPRECATION")
    private fun Intent.parcelableUri(key: String): Uri? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getParcelableExtra(key, Uri::class.java)
        } else {
            getParcelableExtra(key)
        }

    @Suppress("DEPRECATION")
    private fun Intent.parcelableUris(key: String): List<Uri> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getParcelableArrayListExtra(key, Uri::class.java).orEmpty()
        } else {
            getParcelableArrayListExtra<Uri>(key).orEmpty()
        }
}
