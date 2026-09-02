package com.gradethread.app.ui.state

/**
 * US-1390 (iOS `@SceneStorage`, US-1157): the rules for restoring a screen's
 * place after rotation, process death, or a fold/split-screen transition.
 *
 * Pure, and separate from the composables, because restoration failures are
 * invisible until they happen on someone else's device: an id that no longer
 * exists, a saved enum a later build renamed, or a selection large enough to
 * blow the Binder transaction limit and kill the app on rotate.
 */
object Restorable {

    /**
     * Saved-state keys.
     *
     * A stable CONTRACT, not decoration. `rememberSaveable` and
     * `SavedStateHandle` both key by string, so renaming one silently drops
     * whatever it restored — the app keeps working and simply forgets, which is
     * the hardest kind of regression to notice.
     */
    object Keys {
        const val ADD_SHEET_OPEN = "shell.addSheetOpen"
        const val INVENTORY_FILTERS_OPEN = "inventory.filtersOpen"
        const val INVENTORY_SELECTION = "inventory.selection"
        const val INVENTORY_STAGE = "inventory.stage"
        const val INVENTORY_UNLISTED_FILTER = "inventory.unlistedFilter"
        const val INVENTORY_SORT = "inventory.sort"
        const val INVENTORY_VIEW_MODE = "inventory.viewMode"
        const val INVENTORY_QUERY = "inventory.query"
        const val SEARCH_QUERY = "search.query"
    }

    /**
     * How many ids a saved selection may carry.
     *
     * Saved state crosses a Binder transaction with a ~1MB budget SHARED across
     * the whole activity, and exceeding it throws `TransactionTooLargeException`
     * — which on rotation is a crash, not a lost selection. A seller who
     * long-presses and taps "select all" on 4,000 items would hit it.
     *
     * 500 uuids is roughly 18KB, which is safe, and past 500 the selection is a
     * bulk action rather than a set of choices anyone is tracking by eye.
     */
    const val MAX_SAVED_SELECTION = 500

    /**
     * Trim a selection down to something saved state can carry, as ONE string.
     *
     * A string rather than a list because `rememberSaveable`'s default saver
     * only accepts what a `Bundle` accepts, and a Kotlin `List` is not that — it
     * would throw at runtime on the first rotation, which is a crash nobody
     * sees until a device is turned sideways. Ids are lowercased uuids, so the
     * separator can never appear inside one.
     */
    const val SELECTION_SEPARATOR = ","

    fun saveableSelection(selection: Set<String>): String =
        selection.take(MAX_SAVED_SELECTION).joinToString(SELECTION_SEPARATOR)

    /**
     * Restore a selection against the rows that are actually present now.
     *
     * Ids that no longer exist are DROPPED. A process death can be minutes or
     * days later; a sync in between may have removed items, and a selection
     * carrying ghosts turns "delete 12 items" into a request the server rejects
     * halfway through.
     */
    fun restoreSelection(saved: String?, presentIds: Set<String>): Set<String> = saved.orEmpty()
        .split(SELECTION_SEPARATOR)
        .filterTo(mutableSetOf()) { it.isNotBlank() && it in presentIds }

    /**
     * Restore a saved enum by name.
     *
     * By NAME rather than ordinal: an ordinal silently shifts the moment
     * anyone inserts a case, so a saved "Listed" filter would come back as
     * "Sold" after an unrelated edit. An unknown name falls back rather than
     * throwing — a saved value from a newer build must not crash an older one.
     */
    inline fun <reified T : Enum<T>> restoreEnum(saved: String?, fallback: T): T =
        saved?.let { name -> enumValues<T>().firstOrNull { it.name == name } } ?: fallback

    /**
     * Whether a saved route is still reachable.
     *
     * A route removed or renamed between builds would otherwise be restored
     * into a nav graph that has no such destination — which is a crash on
     * launch for anyone whose app was killed on that screen.
     */
    fun restoreRoute(saved: String?, known: Set<String>): String? = saved?.takeIf { it in known }

    /**
     * Whether a fold or split-screen change is worth reacting to.
     *
     * A foldable reports a width change on every hinge degree during the
     * animation. Recomputing a layout on each one is what makes a fold stutter,
     * so only a real compact/expanded CROSSING counts.
     */
    fun layoutChanged(wasCompact: Boolean, isCompact: Boolean): Boolean = wasCompact != isCompact
}
