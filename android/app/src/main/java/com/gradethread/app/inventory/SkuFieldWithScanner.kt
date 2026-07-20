package com.gradethread.app.inventory

import android.content.pm.PackageManager
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.gradethread.app.capture.BarcodeScanScreen
import com.gradethread.app.ui.components.ValidatedTextField

/**
 * US-1332: the SKU field with scan-to-fill.
 *
 * The scan affordance is hidden on a device with no camera at all, rather
 * than opening a scanner that can only show an error.
 */
@Composable
fun SkuFieldWithScanner(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val hasCamera = remember {
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)
    }
    var scanning by remember { mutableStateOf(false) }

    Row(
        modifier = modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ValidatedTextField(
            value = value,
            onValueChange = onValueChange,
            label = "SKU",
            modifier = Modifier.weight(1f),
        )
        if (hasCamera) {
            IconButton(
                onClick = { scanning = true },
                modifier = Modifier.semantics { contentDescription = "Scan barcode to fill SKU" },
            ) {
                Icon(
                    // Core icon set has no barcode/scan glyph; Search reads as
                    // "find this for me". Adding material-icons-extended for
                    // one glyph isn't worth the dependency today.
                    imageVector = Icons.Outlined.Search,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                )
            }
        }
    }

    if (scanning) {
        Dialog(
            onDismissRequest = { scanning = false },
            // Full-screen: a viewfinder in a padded dialog card is unusable.
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            BarcodeScanScreen(
                onScanned = onValueChange,
                onDismiss = { scanning = false },
            )
        }
    }
}
