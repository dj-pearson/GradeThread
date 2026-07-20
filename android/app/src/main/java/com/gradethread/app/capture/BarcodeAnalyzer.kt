package com.gradethread.app.capture

import android.annotation.SuppressLint
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage

/**
 * US-1332: the ML Kit barcode analyzer behind scan-to-SKU (iOS
 * `BarcodeScanner`, which uses Vision `VNDetectBarcodesRequest`).
 *
 * Owns the ML Kit client and closes it in [close]; the caller must call that
 * or the detector leaks its native resources.
 */
class BarcodeAnalyzer(
    private val dedup: BarcodeDedup = BarcodeDedup(),
    private val clock: () -> Long = { System.currentTimeMillis() },
    private val onDetected: (String) -> Unit,
) : ImageAnalysis.Analyzer, AutoCloseable {

    private val scanner: BarcodeScanner = BarcodeScanning.getClient(
        BarcodeScannerOptions.Builder()
            .setBarcodeFormats(
                BarcodeFormats.enabled.first(),
                *BarcodeFormats.enabled.drop(1).toIntArray(),
            )
            .build(),
    )

    @Volatile
    private var closed = false

    /**
     * `@SuppressLint("UnsafeOptInUsageError")`: `ImageProxy.image` is
     * `@ExperimentalGetImage`. It is the documented way to hand a CameraX
     * frame to ML Kit and is what every first-party sample does.
     */
    @SuppressLint("UnsafeOptInUsageError")
    override fun analyze(imageProxy: ImageProxy) {
        val mediaImage = imageProxy.image
        if (mediaImage == null || closed) {
            // ALWAYS close the proxy, on every path. CameraX hands out a
            // bounded pool of frames and stalls forever once they're all
            // outstanding — a missed close here freezes the preview rather
            // than merely dropping a frame.
            imageProxy.close()
            return
        }
        val input = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
        scanner.process(input)
            .addOnSuccessListener { barcodes ->
                // First non-empty payload in the frame wins, matching the
                // iOS `break` after the first observation. Two barcodes in
                // one frame is ambiguous; picking one beats emitting both.
                val code = barcodes.asSequence()
                    .mapNotNull { it.rawValue }
                    .firstOrNull { it.isNotEmpty() }
                    ?: return@addOnSuccessListener
                if (dedup.shouldEmit(code, clock())) onDetected(code)
            }
            // A frame that fails to decode is normal (blur, no barcode); it
            // must not tear down the scan session.
            .addOnCompleteListener { imageProxy.close() }
    }

    override fun close() {
        closed = true
        scanner.close()
    }
}

/** Typed scanner failures (iOS `BarcodeError`). */
sealed class BarcodeError(val message: String) {

    object PermissionDenied : BarcodeError(
        "Camera access is off. Enable it in Settings to scan barcodes.",
    )

    object NoCamera : BarcodeError("No back camera available on this device.")

    object ConfigurationFailed : BarcodeError("Couldn't start the scanner.")

    /** Only permission failures are Settings-recoverable (the iOS US-1201 split). */
    val isSettingsRecoverable: Boolean get() = this is PermissionDenied
}
