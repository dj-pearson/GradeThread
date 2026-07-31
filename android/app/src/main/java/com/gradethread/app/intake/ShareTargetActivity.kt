package com.gradethread.app.intake

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import coil.compose.AsyncImage
import com.gradethread.app.capture.PhotoProcessor
import com.gradethread.app.capture.PhotoSlotType
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.ui.theme.GradeThreadTheme
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import javax.inject.Inject

/**
 * US-1382: "Share to GradeThread".
 *
 * Its own Activity, not a route inside the shell, because the system hands a
 * share to a component and expects it back promptly. It stages the photos and
 * finishes; the app itself picks them up on next foreground ([IntakeDrainer]).
 *
 * Deliberately does NOT require sign-in. Someone photographing a rail at a
 * thrift store and sharing before they remember their password should not lose
 * the photos — the batch waits on disk, and the drain runs whenever they do
 * get in.
 */
@AndroidEntryPoint
class ShareTargetActivity : ComponentActivity() {

    @Inject
    lateinit var db: GradeThreadDb

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val uris = ShareIntent.incomingUris(intent)
        if (uris.isEmpty()) {
            // Nothing usable — say so rather than showing an empty screen the
            // seller has to work out for themselves.
            Telemetry.breadcrumb("share target received no images", "intake")
            finish()
            return
        }

        setContent {
            GradeThreadTheme {
                ShareScreen(
                    uris = uris,
                    onCancel = { finish() },
                    onSave = { assignments -> save(uris, assignments) },
                )
            }
        }
    }

    private fun save(uris: List<Uri>, assignments: List<PhotoSlotType>) {
        lifecycleScope.launch {
            val id = IntakeInboxStore.newBatchId()
            val dir = IntakeInboxStore.batchDirectory(this@ShareTargetActivity, id)
            val entries = stage(uris, assignments, dir)

            if (entries.isEmpty()) {
                // Every photo failed to decode. Leaving an empty batch behind
                // would make the next foreground announce "nothing was added"
                // with no idea why.
                dir.deleteRecursively()
                Telemetry.event("intake_share_failed", mapOf("count" to uris.size))
            } else {
                IntakeInboxStore.write(db, id, entries, System.currentTimeMillis())
                Telemetry.event("intake_share_staged", mapOf("count" to entries.size))
            }
            finish()
        }
    }

    /**
     * Copy, process, and record each photo.
     *
     * Through the SAME [PhotoProcessor] pipeline a camera capture takes —
     * downsize, orientation baked in, metadata destroyed. A shared photo
     * carries GPS from wherever it was taken, which is usually someone's home.
     */
    private suspend fun stage(
        uris: List<Uri>,
        assignments: List<PhotoSlotType>,
        dir: File,
    ): List<IntakeInbox.PhotoEntry> = withContext(Dispatchers.IO) {
        val staging = File(cacheDir, "share-staging").apply { mkdirs() }
        uris.take(IntakeInbox.MAX_PHOTOS).mapIndexedNotNull { index, uri ->
            // Per-photo isolation: one unreadable share never sinks the batch.
            runCatching {
                val staged = File(staging, "share_${index}_${System.nanoTime()}.jpg")
                contentResolver.openInputStream(uri)?.use { input ->
                    staged.outputStream().use { input.copyTo(it) }
                } ?: error("unreadable share uri")

                val processed = PhotoProcessor.process(staged, dir)
                staged.delete()
                IntakeInbox.PhotoEntry(
                    path = processed.file.absolutePath,
                    slot = assignments.getOrElse(index) { PhotoSlotType.DETAIL }.wire,
                    bytes = processed.file.length(),
                )
            }.getOrNull()
        }
    }
}

@Composable
private fun ShareScreen(
    uris: List<Uri>,
    onCancel: () -> Unit,
    onSave: (List<PhotoSlotType>) -> Unit,
) {
    val capped = remember(uris) { uris.take(IntakeInbox.MAX_PHOTOS) }
    var assignments by remember(capped) {
        mutableStateOf(IntakeInbox.defaultSlots(capped.size))
    }
    var saving by remember { mutableStateOf(false) }

    Scaffold { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(16.dp)) {
            Text("Add to GradeThread", style = MaterialTheme.typography.headlineSmall)
            Text(
                if (uris.size > capped.size) {
                    "Using the first ${capped.size} of ${uris.size} photos."
                } else {
                    "Pick which shot goes where. You can change any of it later."
                },
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            LazyColumn(
                Modifier.weight(1f).fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(capped.size) { index ->
                    SlotRow(
                        uri = capped[index],
                        slot = assignments.getOrElse(index) { PhotoSlotType.DETAIL },
                        onSlot = { picked ->
                            assignments = assignments.toMutableList().also {
                                while (it.size <= index) it.add(PhotoSlotType.DETAIL)
                                it[index] = picked
                            }
                        },
                    )
                }
            }

            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onCancel, enabled = !saving) { Text("Cancel") }
                Button(
                    onClick = {
                        saving = true
                        onSave(assignments)
                    },
                    enabled = !saving,
                ) {
                    Text(if (saving) "Saving…" else "Save")
                }
            }
        }
    }
}

@Composable
private fun SlotRow(uri: Uri, slot: PhotoSlotType, onSlot: (PhotoSlotType) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Row(verticalAlignment = Alignment.CenterVertically) {
        AsyncImage(
            model = uri,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.size(64.dp),
        )
        Column(Modifier.weight(1f).padding(start = 12.dp)) {
            TextButton(onClick = { open = true }) { Text(slot.label) }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                // The four that shape a grade first, then everything a seller
                // might reasonably have shot before opening the app.
                (PhotoSlotType.defaultSlots + PhotoSlotType.extras).distinct().forEach { option ->
                    DropdownMenuItem(
                        text = { Text(option.label) },
                        onClick = {
                            onSlot(option)
                            open = false
                        },
                    )
                }
            }
        }
    }
}
