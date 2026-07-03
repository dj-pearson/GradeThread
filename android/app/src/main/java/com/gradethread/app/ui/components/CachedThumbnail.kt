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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil.compose.SubcomposeAsyncImage
import com.gradethread.app.ui.theme.CornerRadius
import com.gradethread.app.ui.theme.GradeThreadTheme

/**
 * US-1303: resolves a Supabase Storage path to a fetchable URL. The private
 * `submission-images` bucket needs short-TTL signed URLs (US-276 — NEVER a
 * public URL), so the real resolver lives with the storage/auth layer
 * (US-1307) and caches signatures like the iOS SignatureCache. Until that
 * story lands, the default treats input as already-fetchable — public-bucket
 * URLs work; private paths render the error glyph rather than leaking.
 */
fun interface StoragePathResolver {
    suspend fun resolve(pathOrUrl: String): String?
}

val LocalStoragePathResolver = compositionLocalOf<StoragePathResolver> {
    StoragePathResolver { raw ->
        if (raw.startsWith("https://")) raw else null
    }
}

/**
 * Cached image thumbnail (iOS CachedThumbnail): Coil memory+disk cache under
 * the hood, skeleton shimmer while loading, a quiet glyph on failure. Pass a
 * public URL or a storage path — the resolver decides.
 */
@Composable
fun CachedThumbnail(
    pathOrUrl: String?,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    size: Dp = 56.dp,
    cornerRadius: Dp = CornerRadius.control,
) {
    val resolver = LocalStoragePathResolver.current
    var resolved by remember(pathOrUrl) { mutableStateOf<String?>(null) }
    var failed by remember(pathOrUrl) { mutableStateOf(false) }

    LaunchedEffect(pathOrUrl) {
        failed = false
        resolved = pathOrUrl?.let { resolver.resolve(it) }
        if (pathOrUrl != null && resolved == null) failed = true
    }

    Box(
        modifier = modifier
            .size(size)
            .clip(RoundedCornerShape(cornerRadius)),
        contentAlignment = Alignment.Center,
    ) {
        when {
            failed || pathOrUrl == null -> Icon(
                imageVector = Icons.Outlined.Warning,
                contentDescription = contentDescription ?: "Image unavailable",
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            resolved == null -> SkeletonBlock(Modifier.fillMaxSize(), cornerRadius)
            else -> SubcomposeAsyncImage(
                model = resolved,
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

@Preview(showBackground = true)
@Composable
private fun CachedThumbnailPreview() {
    GradeThreadTheme {
        CachedThumbnail(pathOrUrl = null, contentDescription = "Item photo")
    }
}
