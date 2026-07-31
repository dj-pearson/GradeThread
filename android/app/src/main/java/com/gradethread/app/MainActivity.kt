package com.gradethread.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.material3.windowsizeclass.ExperimentalMaterial3WindowSizeClassApi
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass
import androidx.compose.material3.windowsizeclass.calculateWindowSizeClass
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
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
        super.onCreate(savedInstanceState)
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
                    when (authPhase) {
                        is AuthRepository.Phase.SignedIn -> {
                            val sizeClass = calculateWindowSizeClass(this)
                            AppShell(
                                isCompactWidth =
                                    sizeClass.widthSizeClass == WindowWidthSizeClass.Compact,
                            )
                        }

                        AuthRepository.Phase.SignedOut -> AuthScreen()
                        AuthRepository.Phase.Loading -> Unit
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
}
