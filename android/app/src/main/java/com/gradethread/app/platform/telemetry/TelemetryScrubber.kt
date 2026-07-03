package com.gradethread.app.platform.telemetry

/**
 * US-1308 (iOS TelemetryScrubber, US-662/US-990/US-1178): redacts PII /
 * secrets from any string before it leaves the device in a crash report or
 * breadcrumb — emails, Bearer tokens, apikey/access_token/refresh_token
 * values, signed Storage object URLs, and raw UUIDs (identifying in
 * aggregate). Pure + synchronous so it runs inside Sentry's beforeSend /
 * beforeBreadcrumb hooks and unit-tests trivially.
 */
object TelemetryScrubber {

    private data class Rule(val regex: Regex, val template: String)

    private val rules: List<Rule> = listOf(
        // Emails.
        Rule(Regex("""[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"""), "[redacted-email]"),
        // Bearer tokens.
        Rule(Regex("""(?i)bearer\s+[A-Za-z0-9._\-]+"""), "Bearer [redacted]"),
        // apikey / access_token / refresh_token = value (or : value).
        Rule(
            Regex("""(?i)(apikey|api_key|access_token|refresh_token)(["']?\s*[:=]\s*["']?)[A-Za-z0-9._\-]+"""),
            "$1$2[redacted]",
        ),
        // Signed Supabase Storage object URLs (token query + the object path).
        Rule(Regex("""https?://[^\s"']*?/storage/v1/object/[^\s"']+"""), "[redacted-storage-url]"),
        // Raw UUIDs — user/workspace/item ids are identifying in aggregate.
        Rule(
            Regex("""(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b"""),
            "[redacted-uuid]",
        ),
    )

    fun redact(text: String): String {
        var result = text
        for (rule in rules) result = rule.regex.replace(result, rule.template)
        return result
    }

    /**
     * Header names whose ENTIRE value must drop (US-990): a bare header value
     * carries none of the `apikey=` / `Bearer ` context the string rules
     * latch onto.
     */
    val sensitiveHeaderNames: Set<String> = setOf(
        "authorization", "apikey", "api_key", "x-api-key", "x-apikey",
        "access_token", "refresh_token", "cookie", "set-cookie",
    )

    fun isSensitiveHeaderName(name: String): Boolean =
        name.lowercase() in sensitiveHeaderNames

    /** Redact every string inside a property map (nested maps included). */
    fun redactProperties(props: Map<String, Any?>): Map<String, Any?> =
        props.mapValues { (key, value) -> redactValue(key, value) }

    private fun redactValue(key: String?, value: Any?): Any? = when {
        key != null && isSensitiveHeaderName(key) -> "[redacted]"
        value is String -> redact(value)
        value is Map<*, *> -> value.entries.associate { (k, v) ->
            k.toString() to redactValue(k.toString(), v)
        }
        value is List<*> -> value.map { redactValue(null, it) }
        else -> value
    }
}
