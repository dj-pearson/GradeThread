package com.gradethread.app.autolister

import kotlinx.serialization.Serializable

/**
 * US-2408: an AutoLister session — the photos, the grouping, and every edit
 * the seller can make before they confirm.
 *
 * Serializable because the whole thing is persisted to Room after each change:
 * a seller who has just spent ten minutes sorting sixty photos must not lose
 * that to a process kill while they answer a phone call.
 */
@Serializable
data class AutolisterSessionState(
    /**
     * The `_staging/` path segment every photo in this session lives under.
     *
     * Generated once and kept, because it is what ties the uploaded objects to
     * the handoff row — a new id per upload would scatter one batch across
     * unrelated folders and leave the discard sweep unable to find them.
     */
    val stagingSessionId: String = "",
    val photos: List<SessionPhoto> = emptyList(),
    val groups: List<SessionGroup> = emptyList(),
    /** The model's last verify pass, kept as chips until acted on. */
    val suggestions: List<GroupSuggestion> = emptyList(),
    /** Set once the batch has been handed to the desktop. */
    val handoffId: String? = null,
    val createdAt: Long = 0,
) {
    private val groupedIds: Set<String> get() = groups.flatMap { it.photoIds }.toSet()

    /** Photos not yet in any group, in import order. */
    val ungrouped: List<SessionPhoto> get() = photos.filter { it.id !in groupedIds }

    val isEmpty: Boolean get() = photos.isEmpty()

    fun photo(id: String): SessionPhoto? = photos.firstOrNull { it.id == id }

    fun group(id: String): SessionGroup? = groups.firstOrNull { it.id == id }

    fun photosOf(groupId: String): List<SessionPhoto> =
        group(groupId)?.photoIds.orEmpty().mapNotNull(::photo)
}

/**
 * Every grouping edit, as pure functions over the state.
 *
 * All of them go through [normalize], which is what keeps the two invariants
 * that the rest of the flow assumes: a photo is in AT MOST one group, and a
 * group's cover is one of its own members. Enforcing them in one place means a
 * new edit cannot quietly break them.
 */
object AutolisterGroups {

    /** The server's cap on one handoff (`MAX_HANDOFF_PHOTOS`). */
    const val MAX_PHOTOS = 500

    /** `/propose-groups` takes 2..40 photos per call (`MAX_VERIFY_PHOTOS`). */
    const val PROPOSE_MIN = 2
    const val PROPOSE_WINDOW = 40

    /** `/verify-groups` takes 2..300 groups (`MAX_BATCH_ITEMS`). */
    const val VERIFY_MIN = 2
    const val VERIFY_MAX = 300

    /**
     * Re-establish the invariants.
     *
     * Later groups lose a contested photo rather than earlier ones, matching
     * the server's own parser: the first group to claim a photo keeps it, so a
     * client and a server that disagree about an overlap still land on the
     * same grouping.
     */
    fun normalize(state: AutolisterSessionState): AutolisterSessionState {
        val known = state.photos.map { it.id }.toSet()
        val claimed = mutableSetOf<String>()
        val groups = mutableListOf<SessionGroup>()
        for (group in state.groups) {
            val members = group.photoIds.filter { it in known && claimed.add(it) }
            if (members.isEmpty()) continue
            groups += group.copy(
                photoIds = members,
                coverId = group.coverId?.takeIf { it in members } ?: members.first(),
            )
        }
        return state.copy(groups = groups)
    }

    /** Add newly staged photos, ignoring ids already in the session. */
    fun withPhotos(
        state: AutolisterSessionState,
        added: List<SessionPhoto>,
    ): AutolisterSessionState {
        val known = state.photos.map { it.id }.toSet()
        val fresh = added.filter { it.id !in known && it.id.isNotBlank() }
        return normalize(state.copy(photos = (state.photos + fresh).take(MAX_PHOTOS)))
    }

    /** Drop a photo entirely — from the roll and from whatever group held it. */
    fun withoutPhoto(state: AutolisterSessionState, photoId: String): AutolisterSessionState =
        normalize(state.copy(photos = state.photos.filterNot { it.id == photoId }))

    /** Make a new group out of [photoIds], taking them from wherever they are. */
    fun grouped(
        state: AutolisterSessionState,
        photoIds: List<String>,
        id: String,
    ): AutolisterSessionState {
        val wanted = photoIds.distinct().filter { state.photo(it) != null }
        if (wanted.isEmpty()) return state
        val stripped = state.groups.map { it.copy(photoIds = it.photoIds - wanted.toSet()) }
        return normalize(
            state.copy(groups = stripped + SessionGroup(id = id, photoIds = wanted, coverId = wanted.first())),
        )
    }

    /** Send a group's photos back to the ungrouped tray. */
    fun ungrouped(state: AutolisterSessionState, groupId: String): AutolisterSessionState =
        normalize(state.copy(groups = state.groups.filterNot { it.id == groupId }))

    /** Fold [fromId] into [intoId]; order is preserved, [fromId] disappears. */
    fun merged(
        state: AutolisterSessionState,
        intoId: String,
        fromId: String,
    ): AutolisterSessionState {
        if (intoId == fromId) return state
        val into = state.group(intoId) ?: return state
        val from = state.group(fromId) ?: return state
        val groups = state.groups
            .filterNot { it.id == fromId }
            .map { if (it.id == intoId) it.copy(photoIds = into.photoIds + from.photoIds) else it }
        return normalize(state.copy(groups = groups))
    }

