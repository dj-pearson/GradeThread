package com.gradethread.app.radar

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-2492: the nearby surface, three layers deep.
 *
 * Keeping the layers apart is most of what this class is (full rule set:
 * `vault/20-domain/thrift-radar.md`):
 *
 *   1. THE PERSONAL LAYER is free, needs no consent and works at n=1. It loads
 *      first, it is never gated, and it is what everything else degrades to - a
 *      locked plan, a failed request, an empty area and no signal all end at the
 *      same honest list of the seller's own stores.
 *   2. THE NETWORK LAYER is Pro+, enforced by the endpoint. A 402 is not an
 *      error here: `EdgeApi` has already routed it to the upgrade dialog, so
 *      this only records that the layer is locked and leaves the personal one on
 *      screen.
 *   3. THE K-ANONYMITY FLOOR is neither of those. It is applied server-side and
 *      a below-floor venue is simply ABSENT, so no amount of paying reveals it.
 *      What changes it is contributions.
 *
 * **Viewing is not contributing, and Android contributes nothing at all.** This
 * screen only READS. The one write path Radar has is the scout scan
 * (`routes/flipdesk-scout.ts`), and it fires only when the client sends a
 * coordinate - which Android's `ProspectRequest` deliberately does not. The fix
 * this screen collects becomes a quantized bounding box in a GET query string
 * and never a POST body, so the seller's own scan log stays theirs, covered by
 * the account export (US-2412) and shared with nobody. Do not add a coordinate
 * to the scan request thinking its absence was an oversight.
 *
 * **Where location fits.** Radar opens with NO permission prompt: the seller's
 * own linked stores are places we already know, so the first box is centred on
 * those. Android is asked where the phone is only when the seller taps "Use my
 * location".
 */
