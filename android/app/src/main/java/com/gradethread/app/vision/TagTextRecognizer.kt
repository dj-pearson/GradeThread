package com.gradethread.app.vision

import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.coroutines.resume

/**
 * US-1333: on-device OCR over a tag photo (iOS `TagTextRecognizer`, which
 * uses Vision `VNRecognizeTextRequest`).
 *
 * Fully offline — that is the point of the story. This is the fallback for
 * when the network extract is unavailable or came back missing fields, so it
 * must never itself need a network.
 */
class TagTextRecognizer(
    private val latin: TextRecognizer =
        TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS),
    private val japanese: TextRecognizer =
        TextRecognition.getClient(JapaneseTextRecognizerOptions.Builder().build()),
) : AutoCloseable {

    /**
     * Recognize the tag and return trimmed, non-empty lines.
     *
     * Both script models run and their lines are concatenated. ML Kit, unlike
     * Vision, takes ONE script per recognizer rather than a language list, so
     * multi-language means multiple passes. Latin first: it is the
     * overwhelmingly common case, and [SizeTagInference] scans lines in
     * order, so Latin evidence wins ties.
     */
    suspend fun recognizeLines(context: Context, uri: Uri): List<String> =
        withContext(Dispatchers.Default) {
            val image = runCatching { InputImage.fromFilePath(context, uri) }.getOrNull()
                ?: return@withContext emptyList()
            recognizeLines(image)
        }

    suspend fun recognizeLines(file: File): List<String> = withContext(Dispatchers.Default) {
        val bitmap = runCatching { BitmapFactory.decodeFile(file.absolutePath) }.getOrNull()
            ?: return@withContext emptyList()
        // Rotation 0: the capture pipeline already normalizes orientation
        // when it writes the file (see PhotoProcessor).
        recognizeLines(InputImage.fromBitmap(bitmap, 0))
    }

    private suspend fun recognizeLines(image: InputImage): List<String> =
        (process(latin, image) + process(japanese, image))
            .map { it.trim() }
            .filter { it.isNotEmpty() }

    /**
     * A failed pass yields no lines rather than throwing. One script model
     * failing (Japanese is the likely one) must not lose the other's result,
     * and OCR is a best-effort fallback — a crash here would be far worse
     * than an empty brand field.
     */
    private suspend fun process(recognizer: TextRecognizer, image: InputImage): List<String> =
        suspendCancellableCoroutine { continuation ->
            recognizer.process(image)
                .addOnSuccessListener { result ->
                    continuation.resume(result.textBlocks.flatMap { block -> block.lines.map { it.text } })
                }
                .addOnFailureListener { continuation.resume(emptyList()) }
        }

    override fun close() {
        latin.close()
        japanese.close()
    }
}
