package com.gradethread.app.inventory

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * US-1369 AC3: a one-shot "open inventory filtered to this brand" request.
 *
 * The inventory list is a bottom-nav SECTION with a saved back stack, so its
 * route can't carry an argument without changing what "this tab is selected"
 * means. This is the same offer/consume shape `DeepLinkController` and
 * `EbayOAuthCallbacks` already use for exactly that reason.
 *
 * CONSUMED, not merely read. A request that stayed set would re-apply the filter
 * every time the seller returned to the tab — reasonable-looking behaviour that
 * would make the brand filter feel impossible to clear.
 */
object InventoryFilterRequests {

    private val _brand = MutableStateFlow<String?>(null)

    /** Null when there is nothing pending. */
    val brand: StateFlow<String?> = _brand.asStateFlow()

    /** Ask the inventory list to open filtered to [name]. Blank is ignored. */
    fun requestBrand(name: String) {
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return
        _brand.value = trimmed
    }

    /** Take the pending request, leaving nothing behind. */
    fun consumeBrand(): String? {
        val pending = _brand.value
        _brand.value = null
        return pending
    }

    /** Sign-out and tests. */
    fun clear() {
        _brand.value = null
    }
}
