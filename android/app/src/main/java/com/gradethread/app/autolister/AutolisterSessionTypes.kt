package com.gradethread.app.autolister

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * US-2408: the multi-item AutoLister session — staging, grouping, handoff.
 *
 * These mirror `useAutolisterHandoffs` in `src/hooks/use-autolister.ts` and the
 * request parsers in `services/edge-functions/src/routes/flipdesk-autolister.ts`.
 * The `source` value the server accepts already includes `android`; this is the
 * client that finally sends it.
 */

/** What `/staging/upload` gives back for one photo. */
@Serializable
data class StagedUpload(
    @SerialName("storage_path") val storagePath: String = "",
    val url: String = "",
    @SerialName("thumbnail_storage_path") val thumbnailStoragePath: String? = null,
    @SerialName("thumbnail_url") val thumbnailUrl: String? = null,
    val width: Int? = null,
    val height: Int? = null,
    val bytes: Long? = null,
)

/**
 * One photo in a session, as it is both held locally and handed off.
 *
 * `url` and `thumbnail_url` are sent but IGNORED by the server, which re-derives
 * both from the verified storage paths — a client cannot name the URL its photo
 * will be served from. They are kept on the payload so the same type can drive
 * the review grid without a second model.
 */
@Serializable
data class SessionPhoto(
    val id: String = "",
    @SerialName("storage_path") val storagePath: String = "",
    val url: String = "",
    @SerialName("thumbnail_storage_path") val thumbnailStoragePath: String? = null,
    @SerialName("thumbnail_url") val thumbnailUrl: String? = null,
    val width: Int? = null,
    val height: Int? = null,
    val bytes: Long? = null,
    /**
     * Real EXIF capture time, or null. Null is sent as ABSENT rather than 0:
     * the server reads this as the shooting order that separates one garment
     * from the next, and a zero would place every timeless photo in 1970 and
     * merge them into a single burst.
     */
    @SerialName("captured_at_ms") val capturedAtMs: Long? = null,
    @SerialName("source_name") val sourceName: String? = null,
    /** 16-hex dHash. Empty is legal and means "not hashed on this client". */
    val phash: String = "",
) {
    /** What the grid should draw — the thumbnail when there is one. */
    val displayUrl: String get() = thumbnailUrl?.takeIf { it.isNotBlank() } ?: url
}

@Serializable
data class SessionGroup(
    val id: String = "",
    @SerialName("photo_ids") val photoIds: List<String> = emptyList(),
    @SerialName("cover_id") val coverId: String? = null,
)

@Serializable
data class CreateHandoffRequest(
    @SerialName("staging_session_id") val stagingSessionId: String,
    val source: String = "android",
    val photos: List<SessionPhoto>,
    val groups: List<SessionGroup> = emptyList(),
)

@Serializable
data class CreatedHandoff(
    val id: String = "",
    @SerialName("photo_count") val photoCount: Int = 0,
    @SerialName("group_count") val groupCount: Int = 0,
    @SerialName("created_at") val createdAt: String = "",
)

@Serializable
data class HandoffSummary(
    val id: String = "",
    val source: String = "",
    val status: String = "",
    @SerialName("photo_count") val photoCount: Int = 0,
    @SerialName("group_count") val groupCount: Int = 0,
    @SerialName("created_at") val createdAt: String = "",
)

@Serializable
data class HandoffList(val sessions: List<HandoffSummary> = emptyList())

@Serializable
data class HandoffDetail(
    val id: String = "",
    val source: String = "",
    val status: String = "",
    @SerialName("staging_session_id") val stagingSessionId: String = "",
    @SerialName("photo_count") val photoCount: Int = 0,
    @SerialName("group_count") val groupCount: Int = 0,
    val photos: List<SessionPhoto> = emptyList(),
    val groups: List<SessionGroup> = emptyList(),
    @SerialName("created_at") val createdAt: String = "",
)

@Serializable
data class DiscardedHandoff(val ok: Boolean = false, val swept: Int = 0)

