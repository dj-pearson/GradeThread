package com.gradethread.app.verified

import androidx.annotation.StringRes
import com.gradethread.app.R
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * US-1375 (iOS `VerifiedTypes`): GradeThread Verified — the seller badge.
 *
 * `GET /api/verified/profile` returns `{ profile, stats }`. Snake_case on the
 * wire, named explicitly here.
 */
@Serializable
data class VerifiedProfile(
    val handle: String? = null,
    @SerialName("display_name") val displayName: String? = null,
    val bio: String? = null,
    /** The public profile page is switched on. */
    val enabled: Boolean = false,
    @SerialName("verified_since") val verifiedSince: String? = null,
    /** Storefront opt-in: the public page lists the seller's active listings. */
    @SerialName("show_listings") val showListings: Boolean = false,
    /** The trust block is embedded in the seller's own eBay listings. */
    @SerialName("embed_in_listings") val embedInListings: Boolean = false,
)

@Serializable
data class VerifiedStats(
    @SerialName("total_graded") val totalGraded: Int = 0,
    @SerialName("average_grade") val averageGrade: Double = 0.0,
)

@Serializable
data class VerifiedProfileResponse(
    val profile: VerifiedProfile = VerifiedProfile(),
    val stats: VerifiedStats = VerifiedStats(),
)

/**
 * US-2493: the PUT body. Every field is optional and only the ones present are
 * written, which is why they are nullable AND why `encodeDefaults` must stay
 * off for this serializer — sending `"bio": null` for a field the seller did
 * not touch would CLEAR their bio, because the edge treats present-and-null as
 * "set it to empty" (`verified.ts` PUT /profile).
 */
@Serializable
data class VerifiedProfileUpdate(
    val handle: String? = null,
    @SerialName("display_name") val displayName: String? = null,
    val bio: String? = null,
    val enabled: Boolean? = null,
    @SerialName("show_listings") val showListings: Boolean? = null,
    @SerialName("embed_in_listings") val embedInListings: Boolean? = null,
)

/** `GET /api/verified/handle-available?handle=…` */
@Serializable
data class HandleAvailability(
    val available: Boolean = false,
    val handle: String? = null,
    /** Why not, in the seller's words. Null when it IS available. */
    val reason: String? = null,
)

/**
 * US-2493: handle rules, mirrored from the server.
 *
 * Three copies of this exist on purpose — `parseHandle` in
 * `services/edge-functions/src/routes/verified.ts`, the web form, and here —
 * because the DB CHECK constraint from migration 00057 is the real authority
 * and every surface that lets someone type a handle has to say WHY it is
 * refused before the round trip. The server still re-validates; this only
 * decides what the seller reads while typing.
 */
object VerifiedHandleRules {
    const val MIN_LENGTH = 3
    const val MAX_LENGTH = 30

    /** Lowercase alphanumeric + hyphen, never leading or trailing. */
    private val PATTERN = Regex("^[a-z0-9]([a-z0-9-]{1,28})[a-z0-9]$")

    /** Handles that would collide with a real route or impersonate us. */
    private val RESERVED = setOf(
        "admin", "api", "app", "auth", "billing", "blog", "cert", "dashboard",
        "gradethread", "flipdesk", "help", "login", "logout", "og", "pricing",
        "settings", "signup", "support", "verified", "www",
    )

    /** The normalized handle, or null if it can never be valid. */
    fun normalize(raw: String): String = raw.trim().lowercase()

    /**
     * Why this handle is refused, as a string resource id, or null if the
     * shape is fine. A resource rather than English so the reason translates —
     * only the "already taken" answer comes from the server, because only the
     * server knows it.
     */
    fun shapeError(raw: String): Int? {
        val handle = normalize(raw)
        return when {
            handle.length !in MIN_LENGTH..MAX_LENGTH -> R.string.verified_handle_length
            !PATTERN.matches(handle) -> R.string.verified_handle_charset
            handle in RESERVED -> R.string.verified_handle_reserved
            else -> null
        }
    }
}

/**
 * Where the seller stands.
 *
 * Derived from the profile itself rather than read from a column, because there
 * ISN'T one — the badge is gated by `loadSellerCredentialBlock`, which needs a
 * handle plus the public toggle. Naming the same three conditions here keeps
 * this screen honest about what actually turns the badge on.
 */
enum class VerifiedStatus(@StringRes val label: Int, @StringRes val detail: Int) {
    LOCKED(R.string.verified_status_locked, R.string.verified_status_locked_detail),
    HANDLE_NEEDED(
        R.string.verified_status_handle_needed,
        R.string.verified_status_handle_needed_detail,
    ),
    HIDDEN(R.string.verified_status_hidden, R.string.verified_status_hidden_detail),
    LIVE(R.string.verified_status_live, R.string.verified_status_live_detail),
}

