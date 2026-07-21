package com.gradethread.app.marketplaces

import android.net.Uri
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow

/**
 * US-1350: carries the eBay consent bounce-back from the Activity to whichever
 * screen is waiting for it.
 *
 * A process-wide relay rather than a DeepLinkRoute, because the marketplaces
 * screen needs the WHOLE URI — the client nonce and the status live in its
 * query, and DeepLinkRoute deliberately reduces a link to a nav destination.
 *
 * `replay = 1` matters: the App Link can arrive while the Activity is still
 * being recreated, before any collector exists. Without a replayed value the
 * callback would land in an empty room and the flow would hang on "Opening
 * eBay…" forever.
 */
object EbayOAuthCallbacks {

    private val _callbacks = MutableSharedFlow<Uri>(
        replay = 1,
        extraBufferCapacity = 1,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    val callbacks: SharedFlow<Uri> = _callbacks

    /** Offer an inbound URI. Non-eBay links are ignored by the collector. */
    fun offer(uri: Uri?) {
        if (uri == null) return
        if (uri.host != EbayOAuth.CALLBACK_HOST || uri.path != EbayOAuth.CALLBACK_PATH) return
        _callbacks.tryEmit(uri)
    }

    /**
     * Drop the replayed value once it has been acted on, so re-entering the
     * screen later doesn't re-process a consent from an hour ago.
     */
    fun clear() {
        _callbacks.resetReplayCache()
    }
}
