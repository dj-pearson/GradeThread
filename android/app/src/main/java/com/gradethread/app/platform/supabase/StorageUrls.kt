package com.gradethread.app.platform.supabase

/**
 * US-1307: Supabase Storage URL builders (iOS StorageURL, US-993) — built
 * WITHOUT force-unwrapping: a missing/malformed base yields null so callers
 * route a typed, recoverable error instead of crashing. AppConfig already
 * fails fast on a bad base at launch; this is defense in depth for the
 * upload/storage paths.
 *
 * Pure string math (no SDK types) → JVM unit-tested.
 */
object StorageUrls {

    /** Authenticated object endpoint: `/storage/v1/object/{bucket}/{path}`. */
    fun objectUrl(base: String?, bucket: String, path: String): String? =
        build(base, "/storage/v1/object/$bucket/$path")

    /** Public object endpoint: `/storage/v1/object/public/{bucket}/{path}`. */
    fun publicObjectUrl(base: String?, bucket: String, path: String): String? =
        build(base, "/storage/v1/object/public/$bucket/$path")

    /**
     * Signed-URL minting endpoint (US-979): POST `{ "expiresIn": s }` to mint
     * a short-TTL signed URL for a PRIVATE-bucket object (submission-images
     * reads are ONLY ever via signed URLs — US-276).
     */
    fun signUrl(base: String?, bucket: String, path: String): String? =
        build(base, "/storage/v1/object/sign/$bucket/$path")

    /**
     * Signed-UPLOAD-URL minting endpoint (US-1219): POST (authenticated) to
     * mint a single-object upload token, then PUT the bytes to the returned
     * URL with NO Authorization header — a long-lived bearer JWT never lands
     * in any upload queue's persisted state.
     */
    fun uploadSignUrl(base: String?, bucket: String, path: String): String? =
        build(base, "/storage/v1/object/upload/sign/$bucket/$path")

    private fun build(base: String?, path: String): String? {
        val trimmed = base?.trim()?.removeSuffix("/") ?: return null
        if (trimmed.isEmpty()) return null
        if (!trimmed.startsWith("https://")) return null
        // A base with its own path would silently nest — reject like the iOS
        // URLComponents path-replacement semantics (which REPLACE the path).
        val afterScheme = trimmed.removePrefix("https://")
        if (afterScheme.contains('/')) return null
        return trimmed + path
    }
}