/**
 * One thing standing between the seller and a working badge.
 *
 * US-2976: the strings are RESOURCES, and two of the four details carry a
 * value, so the shape has to say which. [detailHandle] and [detailCount] are
 * separate nullable fields rather than one `Any?` because the screen resolves
 * them differently - a count goes through pluralStringResource and a handle
 * does not, and a single untyped argument would have needed a cast at the one
 * place that must not get this wrong.
 */
data class VerifiedRequirement(
    @StringRes val title: Int,
    /** A string resource, or a PLURALS resource when [detailCount] is set. */
    val detail: Int,
    val met: Boolean,
    /** The seller's handle, for the one requirement that names it. */
    val detailHandle: String? = null,
    /** How many grades, for the one requirement that counts them. */
    val detailCount: Int? = null,
)

object VerifiedBadge {

    /** Where the public profile lives once a handle is claimed. */
    const val PROFILE_BASE = "https://gradethread.com/verified/"

    /**
     * A badge with no grades behind it says nothing.
     *
     * One is the bar, not a round number: the badge's whole content is the
     * seller's grading record, and an empty record makes it decoration.
     */
    const val MIN_GRADES = 1

    fun status(profile: VerifiedProfile): VerifiedStatus {
        val hasHandle = !profile.handle.isNullOrBlank()
        return when {
            profile.enabled && hasHandle -> VerifiedStatus.LIVE
            profile.enabled -> VerifiedStatus.HANDLE_NEEDED
            hasHandle -> VerifiedStatus.HIDDEN
            else -> VerifiedStatus.LOCKED
        }
    }

    /**
     * The checklist, in the order someone would actually do it.
     *
     * "Show in listings" is included but is NOT part of [status]: it controls
     * the trust block inside eBay listings, not whether the badge exists.
     * Folding it in would tell a seller with a perfectly live badge that they
     * aren't verified.
     */
    fun requirements(profile: VerifiedProfile, stats: VerifiedStats): List<VerifiedRequirement> = listOf(
        VerifiedRequirement(
            title = R.string.verified_req_handle,
            detail = if (profile.handle.isNullOrBlank()) {
                R.string.verified_req_handle_todo
            } else {
                R.string.verified_req_handle_met
            },
            met = !profile.handle.isNullOrBlank(),
            detailHandle = profile.handle?.takeIf { it.isNotBlank() },
        ),
        VerifiedRequirement(
            title = R.string.verified_req_graded,
            detail = if (stats.totalGraded >= MIN_GRADES) {
                R.plurals.verified_req_graded_met
            } else {
                R.string.verified_req_graded_todo
            },
            met = stats.totalGraded >= MIN_GRADES,
            detailCount = stats.totalGraded.takeIf { it >= MIN_GRADES },
        ),
        VerifiedRequirement(
            title = R.string.verified_req_public,
            detail = if (profile.enabled) {
                R.string.verified_req_public_met
            } else {
                R.string.verified_req_public_todo
            },
            met = profile.enabled,
        ),
        VerifiedRequirement(
            title = R.string.verified_req_embed,
            detail = if (profile.embedInListings) {
                R.string.verified_req_embed_met
            } else {
                R.string.verified_req_embed_todo
            },
            met = profile.embedInListings,
        ),
    )

    /** How far along, 0..1, over the requirements that actually gate the badge. */
    fun progress(requirements: List<VerifiedRequirement>): Float {
        val gating = requirements.dropLast(1)
        if (gating.isEmpty()) return 0f
        return gating.count { it.met }.toFloat() / gating.size
    }

    /**
     * The single next thing to do, or null when the badge is live.
     *
     * One at a time: a list of four things nobody has started is a wall, and
     * the first step is the only one that matters today.
     */
    fun nextStep(requirements: List<VerifiedRequirement>): VerifiedRequirement? =
        requirements.dropLast(1).firstOrNull { !it.met }

    fun profileUrl(profile: VerifiedProfile): String? =
        profile.handle?.trim()?.takeIf { it.isNotEmpty() }?.let { PROFILE_BASE + it }

    /**
     * The date part of the raw ISO timestamp, or null.
     *
     * US-2976: the DATE, not the sentence. It returned "Verified since
     * 2026-03-04"; the screen wraps it in R.string.verified_since now, because
     * "since" goes in a different place in Spanish.
     *
     * Kept as text and cut at the date: the edge sends fractional seconds, and
     * this is display-only - parsing it just to reformat it would add a failure
     * mode for no gain.
     */
    fun sinceDate(profile: VerifiedProfile): String? = profile.verifiedSince?.takeIf { it.isNotBlank() }?.take(10)

    /** The grading record the badge actually shows a buyer. */
    fun credentials(stats: VerifiedStats): String? {
        if (stats.totalGraded < MIN_GRADES) return null
        val items = if (stats.totalGraded == 1) "item" else "items"
        // Locale-fixed: a grade is a score on a 1-10 scale, not a quantity to
        // localize, and "8,4" would read as a different number entirely.
        val average = String.format(java.util.Locale.US, "%.1f", stats.averageGrade)
        return "${stats.totalGraded} certified $items · $average average grade"
    }
}
