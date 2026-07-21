package com.gradethread.app.snap

import com.gradethread.app.platform.net.EdgeApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.util.Base64
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-1335: the Snap-to-Value call.
 *
 * Routes to `functions.gradethread.com` via [EdgeApi] — NOT `api.*`, which
 * hosts only Supabase and would 404 this path.
 */
@Singleton
class SnapService @Inject constructor(
    /**
     * The `ai` profile, NOT `shared`. Snap is a vision-model call that streams
     * nothing until it's done; the shared profile's idle timeout would abort a
     * healthy request partway through and report it as a network failure.
     */
    @Named("ai") private val edge: EdgeApi,
) {

    companion object {
        const val SNAP_PATH = "/api/grade/snap"
    }

    /**
     * Grade one photo.
     *
     * The base64 encode and the JSON build both run OFF the caller's thread: a
     * 2048px JPEG is a couple of megabytes, and base64 inflates it by a third,
     * so doing this inline would jank the spinner it is supposed to be
     * spinning behind (the iOS US-1165 lesson).
     */
    suspend fun snap(image: File, brand: String?, keyword: String?): SnapResponse {
        val body = withContext(Dispatchers.Default) {
            val dataUri = "data:image/jpeg;base64," +
                Base64.getEncoder().encodeToString(image.readBytes())
            snapJson.encodeToString(
                SnapRequest.serializer(),
                SnapRequest(
                    image = dataUri,
                    brand = brand?.trim()?.takeIf { it.isNotEmpty() },
                    keyword = keyword?.trim()?.takeIf { it.isNotEmpty() },
                ),
            )
        }
        val raw = edge.postRaw(SNAP_PATH, body)
        return snapJson.decodeFromString(SnapResponse.serializer(), raw)
    }
}
