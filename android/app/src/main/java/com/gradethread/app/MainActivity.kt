package com.gradethread.app

import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.material3.windowsizeclass.ExperimentalMaterial3WindowSizeClassApi
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass
import androidx.compose.material3.windowsizeclass.calculateWindowSizeClass
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.fragment.app.FragmentActivity
import com.gradethread.app.auth.AuthRepository
import com.gradethread.app.auth.AuthScreen
import com.gradethread.app.platform.applock.AppLock
import com.gradethread.app.platform.applock.LockScreen
import com.gradethread.app.platform.applock.PrivacyCover
import com.gradethread.app.marketplaces.EbayOAuthCallbacks
import com.gradethread.app.platform.deeplink.DeepLinkController
import com.gradethread.app.ui.shell.AppShell
import com.gradethread.app.ui.theme.GradeThreadTheme
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.delay

/**
 * US-1313: hosts the adaptive five-section shell. US-1315: FragmentActivity
 * (BiometricPrompt requires one); the lock overlay replaces the shell while
 * locked; the privacy cover blanks the Recents thumbnail whenever the lock
 * is enabled.
 */
@AndroidEntryPoint
class MainActivity : FragmentActivity() {

    /**
     * US-2369: the phase the shell/sign-in switch reads.
     *
     * Injected rather than reached through a ViewModel: the phase is
     * process-wide (AuthRepository is a @Singleton whose tail is started in
     * Application.onCreate), and a ViewModel here would just be a second
     * lifetime holding the same StateFlow.
     */
    @javax.inject.Inject
    lateinit var authRepository: AuthRepository

    @OptIn(ExperimentalMaterial3WindowSizeClassApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        // US-2899: BEFORE super.onCreate. The library swaps the window theme
        // here, and it has to happen before the content view exists.
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)
        // One clock for both escapes below, read after super.onCreate because
        // that is where Hilt fills authRepository.
        val launchedAt = SystemClock.elapsedRealtime()
        splash.setKeepOnScreenCondition {
            // US-2900: hold until the LOCK MODE is known.
            //
            // This condition used to rely on AppLock.initialize having blocked
            // Application.onCreate on a DataStore read, so `locked` was settled
            // before the first composition. That read is async now, and without
            // this clause the shell would render UNLOCKED for the frames before
            // the answer arrives - which is the exact thing the blocking read
            // was there to prevent. The splash is already on screen, so waiting
            // here costs nothing that was not already being spent.
            //
            // Bounded by the same clock as the auth escape below: a storage
            // failure must not hold the logo forever.
            (
                !AppLock.resolved.value &&
                    SystemClock.elapsedRealtime() - launchedAt < SPLASH_MAX_HOLD_MS
                ) ||
                // A LOCKED LAUNCH IS NOT WAITING ON ANYTHING ELSE. Once the mode
                // is known and it says locked, the lock screen can draw
                // immediately; holding for the session restore would delay it
                // behind up to five seconds of logo for no reason - the lock is
                // what the seller has to answer either way.
                (
                    !AppLock.locked.value &&
                        authRepository.phase.value is AuthRepository.Phase.Loading &&
                        SystemClock.elapsedRealtime() - launchedAt < SPLASH_MAX_HOLD_MS
                    )
        }
        enableEdgeToEdge()
        // US-1314: the launch intent may carry a deep link. isReady=true until
        // the auth-gated shell story wires the real signed-in check; the
        // controller's queue/replay semantics are already in place for it.
        DeepLinkController.shared.offer(intent?.data, isReady = true)
        // US-1350: the eBay consent bounce-back needs the whole URI, not a
        // reduced nav destination.
        EbayOAuthCallbacks.offer(intent?.data)
        setContent {
            GradeThreadTheme {
                val locked by AppLock.locked.collectAsState()
                val authPhase by authRepository.phase.collectAsState()
                if (locked) {
                    LockScreen(onUnlock = { AppLock.promptUnlock(this) })
                } else {
                    // US-2369: the shell used to compose UNCONDITIONALLY, so
                    // the app was unusable by anyone without a session — there
                    // was nowhere to sign in. Loading renders nothing rather
                    // than flashing the form: the session restores from
                    // encrypted storage in milliseconds, and a sign-in screen
                    // that appears and vanishes on every cold start reads as a
                    // bug.
                    // US-2899: the escape hatch for a restore that never
                    // finishes. The splash lets go at SPLASH_MAX_HOLD_MS and
                    // this flips off the SAME clock, so the two cannot
                    // disagree about when the app gave up waiting.
                    var restoreGaveUp by remember { mutableStateOf(false) }
                    LaunchedEffect(Unit) {
                        val remaining =
                            SPLASH_MAX_HOLD_MS - (SystemClock.elapsedRealtime() - launchedAt)
                        if (remaining > 0) delay(remaining)
                        restoreGaveUp = true
                    }
                    when (authPhase) {
                        is AuthRepository.Phase.SignedIn -> {
                            val sizeClass = calculateWindowSizeClass(this)
                            AppShell(
                                isCompactWidth =
                                sizeClass.widthSizeClass == WindowWidthSizeClass.Compact,
                            )
                        }

                        AuthRepository.Phase.SignedOut -> AuthScreen()
                        // US-2899: Loading renders nothing WHILE THE SPLASH IS
                        // UP, which is the whole point - the launch icon is on
                        // screen, not a blank rectangle. Past the bound it
                        // renders the sign-in screen instead of nothing: the
                        // shell cannot draw without a session, so sign-in is
                        // the only surface with an action on it, and a restore
                        // that has not finished in five seconds has failed.
                        // The cost of being wrong is a form that appears and is
                        // replaced by the shell - the flash US-2369 avoids -
                        // but only on the failure path, where it is the right
                        // trade against staring at a logo forever.
                        AuthRepository.Phase.Loading ->
                            if (restoreGaveUp) AuthScreen() else Unit
                    }
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        // US-1315: keep the cover in sync with the setting; prompt when locked.
        PrivacyCover.apply(window, enabled = AppLock.mode != AppLock.Mode.OFF)
        AppLock.promptUnlock(this)
    }

    override fun onStop() {
        super.onStop()
        // Arm the lock the moment the app leaves the foreground.
        AppLock.onBackground()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        DeepLinkController.shared.offer(intent.data, isReady = true)
        EbayOAuthCallbacks.offer(intent.data)
    }

    private companion object {
        /**
         * US-2899: how long the launch icon may cover a session restore.
         *
         * Generous on purpose. The session comes out of encrypted storage in
         * milliseconds, so a normal cold start never reaches this and never
         * shows the sign-in form. Five seconds is the point at which "still
         * restoring" stops being a plausible explanation.
         */
        const val SPLASH_MAX_HOLD_MS = 5_000L
    }
}
