package com.gradethread.app.measure

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.capture.GarmentGroup
import com.gradethread.app.inventory.ItemPhotoRepository
import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.ItemPhotoEntity
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1576: the measurement overlay editor.
 *
 * Mirrors the iOS `MeasurementPhotoEditorView` flow: calibrate on open, draw
 * the stored lines, let the seller drag them, optionally ask the model to
 * propose a full set, then save.
 *
 * **The lines are the source of truth for the numbers, not the other way
 * round.** Every inch value is recomputed from the endpoints through the
 * calibration homography whenever they move, so a value can never disagree with
 * the line a seller is looking at.
 */
@HiltViewModel
class MeasurementEditorViewModel @Inject constructor(
    private val db: GradeThreadDb,
    private val service: MeasureService,
    private val photos: ItemPhotoRepository,
) : ViewModel() {

    /** What the editor is waiting on, so one spinner can say which. */
    enum class Busy { CALIBRATING, EXTRACTING, SAVING }

    data class State(
        val itemId: String? = null,
        val loading: Boolean = true,
        val busy: Busy? = null,
        val photo: ItemPhotoEntity? = null,
        val calibration: MeasureCalibrationResult? = null,
        val lines: List<MeasureGeometry.Line> = emptyList(),
        /** The model's last proposals, keyed by measurement — drives the flags. */
        val proposals: Map<String, ProposedMeasurement> = emptyMap(),
        /** Keys the seller has moved. A touched line stops reading as a flag. */
        val touched: Set<String> = emptySet(),
        /** The server's own remediation sentence when the card can't be read. */
        val quality: MeasureQualityFailure? = null,
        val errorMessage: String? = null,
        /** Set once a save has landed, so the sheet can close on the result. */
        val saved: Boolean = false,
    ) {
        /** No measurement photo on this item — the editor cannot open at all. */
        val hasPhoto: Boolean get() = photo != null

        val homography: List<Double> get() = calibration?.value?.homography.orEmpty()

        val isCalibrated: Boolean get() = calibration?.value?.isUsable == true

        /** ORIGINAL image pixels — the coordinate space every endpoint is in. */
        val imageWidth: Double get() = (photo?.width ?: 0).toDouble()
        val imageHeight: Double get() = (photo?.height ?: 0).toDouble()

        /**
         * Whether the image dimensions are usable.
         *
         * Without them every endpoint maps to the same display point and the
         * whole overlay collapses onto the top-left corner, so the editor says
         * so rather than drawing something the seller would try to drag.
         */
        val hasImageSize: Boolean get() = imageWidth > 0 && imageHeight > 0

        val values: Map<String, Double>
            get() = if (isCalibrated) MeasureLines.values(lines, homography) else emptyMap()

        /** A flagged line the seller hasn't corrected yet — drawn amber. */
        fun isFlagged(key: String): Boolean =
            proposals[key]?.flagged == true && key !in touched
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /** The garment class reported with corrections, for per-class accuracy stats. */
    private var garmentClass: String = GarmentGroup.GENERIC.wire

    fun bind(itemId: String) {
        if (_state.value.itemId == itemId) return
        _state.value = State(itemId = itemId)
        viewModelScope.launch {
            val item = db.items().byId(itemId)
            garmentClass = GarmentGroup.from(item?.garmentType ?: item?.garmentCategory).wire

            // The LATEST measurement shot, matching iOS: a seller who retakes
            // the card photo means the new one, and the old row often still
            // carries a calibration that would quietly win.
            val photo = db.photos().forItem(itemId)
                .lastOrNull { it.photoType == MEASUREMENT_TYPE }
            _state.value = _state.value.copy(loading = false, photo = photo)
            if (photo != null) calibrate(force = false)
        }
    }

    /**
     * Calibrate the photo.
     *
     * @param force what the quality banner's "Try again" sends — recompute
     *   instead of serving the cached failure, which is the only thing that can
     *   help after a retake.
     */
    fun calibrate(force: Boolean) {
        val photoId = _state.value.photo?.id ?: return
        if (_state.value.busy != null) return
        _state.value = _state.value.copy(busy = Busy.CALIBRATING, quality = null, errorMessage = null)
        viewModelScope.launch {
            runCatching { service.calibrate(photoId, force) }
                .onSuccess { result ->
                    _state.value = _state.value.copy(
                        busy = null,
                        calibration = result,
                        // Re-seeded from the server's document rather than
                        // merged with what is on screen: a forced recalibration
                        // produces a NEW homography, and lines positioned
                        // against the old one would silently change length.
                        lines = MeasureLines.seed(result.value),
                        touched = emptySet(),
                    )
                }
                .onFailure { report(it) }
        }
    }

    /** One billed AI action: ask the model to place every applicable line. */
    fun autoMeasure() {
        val photoId = _state.value.photo?.id ?: return
        if (_state.value.busy != null || !_state.value.isCalibrated) return
        _state.value = _state.value.copy(busy = Busy.EXTRACTING, errorMessage = null)
        viewModelScope.launch {
            runCatching { service.extract(photoId) }
                .onFailure { report(it) }
                .onSuccess { result ->
                    // The endpoints live on the calibration document, which the
                    // extract just rewrote — so the lines come from a re-read,
                    // not from the response. One source for where a line is.
                    val refreshed = runCatching { service.calibrate(photoId, force = false) }.getOrNull()
                    _state.value = _state.value.copy(
                        busy = null,
                        proposals = result.measurements.associateBy { it.key },
                        calibration = refreshed ?: _state.value.calibration,
                        lines = refreshed?.value?.let { MeasureLines.seed(it) } ?: _state.value.lines,
                        // A fresh proposal is the model's opinion again, so
                        // nothing is "corrected" until the seller moves it.
                        touched = emptySet(),
                    )
                }
        }
    }

    fun moveEndpoint(index: Int, end: MeasureGeometry.End, to: MeasureGeometry.Point) {
        val current = _state.value
        val key = current.lines.getOrNull(index)?.key ?: return
        _state.value = current.copy(
            lines = MeasureLines.moved(
                current.lines, index, end, to, current.imageWidth, current.imageHeight,
            ),
            touched = current.touched + key,
        )
    }

    fun addLine(key: String) {
        val current = _state.value
        _state.value = current.copy(
            lines = MeasureLines.withAdded(current.lines, key, current.imageWidth, current.imageHeight),
            // A line the seller placed is theirs from the first frame — it has
            // no proposal behind it, so it must never draw as a model flag.
            touched = current.touched + key,
        )
    }

    fun removeLine(key: String) {
        _state.value = _state.value.copy(lines = MeasureLines.withRemoved(_state.value.lines, key))
    }

    fun dismissError() {
        _state.value = _state.value.copy(errorMessage = null, quality = null)
    }

    /**
     * Persist the lines and hand the values back to the canvas.
     *
     * [onApply] runs even if the WRITE fails, and that is deliberate: the
     * numbers are already correct and already on screen, and the canvas save
     * will carry them. Throwing away a measurement the seller just took because
     * the line-geometry write missed would cost them the work twice.
     */
    fun save(onApply: (Map<String, Double>) -> Unit) {
        val current = _state.value
        val photoId = current.photo?.id ?: return
        val itemId = current.itemId ?: return
        if (current.busy != null || !current.isCalibrated) return

        val homography = current.homography
        val values = MeasureLines.values(current.lines, homography)
        _state.value = current.copy(busy = Busy.SAVING, errorMessage = null)

        viewModelScope.launch {
            val result = photos.saveMeasureLines(
                photoId = photoId,
                stored = current.calibration!!.stored,
                lines = MeasureLines.storedDocument(current.lines, homography),
            )
            onApply(values)

            // Both are best-effort by design and by the server's own handling:
            // corrections feed an accuracy dataset and the overlay is a listing
            // picture. Neither is worth failing a save the seller can see.
            service.recordCorrections(
                garmentClass,
                MeasureLines.corrections(current.lines, current.proposals, current.touched, homography),
            )
            service.regenerateOverlay(itemId)

            _state.value = _state.value.copy(
                busy = null,
                saved = true,
                errorMessage = result.exceptionOrNull()?.let { message(it) },
            )
        }
    }

    private fun report(error: Throwable) {
        _state.value = when (error) {
            is MeasureQualityFailure -> _state.value.copy(busy = null, quality = error)
            else -> _state.value.copy(busy = null, errorMessage = message(error))
        }
    }

    private fun message(error: Throwable): String =
        (error as? EdgeApiError)?.userMessage()
            ?: error.message
            ?: "Couldn't measure from that photo."

    private companion object {
        const val MEASUREMENT_TYPE = "measurement"
    }
}
