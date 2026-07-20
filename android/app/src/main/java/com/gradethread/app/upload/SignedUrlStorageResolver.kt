package com.gradethread.app.upload

import com.gradethread.app.ui.components.PhotoRef
import com.gradethread.app.ui.components.ResolvedImage
import com.gradethread.app.ui.components.StoragePathResolver

/**
 * US-1329: the real [StoragePathResolver] — bridges a persisted photo row to a
 * fetchable URL, minting a short-TTL signed URL for the private bucket and
 * passing the permanent public URL straight through.
 *
 * Note the cache key deliberately does NOT include the signed URL: the URL
 * rotates every ~10 minutes, so keying on it would re-download identical bytes
 * on every re-sign and would write a capability token into a cache key.
 */
class SignedUrlStorageResolver(
    private val provider: PhotoSignedUrlProvider,
) : StoragePathResolver {

    override suspend fun resolve(photo: PhotoRef): ResolvedImage? {
        val bucket = PhotoUpload.readBucketFor(photo.serverPhotoType, photo.photoUrl)
        val url = provider.displayUrl(bucket, photo.storagePath, photo.photoUrl) ?: return null
        // An in-place rotate leaves the signed URL byte-identical; `_cb` makes
        // the request unique without disturbing the server-validated token.
        val fetchable = PhotoSignedUrlProvider.cacheBusted(url, photo.localCacheToken) ?: return null
        val identity = photo.storagePath?.takeIf { it.isNotBlank() } ?: photo.photoUrl
        return ResolvedImage(
            url = fetchable,
            isPrivate = !bucket.isPublic,
            cacheKey = "${bucket.bucketName}/$identity#${photo.localCacheToken}",
        )
    }
}
