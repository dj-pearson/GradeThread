package com.gradethread.app.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * US-1322: connectivity as a Flow. The initial value is read SYNCHRONOUSLY
 * from the active network so a cold launch with no connection shows offline
 * immediately instead of flashing online until the first callback.
 */
class ConnectivityMonitor(context: Context) {

    private val manager =
        context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    private val onlineFlow = MutableStateFlow(currentlyOnline())
    val online: StateFlow<Boolean> = onlineFlow

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            onlineFlow.value = true
        }

        override fun onLost(network: Network) {
            onlineFlow.value = currentlyOnline() // another network may remain
        }
    }

    fun start() {
        runCatching { manager.registerDefaultNetworkCallback(callback) }
    }

    fun stop() {
        runCatching { manager.unregisterNetworkCallback(callback) }
    }

    private fun currentlyOnline(): Boolean {
        val network = manager.activeNetwork ?: return false
        val caps = manager.getNetworkCapabilities(network) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }
}

/**
 * US-997: coalesces a burst of [trigger] calls into a single TRAILING
 * execution of [action], at most once per [windowMs]. Walking between Wi-Fi
 * and cell can flap connectivity several times a second; each flap otherwise
 * kicks a full flush+pull. Every trigger (re)starts the window, so a burst
 * keeps deferring until the link settles, then fires exactly once.
 *
 * Manual pull-to-refresh deliberately does NOT go through here — call
 * [fireNow] so a user gesture stays immediate.
 */
class ConnectivityDebouncer(
    private val scope: CoroutineScope,
    private val windowMs: Long = 2_000,
    private val action: suspend () -> Unit,
) {
    private var pending: Job? = null

    fun trigger() {
        pending?.cancel()
        pending = scope.launch {
            delay(windowMs)
            action()
        }
    }

    /** Manual-sync bypass: cancel any pending run and fire immediately. */
    suspend fun fireNow() {
        pending?.cancel()
        pending = null
        action()
    }
}
