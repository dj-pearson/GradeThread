package com.gradethread.app.platform.applock

import android.content.Context
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import androidx.fragment.app.FragmentActivity
import com.gradethread.app.platform.telemetry.Telemetry
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import java.util.concurrent.atomic.AtomicBoolean

private val Context.appLockDataStore by preferencesDataStore(name = "app_lock")

/**
 * US-1315: optional biometric/device-credential app lock (iOS AppLock).
 * Sales/payout figures are private data — the lock arms on background and
 * prompts on foreground/cold launch.
 *
 * Rules carried from iOS:
 *  - two modes: biometrics-or-credential (the default when enabled) and
 *    biometrics-only;
 *  - ANTI-LOCKOUT: a device with no enrolled auth for the required class
 *    AUTO-UNLOCKS (telemetered) — a privacy nicety must never strand the
 *    user out of their own inventory;
 *  - the prompt is re-entrance-guarded (rapid foreground bounces can't stack
 *    system dialogs).
 */
object AppLock {

    enum class Mode(val storageValue: String) {
        OFF("off"),
        BIOMETRICS_OR_CREDENTIAL("bio_or_credential"),
        BIOMETRICS_ONLY("bio_only"),
        ;

        companion object {
            fun fromStorage(value: String?): Mode =
                entries.firstOrNull { it.storageValue == value } ?: OFF
        }
    }

    private val MODE_KEY = stringPreferencesKey("mode")

    private val lockedFlow = MutableStateFlow(false)
    val locked: StateFlow<Boolean> = lockedFlow

    @Volatile
    var mode: Mode = Mode.OFF
        private set

    private val promptInFlight = AtomicBoolean(false)

    /**
     * Load the persisted mode once at startup (small read, like Telemetry).
     *
     * The read stays BLOCKING on purpose: this runs from
     * `Application.onCreate`, and a mode resolved asynchronously would leave a
     * window in which the first frame draws unlocked on a phone whose owner
     * asked for a lock. That is the one thing this feature exists to prevent,
     * and it is worth a few milliseconds of a file read.
     *
     * What it must NOT do is throw. DataStore raises `CorruptionException` for
     * a truncated preferences file, and an uncaught throw out of `onCreate` is
     * a crash on every launch that only a reinstall clears - the same class of
     * failure `DatabaseProvider` carries a whole recovery ladder for.
     *
     * A failed read falls back to OFF, which is the value a fresh install
     * carries. That IS fail-open for a security control, and it is the lesser
     * evil: a corrupt store has genuinely lost the setting, and the
     * alternative - locking with a mode nobody can satisfy - strands the owner
     * behind a prompt that can never succeed.
     */
    fun initialize(context: Context) {
        mode = runCatching {
            runBlocking {
                Mode.fromStorage(context.appLockDataStore.data.first()[MODE_KEY])
            }
        }.getOrDefault(Mode.OFF)
        // A cold launch with the lock enabled starts locked.
        if (mode != Mode.OFF) lockedFlow.value = true
    }

    suspend fun setMode(context: Context, newMode: Mode) {
        context.appLockDataStore.edit { it[MODE_KEY] = newMode.storageValue }
        mode = newMode
        if (newMode == Mode.OFF) lockedFlow.value = false
    }

    /** The app left the foreground — arm the lock (no-op when disabled). */
    fun onBackground() {
        if (mode != Mode.OFF) lockedFlow.value = true
    }

    // ── Pure decisions (unit-tested) ─────────────────────────────────────────

    /** BiometricPrompt authenticator classes per mode. */
    fun allowedAuthenticators(mode: Mode): Int = when (mode) {
        Mode.OFF -> 0
        // Any biometric class, or the device PIN/pattern/password.
        Mode.BIOMETRICS_OR_CREDENTIAL -> BIOMETRIC_WEAK or DEVICE_CREDENTIAL
        // Strict: strong-class biometrics only.
        Mode.BIOMETRICS_ONLY -> BIOMETRIC_STRONG
    }

    /**
     * ANTI-LOCKOUT: given BiometricManager.canAuthenticate's answer for the
     * mode's authenticators, should the app auto-unlock instead of prompting?
     * Only BIOMETRIC_SUCCESS means a prompt can succeed; every other answer
     * (none enrolled, no hardware, unavailable, unsupported…) would strand
     * the user behind an unpassable lock.
     */
    fun shouldAutoUnlock(canAuthenticateResult: Int): Boolean =
        canAuthenticateResult != BiometricManager.BIOMETRIC_SUCCESS

    // ── Prompt ───────────────────────────────────────────────────────────────

    /**
     * Present the unlock prompt (foreground/cold-launch). Re-entrant calls
     * while one is showing are ignored.
     */
    fun promptUnlock(activity: FragmentActivity) {
        if (mode == Mode.OFF || !lockedFlow.value) return
        if (!promptInFlight.compareAndSet(false, true)) return

        val authenticators = allowedAuthenticators(mode)
        val canAuth = BiometricManager.from(activity).canAuthenticate(authenticators)
        if (shouldAutoUnlock(canAuth)) {
            // Never strand the user; note it so support can see why the lock
            // silently opened on this device.
            Telemetry.event(
                "app_lock_auto_unlock",
                mapOf("can_authenticate" to canAuth, "mode" to mode.storageValue),
            )
            lockedFlow.value = false
            promptInFlight.set(false)
            return
        }

        val prompt = BiometricPrompt(
            activity,
            ContextCompat.getMainExecutor(activity),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(
                    result: BiometricPrompt.AuthenticationResult,
                ) {
                    lockedFlow.value = false
                    promptInFlight.set(false)
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    // Stay locked; the lock screen's Unlock button re-prompts.
                    promptInFlight.set(false)
                }
            },
        )
        val builder = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Unlock GradeThread")
            .setAllowedAuthenticators(authenticators)
        if (authenticators and DEVICE_CREDENTIAL == 0) {
            // A negative button is required when device credential isn't an option.
            builder.setNegativeButtonText("Cancel")
        }
        prompt.authenticate(builder.build())
    }
}
