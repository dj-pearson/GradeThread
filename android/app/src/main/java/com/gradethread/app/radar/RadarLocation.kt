package com.gradethread.app.radar

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.CancellationSignal
import androidx.annotation.RequiresPermission
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.coroutines.resume

/**
 * US-2492: one coarse fix, on demand, for centring the nearby list.
 *
 * Behind an interface so [RadarNearbyViewModel] is testable with no Android
 * runtime, and deliberately free of Compose: the runtime-permission DIALOG is
 * the screen's job (it reuses the launcher pattern the capture flow already
 * uses), and this only answers "may I" and "where".
 *
 * **Coarse only, and that is the whole permission this feature asks for.** Fine
 * location would buy nothing: the server keeps roughly a one-kilometre cell, and
 * [RadarScoring.quantize] rounds the box to 0.05 degrees before it leaves the
 * device, so a metre-accurate fix would be thrown away twice over on the way
 * out. Asking for it anyway would be asking for a permission we cannot use.
 *
 * **This never contributes anything.** The fix becomes a bounding box in a GET
 * query string and nothing else. It is not attached to a scan, and it is not
 * written anywhere - see the note on `ScoutService.prospect` for why the scan
 * path stays coordinate-free.
 */
interface RadarLocating {

    /** Whether the coarse-location permission has already been granted. */
    fun hasPermission(): Boolean

    /**
     * One fix, or null.
     *
     * ALWAYS resolves inside [timeoutMillis]. A device indoors with the network
     * provider disabled can leave a location callback pending indefinitely, and a
     * "Locating..." spinner that never stops is worse than an honest "couldn't
     * get it".
     */
    suspend fun currentFix(timeoutMillis: Long = DEFAULT_TIMEOUT_MILLIS): RadarPoint?

    companion object {
        const val DEFAULT_TIMEOUT_MILLIS = 8_000L
    }
}

@Singleton
class AndroidRadarLocation @Inject constructor(
    @ApplicationContext private val context: Context,
) : RadarLocating {

    override fun hasPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    override suspend fun currentFix(timeoutMillis: Long): RadarPoint? {
        // Checked HERE rather than in a helper so lint can see it: `lintDebug`
        // gates CI, and a MissingPermission suppression would hide the one thing
        // that makes the call below legal.
        val granted = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted) return null

        val manager = ContextCompat.getSystemService(context, LocationManager::class.java)
            ?: return null
        // The network provider is what COARSE actually grants. GPS is a fine
        // permission we deliberately do not hold, and passive is the last resort
        // that reads whatever another app already asked for.
        val provider = when {
            manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER) ->
                LocationManager.NETWORK_PROVIDER
            manager.isProviderEnabled(LocationManager.PASSIVE_PROVIDER) ->
                LocationManager.PASSIVE_PROVIDER
            else -> null
        } ?: return null

        return withTimeoutOrNull(timeoutMillis) { awaitFix(manager, provider) }
    }

    @RequiresPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
    private suspend fun awaitFix(
        manager: LocationManager,
        provider: String,
    ): RadarPoint? = suspendCancellableCoroutine { continuation ->
        val signal = CancellationSignal()
        // Fires on the timeout too, so a cancelled wait stops the provider
        // instead of leaving it running for a result nobody will read.
        continuation.invokeOnCancellation { signal.cancel() }
        LocationManagerCompat.getCurrentLocation(
            manager,
            provider,
            signal,
            ContextCompat.getMainExecutor(context),
        ) { location ->
            if (continuation.isActive) {
                continuation.resume(location?.let { RadarPoint(it.latitude, it.longitude) })
            }
        }
    }
}

@Module
@InstallIn(SingletonComponent::class)
object RadarLocationModule {

    /**
     * Bound to the interface rather than injected concretely so the view model
     * takes a seam a JVM test can fill. The screen still talks to the real one.
     */
    @Provides
    @Singleton
    fun provideRadarLocating(impl: AndroidRadarLocation): RadarLocating = impl
}