    /**
     * Split [photoIds] out of their group into a new one.
     *
     * A split that would take every photo is a rename, not a split, so it is
     * refused — leaving an empty group behind for [normalize] to delete would
     * silently turn one group into another with a different id.
     */
    fun split(
        state: AutolisterSessionState,
        groupId: String,
        photoIds: List<String>,
        newId: String,
    ): AutolisterSessionState {
        val group = state.group(groupId) ?: return state
        val moving = photoIds.filter { it in group.photoIds }
        if (moving.isEmpty() || moving.size == group.photoIds.size) return state
        return grouped(state, moving, newId)
    }

    /** Move photos into an existing group. */
    fun moved(
        state: AutolisterSessionState,
        photoIds: List<String>,
        toGroupId: String,
    ): AutolisterSessionState {
        val target = state.group(toGroupId) ?: return state
        val moving = photoIds.distinct().filter { state.photo(it) != null && it !in target.photoIds }
        if (moving.isEmpty()) return state
        val groups = state.groups.map { group ->
            when (group.id) {
                toGroupId -> group.copy(photoIds = group.photoIds + moving)
                else -> group.copy(photoIds = group.photoIds - moving.toSet())
            }
        }
        return normalize(state.copy(groups = groups))
    }

    fun withCover(
        state: AutolisterSessionState,
        groupId: String,
        photoId: String,
    ): AutolisterSessionState = normalize(
        state.copy(
            groups = state.groups.map {
                if (it.id == groupId) it.copy(coverId = photoId) else it
            },
        ),
    )

    /**
     * Take the model's proposal.
     *
     * Only photos that are still ungrouped are used, and a proposal reduced to
     * fewer than two survivors is dropped: the seller has been editing since
     * the pass ran, and quietly pulling a photo back out of the group they just
     * made by hand would undo their work with no way to see it happened.
     */
    fun applyProposals(
        state: AutolisterSessionState,
        proposals: List<ProposedGroup>,
        ids: List<String>,
    ): AutolisterSessionState {
        var next = state
        var idIndex = 0
        for (proposal in proposals) {
            val free = proposal.photoIds.filter { id -> next.ungrouped.any { it.id == id } }
            if (free.size < 2) continue
            val id = ids.getOrNull(idIndex++) ?: continue
            next = grouped(next, free, id)
        }
        return next
    }

    /**
     * Photos to send to `/propose-groups`, in windows the endpoint accepts.
     *
     * Windowed rather than truncated because each call is one billed AI action
     * over at most 40 photos: a 120-photo batch is three actions, and sending
     * only the first 40 would silently leave two thirds of the roll ungrouped.
     * A trailing window of one is dropped — the endpoint refuses fewer than
     * two, and a lone photo has nothing to be grouped with anyway.
     */
    fun proposeWindows(photos: List<SessionPhoto>): List<List<SessionPhoto>> =
        photos.chunked(PROPOSE_WINDOW).filter { it.size >= PROPOSE_MIN }

    /** Whether a verify pass can run at all — the endpoint needs two groups. */
    fun canVerify(state: AutolisterSessionState): Boolean = state.groups.size >= VERIFY_MIN

    /** The groups a verify pass covers, capped at what the endpoint takes. */
    fun verifyGroups(state: AutolisterSessionState): List<VerifyGroup> =
        state.groups.take(VERIFY_MAX).map { group ->
            VerifyGroup(
                id = group.id,
                photos = state.photosOf(group.id).map { GroupPhotoRef(it.id, it.storagePath) },
            )
        }

    /**
     * Act on one verify suggestion.
     *
     * Nothing here happens without a tap. The model is comparing photos it was
     * shown a sample of, and an auto-applied merge of two garments that look
     * alike would publish one listing with another item's photos in it.
     */
    fun applySuggestion(
        state: AutolisterSessionState,
        suggestion: GroupSuggestion,
        newId: String,
    ): AutolisterSessionState = when (suggestion.type) {
        "merge" -> suggestion.groupIds.getOrNull(1)?.let { from ->
            suggestion.groupIds.firstOrNull()?.let { into -> merged(state, into, from) }
        } ?: state

        "split" -> suggestion.groupIds.firstOrNull()
            ?.let { split(state, it, suggestion.photoIds, newId) } ?: state

        "move" -> suggestion.groupIds.getOrNull(1)
            ?.let { moved(state, suggestion.photoIds, it) } ?: state

        else -> state
    }

    /** Forget a suggestion the seller has answered, so it stops asking. */
    fun withoutSuggestion(
        state: AutolisterSessionState,
        suggestion: GroupSuggestion,
    ): AutolisterSessionState =
        state.copy(suggestions = state.suggestions.filterNot { it === suggestion })

    /**
     * The handoff payload.
     *
     * Ungrouped photos still go: the desktop can group them there, and dropping
     * them would silently lose photos the seller took on purpose. Groups go
     * cover-first so the desktop's own cover choice matches what the phone
     * showed.
     */
    fun handoff(state: AutolisterSessionState): CreateHandoffRequest = CreateHandoffRequest(
        stagingSessionId = state.stagingSessionId,
        photos = state.photos,
        groups = state.groups.map { group ->
            val cover = group.coverId
            val ordered = when {
                cover == null || cover !in group.photoIds -> group.photoIds
                else -> listOf(cover) + group.photoIds.filterNot { it == cover }
            }
            group.copy(photoIds = ordered, coverId = ordered.firstOrNull())
        },
    )
}
