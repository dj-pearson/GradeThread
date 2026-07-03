package com.gradethread.app.platform.applock

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** US-1315: the pure lock decisions — authenticator classes + anti-lockout. */
class AppLockTest {

    @Test
    fun authenticators_mapPerMode() {
        assertEquals(0, AppLock.allowedAuthenticators(AppLock.Mode.OFF))
        assertEquals(
            BIOMETRIC_WEAK or DEVICE_CREDENTIAL,
            AppLock.allowedAuthenticators(AppLock.Mode.BIOMETRICS_OR_CREDENTIAL),
        )
        assertEquals(
            BIOMETRIC_STRONG,
            AppLock.allowedAuthenticators(AppLock.Mode.BIOMETRICS_ONLY),
        )
    }

    @Test
    fun antiLockout_autoUnlocksOnEveryNonSuccessAnswer() {
        // Only a SUCCESS answer means the prompt can actually be passed.
        assertFalse(AppLock.shouldAutoUnlock(BiometricManager.BIOMETRIC_SUCCESS))
        // Every stranding answer auto-unlocks (never lock the user out):
        assertTrue(AppLock.shouldAutoUnlock(BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED))
        assertTrue(AppLock.shouldAutoUnlock(BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE))
        assertTrue(AppLock.shouldAutoUnlock(BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE))
        assertTrue(AppLock.shouldAutoUnlock(BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED))
        assertTrue(AppLock.shouldAutoUnlock(BiometricManager.BIOMETRIC_STATUS_UNKNOWN))
    }

    @Test
    fun modeStorage_roundTripsAndDefaultsOff() {
        for (mode in AppLock.Mode.entries) {
            assertEquals(mode, AppLock.Mode.fromStorage(mode.storageValue))
        }
        assertEquals(AppLock.Mode.OFF, AppLock.Mode.fromStorage(null))
        assertEquals(AppLock.Mode.OFF, AppLock.Mode.fromStorage("garbage"))
    }
}
