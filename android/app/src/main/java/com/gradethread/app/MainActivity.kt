package com.gradethread.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.GradeThreadTheme
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.brandScore
import com.gradethread.app.ui.theme.cardStyle
import dagger.hilt.android.AndroidEntryPoint

/**
 * US-1300: placeholder shell. Real navigation (Navigation-Compose graph
 * mirroring the iOS tab structure) lands with the auth + shell stories.
 */
@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            GradeThreadTheme {
                PlaceholderShell()
            }
        }
    }
}

@Composable
fun PlaceholderShell(modifier: Modifier = Modifier) {
    Scaffold(modifier = modifier.fillMaxSize()) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(24.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = stringResource(R.string.app_name),
                style = MaterialTheme.typography.headlineMedium,
            )
            Text(
                text = stringResource(R.string.placeholder_tagline),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            // US-1302: exercise the brand chrome so theme regressions surface
            // in the shell (and in the preview) immediately.
            Column(Modifier.padding(top = Spacing.lg).cardStyle()) {
                Text("9.4", style = brandScore(40), color = MaterialTheme.colorScheme.primary)
                Text("Sample score card", style = MaterialTheme.typography.bodySmall)
            }
            BrandPrimaryButton(
                text = "Primary action",
                modifier = Modifier.padding(top = Spacing.md),
            ) {}
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun PlaceholderShellPreview() {
    GradeThreadTheme {
        PlaceholderShell()
    }
}
