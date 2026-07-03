package com.gradethread.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.material3.windowsizeclass.ExperimentalMaterial3WindowSizeClassApi
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass
import androidx.compose.material3.windowsizeclass.calculateWindowSizeClass
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
        setContent {
            GradeThreadTheme {
                val sizeClass = calculateWindowSizeClass(this)
                AppShell(
                    isCompactWidth = sizeClass.widthSizeClass == WindowWidthSizeClass.Compact,
                )
            }
        }
    }
}
