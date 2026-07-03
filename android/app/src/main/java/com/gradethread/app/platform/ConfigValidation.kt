package com.gradethread.app.platform

/**
 * US-1301: pure config-parsing rules, mirroring the iOS `AppConfig` semantics
 * (Networking/AppConfig.swift):
 *  - whitespace-only / empty values read as ABSENT (xcconfig-style placeholders
 *    flow through builds as empty strings; the feature they gate disables
 *    silently rather than initializing an SDK with a garbage key);
 *  - base URLs MUST be https — a cleartext or malformed base URL is a
 *    misconfiguration worth failing fast on, never limping along with.
 *
 * Kept free of BuildConfig/Android imports so plain JVM unit tests cover it.
 */
object ConfigValidation {

    /** Empty / whitespace-only → null (the "placeholder means absent" rule). */
    fun blankToNull(raw: String?): String? {
        val trimmed = raw?.trim()
        return if (trimmed.isNullOrEmpty()) null else trimmed
    }

    /**
     * A required https base URL: non-blank, parses, https scheme, has a host.
     * Returns the normalized URL (no trailing slash) or throws — the Android
     * analog of the iOS `fatalError` for a missing/cleartext base URL.
     */
    fun requireHttpsBaseUrl(name: String, raw: String?): String {
        val value = blankToNull(raw)
            ?: error("$name missing — set it in local.properties or CI env (see android/README.md).")
        val normalized = value.removeSuffix("/")
        val parsed = runCatching { java.net.URI(normalized) }.getOrNull()
            ?: error("$name is not a valid URL: $normalized")
        check(parsed.scheme == "https") {
            "$name must be https (got '${parsed.scheme}') — base URLs are never cleartext."
        }
        check(!parsed.host.isNullOrEmpty()) { "$name has no host: $normalized" }
        return normalized
    }

    /** A required opaque secret (e.g. the anon key): non-blank or throw. */
    fun requireNonBlank(name: String, raw: String?): String =
        blankToNull(raw)
            ?: error("$name missing — set it in local.properties or CI env (see android/README.md).")
}
