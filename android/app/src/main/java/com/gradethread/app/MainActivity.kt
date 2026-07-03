package com.gradethread.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.material3.windowsizeclass.ExperimentalMaterial3WindowSizeClassApi
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass
import androidx.compose.material3.windowsizeclass.calculateWindowSizeClass
import com.gradethread.app.platform.deeplink.DeepLinkController
import com.gradethread.app.ui.shell.AppShell
import com.gradethread.app.ui.theme.GradeThreadTheme
import dagger.hilt.android.AndroidEntryPoint

/**
 * US-1313: hosts the adaptive five-section shell. The window size class
 * drives bottom-bar vs rail; recomputed automatically on fold/rotate.
 */
@AndroidEntryPoint
class MainActivity : ComponentActivity() {
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
                val sizeClass = calculateWindowSizeClass(this)
                AppShell(
                    isCompactWidth = sizeClass.widthSizeClass == WindowWidthSizeClass.Compact,
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        DeepLinkController.shared.offer(intent.data, isReady = true)
    }
}
