package com.gradethread.app.marketplaces

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * US-3144: which item a "listings still live" push was about.
 *
 * WHY A HOLDER AND NOT A NAV ARGUMENT. The pending-delist list is a section of
 * the Marketplaces screen, and Marketplaces is a bottom-nav section root. Giving
 * that root an `?item=` argument (the shape `ShellRoutes.negotiation` uses)
 * would mean two different route strings for one section, and the shell's
 * per-section back stacks save and restore by route — so the tab a seller
 * reached from a push would stop being the tab they reach from the nav bar.
 *
 * WHY A StateFlow AND NOT A ONE-SHOT CALL. The tap can arrive either way round
 * and both have to work:
 *   - the screen is not composed yet (cold launch, or the seller was on another
 *     tab) — a StateFlow replays its current value to a new collector;
 *   - the screen is already on-screen — a live collector gets the emission.
 * A plain callback would serve the second case and silently drop the first,
 * which is the more common one: the seller is not looking at Marketplaces when
 * the sale lands.
 *
 * [consume] clears only the request it was handed, so a second push arriving
 * while the first is being applied is not lost. Mirrors
 * `PendingDelistFocusLatch` on iOS.
 */
object PendingDelistFocus {

    /**
     * [itemId] may be null: a push that named no item still opens the list, and
     * that is the right answer — there is nothing else it could have meant.
     *
     * [requestedAt] makes two requests for the SAME item distinct values, so a
     * second sale of a second copy still re-triggers the collector.
     */
    data class Request(val itemId: String?, val requestedAt: Long = System.nanoTime())

    private val state = MutableStateFlow<Request?>(null)
    val requests: StateFlow<Request?> = state

    fun request(itemId: String?) {
        state.value = Request(itemId)
    }

    /** Clear [request] if it is still the outstanding one. */
    fun consume(request: Request) {
        state.compareAndSet(request, null)
    }
}