// ── the two AI grouping passes ───────────────────────────────────────────

@Serializable
data class GroupPhotoRef(
    val id: String,
    @SerialName("storage_path") val storagePath: String,
)

@Serializable
data class ProposeRequest(val photos: List<GroupPhotoRef>)

@Serializable
data class ProposedGroup(
    @SerialName("photo_ids") val photoIds: List<String> = emptyList(),
    val confidence: Double = 0.0,
    val reason: String = "",
)

@Serializable
data class ProposeResponse(
    val groups: List<ProposedGroup> = emptyList(),
    /** "none" means the short-circuit ran and the AI action was refunded. */
    val model: String = "",
    val escalated: Boolean = false,
)

@Serializable
data class VerifyGroup(val id: String, val photos: List<GroupPhotoRef>)

@Serializable
data class VerifyRequest(val groups: List<VerifyGroup>)

/**
 * One thing the model thinks is wrong with the grouping.
 *
 * Never applied automatically. `group_ids` reads differently per type: `merge`
 * is `[a, b]`, `split` is `[the group]`, `move` is `[from, to]`.
 */
@Serializable
data class GroupSuggestion(
    val type: String = "",
    @SerialName("group_ids") val groupIds: List<String> = emptyList(),
    @SerialName("photo_ids") val photoIds: List<String> = emptyList(),
    val confidence: Double = 0.0,
    val reason: String = "",
)

@Serializable
data class VerifyResponse(
    val suggestions: List<GroupSuggestion> = emptyList(),
    val model: String = "",
    val escalated: Boolean = false,
    @SerialName("groups_covered") val groupsCovered: Int = 0,
    /** True when the batch was larger than one pass could cover. */
    val truncated: Boolean = false,
)

// ── per-platform draft fields ────────────────────────────────────────────

@Serializable
data class PlatformFieldsRequest(
    @SerialName("item_id") val itemId: String,
    val platforms: List<String>,
)

@Serializable
data class PlatformCondition(val value: String = "", val label: String = "")

@Serializable
data class PlatformFieldSpec(
    val key: String = "",
    val label: String = "",
    val required: Boolean = false,
    val maxLength: Int? = null,
    val multiline: Boolean = false,
    val help: String? = null,
)

@Serializable
data class PlatformSpec(
    val label: String = "",
    val fields: List<PlatformFieldSpec> = emptyList(),
    val maxPhotos: Int = 0,
    val sourceNote: String = "",
)

@Serializable
data class PlatformIssue(
    val field: String = "",
    val message: String = "",
    val severity: String = "",
)

@Serializable
data class PlatformValidation(
    val platform: String = "",
    val ok: Boolean = false,
    val issues: List<PlatformIssue> = emptyList(),
)

/**
 * One platform's draft, filled by the server.
 *
 * Deliberately not assembled on the device: the title caps, condition
 * vocabularies and category trees differ per marketplace and change without
 * an app release, so a client that built these itself would be wrong the first
 * time Poshmark renamed a condition.
 *
 * The envelope is snake_case and the variants are camelCase — that mixture is
 * the server's, and renaming it here would hide it from anyone comparing the
 * two.
 */
@Serializable
data class PlatformVariant(
    val platform: String = "",
    val title: String = "",
    val description: String = "",
    val condition: PlatformCondition? = null,
    val category: String = "",
    val categorySource: String? = null,
    val categoryDepartment: String? = null,
    val categoryNeedsPick: Boolean = false,
    val brand: String = "",
    val color: String = "",
    val size: String? = null,
    val price: Double = 0.0,
    val tags: List<String> = emptyList(),
    val confidence: Double = 0.0,
    val validation: PlatformValidation? = null,
    val spec: PlatformSpec? = null,
)

@Serializable
data class PlatformFieldsResponse(
    @SerialName("listing_id") val listingId: String = "",
    val variants: List<PlatformVariant> = emptyList(),
)