@HiltViewModel
class RadarNearbyViewModel @Inject constructor(
    private val stores: MyStoresService,
    private val radar: RadarService,
    private val location: RadarLocating,
) : ViewModel() {

    data class State(
        val window: RadarWindow = RadarWindow.DEFAULT,
        val loadingPersonal: Boolean = false,
        val personal: MyStores? = null,
        val personalError: String? = null,
        val loadingNetwork: Boolean = false,
        val venues: List<RadarVenue> = emptyList(),
        val kFloor: Int = 0,
        val networkError: String? = null,
        /** Sticky within a session: a Free seller should see one upgrade prompt. */
        val networkLocked: Boolean = false,
        val area: RadarBoundingBox? = null,
        /**
         * Only set once the seller has asked, and only used to LABEL rows with a
         * distance and break ranking ties. Never sent.
         */
        val centre: RadarPoint? = null,
        val locating: Boolean = false,
        val locationDenied: Boolean = false,
        val locationFailed: Boolean = false,
    ) {
        val rows: List<RadarNearbyRow>
            get() = RadarScoring.rows(
                venues = venues,
                personal = personal?.stores.orEmpty(),
                centre = centre,
                area = area,
            )

        /**
         * The seller's stores with no place on the map yet. They hold real money,
         * so they are listed separately rather than dropped.
         */
        val offMapStores: List<MyStore>
            get() = personal?.stores.orEmpty()
                .filter { it.point == null && it.itemsSourced > 0 }

        /** Loaded both layers and genuinely found nothing, as opposed to not asked. */
        val isEmpty: Boolean get() = personal != null && rows.isEmpty()

        val isLoading: Boolean get() = loadingPersonal || loadingNetwork
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun hasLocationPermission(): Boolean = location.hasPermission()

    /** First load: the free layer, then (if there is somewhere to look) the shared one. */
    fun load() {
        if (_state.value.isLoading) return
        viewModelScope.launch {
            loadPersonal()
            seedAreaFromOwnStores()
            loadNetwork()
        }
    }

    fun retryPersonal() {
        if (_state.value.loadingPersonal) return
        viewModelScope.launch { loadPersonal() }
    }

    fun retryNetwork() {
        if (_state.value.loadingNetwork) return
        viewModelScope.launch { loadNetwork() }
    }

    fun setWindow(window: RadarWindow) {
        if (window == _state.value.window) return
        _state.value = _state.value.copy(window = window)
        viewModelScope.launch { loadNetwork() }
    }

    /**
     * Re-arm the network layer after a lock.
     *
     * The lock is sticky within a session so a Free seller is not shown the
     * upgrade dialog on every window change. This is the deliberate way back in:
     * an explicit tap, which re-hits the endpoint and lets the SERVER decide
     * again, since it is the only thing that knows whether they just upgraded.
     */
    fun checkNetworkAgain() {
        _state.value = _state.value.copy(networkLocked = false, networkError = null)
        viewModelScope.launch { loadNetwork() }
    }

    /** Result of the runtime prompt the screen owns. */
    fun onLocationPermission(granted: Boolean) {
        if (!granted) {
            _state.value = _state.value.copy(locationDenied = true, locating = false)
            return
        }
        _state.value = _state.value.copy(locationDenied = false)
        useMyLocation()
    }

    /**
     * Centre the list on where the phone is.
     *
     * The fix is turned into a quantized bounding box immediately: what leaves
     * the device is a rectangle a few kilometres a side, and it is a query, not a
     * contribution.
     */
    fun useMyLocation() {
        if (_state.value.locating) return
        _state.value = _state.value.copy(locating = true, locationFailed = false)
        viewModelScope.launch {
            val fix = location.currentFix()
            if (fix == null) {
                _state.value = _state.value.copy(
                    locating = false,
                    // Told apart from a refusal: one is answered in Settings, the
                    // other by standing near a window and tapping again.
                    locationFailed = location.hasPermission(),
                    locationDenied = !location.hasPermission(),
                )
                return@launch
            }
            _state.value = _state.value.copy(
                locating = false,
                centre = fix,
                area = RadarScoring.quantize(RadarScoring.boundingBox(around = fix)),
            )
            loadNetwork()
        }
    }

    // -- Loading --------

    private suspend fun loadPersonal() {
        _state.value = _state.value.copy(loadingPersonal = true, personalError = null)
        // Sorted by return, matching iOS: the brands and shops that earned most
        // per dollar are the ones worth centring a sourcing run on.
        runCatching { stores.stores(StoreSort.ROI) }
            .onSuccess { _state.value = _state.value.copy(personal = it) }
            .onFailure {
                // The personal layer failing is the only real failure on this
                // screen: there is nothing further to fall back to.
                _state.value = _state.value.copy(personalError = MyStoresService.message(it))
            }
        _state.value = _state.value.copy(loadingPersonal = false)
    }

    /** Cold start with no prompt: centre on the shops we already know are theirs. */
    private fun seedAreaFromOwnStores() {
        if (_state.value.area != null) return
        val points = _state.value.personal?.stores.orEmpty().mapNotNull { it.point }
        RadarScoring.boundingBox(covering = points)
            ?.let { _state.value = _state.value.copy(area = RadarScoring.quantize(it)) }
    }

    private suspend fun loadNetwork() {
        val current = _state.value
        val area = current.area ?: return
        if (current.networkLocked) return
        _state.value = current.copy(loadingNetwork = true, networkError = null)
        runCatching { radar.venues(area.param, current.window) }
            .onSuccess {
                _state.value = _state.value.copy(venues = it.venues, kFloor = it.kFloor)
            }
            .onFailure { error ->
                // A plan wall is not a failure: the upgrade dialog is already up,
                // so all that is left is to stop asking and leave the personal
                // layer on screen.
                _state.value = _state.value.copy(
                    venues = emptyList(),
                    networkLocked = RadarService.isPlanGated(error),
                    networkError = MyStoresService.message(error),
                )
            }
        _state.value = _state.value.copy(loadingNetwork = false)
    }
}
