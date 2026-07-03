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
import com.gradethread.app.platform.applock.AppLock
import com.gradethread.app.platform.applock.LockScreen
import com.gradethread.app.platform.applock.PrivacyCover
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
    @OptIn(ExperimentalMaterial3WindowSizeClassApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // US-1314: the launch intent may carry a deep link. isReady=true until
        // the auth-gated shell story wires the real signed-in check; the
        // controller's queue/replay semantics are already in place for it.
        DeepLinkController.shared.offer(intent?.data, isReady = true)
        setContent {
            GradeThreadTheme {
                val locked by AppLock.locked.collectAsState()
                if (locked) {
                    LockScreen(onUnlock = { AppLock.promptUnlock(this) })
                } else {
                    val sizeClass = calculateWindowSizeClass(this)
                    AppShell(
                        isCompactWidth = sizeClass.widthSizeClass == WindowWidthSizeClass.Compact,
                    )
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
    }
}
