package com.gradethread.app.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil.compose.SubcomposeAsyncImage
import coil.request.CachePolicy
import coil.request.ImageRequest
import com.gradethread.app.R
import com.gradethread.app.ui.theme.CornerRadius
import com.gradethread.app.ui.theme.GradeThreadTheme

/**
 * Everything needed to decide HOW a photo is fetched. The read-time bucket is
 * derived from [serverPhotoType] + [photoUrl] together — a private-typed row
 * that carries a URL is a public/legacy row (see `PhotoUpload.readBucketFor`).
 */
data class PhotoRef(
    val storagePath: String? = null,
    val photoUrl: String = "",
    val serverPhotoType: String = "",
    /** Bumped by an in-place rotate; busts URL-keyed caches. */
    val localCacheToken: Int = 0,
) {
    companion object {
        /** A already-fetchable public URL (the common, non-sensitive case). */
        fun ofPublicUrl(url: String?): PhotoRef? =
            url?.takeIf { it.isNotBlank() }?.let { PhotoRef(photoUrl = it) }
    }
}

/**
 * A fetchable URL plus the caching policy it demands. [isPrivate] marks a
 * short-TTL signed URL, which must NEVER reach a disk cache; [cacheKey] is
 * stable across re-signs so a re-mint doesn't miss the memory cache and
 * re-download bytes we already hold.
 */
data class ResolvedImage(
    val url: String,
    val isPrivate: Boolean,
    val cacheKey: String,
)

/**
 * US-1329: resolves a photo to a fetchable URL. The private
 * `submission-images` bucket needs short-TTL signed URLs (US-276 — NEVER a
 * public URL); the real implementation is `SignedUrlStorageResolver`, bound in
 * `NetworkModule` over `PhotoSignedUrlProvider`. The default here handles only
 * already-fetchable public URLs, so a private path renders the error glyph
 * rather than leaking.
 */
fun interface StoragePathResolver {
    suspend fun resolve(photo: PhotoRef): ResolvedImage?
}

val LocalStoragePathResolver = compositionLocalOf<StoragePathResolver> {
    StoragePathResolver { photo ->
        photo.photoUrl
            .takeIf { it.startsWith("https://") }
            ?.let { ResolvedImage(url = it, isPrivate = false, cacheKey = it) }
    }
}

/**
 * Cached image thumbnail (iOS CachedThumbnail): skeleton shimmer while
 * resolving/loading, a quiet glyph on failure.
 *
 * Private-bucket photos are fetched with the DISK cache disabled. Coil's
 * default loader persists both the bytes and the signed URL (as the disk-cache
 * key) — that would outlive the <=900s TTL on disk, which is exactly what
 * US-276 forbids. Memory-only is the Android equivalent of the iOS ephemeral
 * URLSession.
 */
@Composable
fun CachedThumbnail(
    photo: PhotoRef?,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    size: Dp = 56.dp,
    cornerRadius: Dp = CornerRadius.control,
) {
    val resolver = LocalStoragePathResolver.current
    val context = LocalContext.current
    var resolved by remember(photo) { mutableStateOf<ResolvedImage?>(null) }
    var failed by remember(photo) { mutableStateOf(false) }

    LaunchedEffect(photo) {
        failed = false
        resolved = photo?.let { resolver.resolve(it) }
        // A mint failure is TRANSIENT, not sticky: this recomposes and retries
        // whenever `photo` changes identity, and nothing negative is cached.
        if (photo != null && resolved == null) failed = true
    }

    Box(
        modifier = modifier
            .size(size)
            .clip(RoundedCornerShape(cornerRadius)),
        contentAlignment = Alignment.Center,
    ) {
        val image = resolved
        when {
            failed || photo == null -> Icon(
                imageVector = Icons.Outlined.Warning,
                contentDescription = contentDescription
                    ?: stringResource(R.string.a11y_image_unavailable),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            image == null -> SkeletonBlock(Modifier.fillMaxSize(), cornerRadius)
            else -> SubcomposeAsyncImage(
                model = ImageRequest.Builder(context)
                    .data(image.url)
                    // Keyed on the storage path, not the signed URL, so a
                    // re-sign 30s before expiry is a memory-cache HIT.
                    .memoryCacheKey(image.cacheKey)
                    .diskCachePolicy(
                        if (image.isPrivate) CachePolicy.DISABLED else CachePolicy.ENABLED,
                    )
                    .crossfade(true)
                    .build(),
                contentDescription = contentDescription,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
                loading = { SkeletonBlock(Modifier.fillMaxSize(), cornerRadius) },
                error = {
                    Icon(
                        imageVector = Icons.Outlined.Warning,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                },
            )
        }
    }
}

/** Convenience overload for a plain public URL. */
@Composable
fun CachedThumbnail(
    pathOrUrl: String?,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    size: Dp = 56.dp,
    cornerRadius: Dp = CornerRadius.control,
) = CachedThumbnail(
    photo = PhotoRef.ofPublicUrl(pathOrUrl),
    contentDescription = contentDescription,
    modifier = modifier,
    size = size,
    cornerRadius = cornerRadius,
)

@Preview(showBackground = true)
@Composable
private fun CachedThumbnailPreview() {
    GradeThreadTheme {
        CachedThumbnail(pathOrUrl = null, contentDescription = "Item photo")
    }
}
