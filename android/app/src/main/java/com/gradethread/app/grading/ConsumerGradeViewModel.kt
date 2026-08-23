package com.gradethread.app.grading

import android.content.Context
import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.ai.AiItemFields
import com.gradethread.app.capture.PhotoImport
import com.gradethread.app.platform.net.EdgeApi
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.File
import javax.inject.Inject
import javax.inject.Named

/**
 * US-2815: what the consumer grade screen holds.
 *
 * The journey itself lives in [ConsumerGradeFlow], which is pure and fully
 * tested. This owns the parts that need Android: a picked Uri, a file on disk,
 * and the EdgeApi.
 */
@HiltViewModel
class ConsumerGradeViewModel @Inject constructor(
    @ApplicationContext private val context: Context,
    // @Named("shared") because there are two EdgeApi profiles and the other
    // one ("ai") carries the long AI timeouts. Grading submit/pay/status are
    // ordinary calls.
    @Named("shared") private val api: EdgeApi,
) : ViewModel() {

    data class Draft(
        val title: String = "",
        val garmentType: String = DEFAULT_TYPE,
        val garmentCategory: String = DEFAULT_CATEGORY,
        /** gradingType -> the compressed JPEG bytes. */
        val shots: Map<String, ByteArray> = emptyMap(),
        /**
         * US-2802: gradingType -> where that shot came from. Absent means
         * library, which is the fail-closed default.
         */
        val sources: Map<String, String> = emptyMap(),
        val loadFailed: Boolean = false,
    ) {
        val missing: List<String>
            get() = PhotoGradeContract.missingRequired(shots.keys)

        /** A blank title is the one field the route will not fill in for us. */
        val canSubmit: Boolean get() = missing.isEmpty() && title.isNotBlank()

        /** Every shot taken in the app. Shown, never chosen. */
        val isLiveCapture: Boolean
            get() = PhotoGradeContract.qualifiesForLiveCapture(
                PhotoGradeContract.requiredGradingTypes.map {
                    sources[it] ?: PhotoGradeContract.LIBRARY_CAPTURE_SOURCE
                },
            ) && missing.isEmpty()
    }

    private val uploader = PhotoGradeUploader(api)

    val flow = ConsumerGradeFlow(
        submit = { images, request, _ -> uploader.submit(images, request) },
        pay = { submissionId ->
            api.decode<PhotoGradePayment.Response>(
                api.postRaw(
                    PhotoGradePayment.path(submissionId),
                    """{"tier":"standard"}""",
                ),
            ).outcome()
        },
        status = { submissionId ->
            api.decode(api.getRaw(PhotoGradeStatus.path(submissionId)))
        },
        sleep = { delay(it) },
    )

    private val draftFlow = MutableStateFlow(Draft())
    val draft: StateFlow<Draft> = draftFlow.asStateFlow()

    fun setTitle(value: String) = draftFlow.update { it.copy(title = value, loadFailed = false) }
    fun setType(value: String) = draftFlow.update { it.copy(garmentType = value) }
    fun setCategory(value: String) = draftFlow.update { it.copy(garmentCategory = value) }

    /**
     * Import one pick into one named slot.
     *
     * Goes through [PhotoImport.importPicked] rather than reading the Uri
     * directly: that path stages the file, reads the capture date from the
     * SOURCE EXIF, and runs the standard processor, which BAKES THE ORIENTATION
     * into the pixels. The grading pipeline is one of the consumers that
     * ignores the EXIF rotation flag, so a raw read ships sideways photos to
     * the one place known to mishandle them.
     */
    /**
     * US-2802: a shot taken IN THE APP. The only path that may claim the
     * in-app source — everything else defaults to library.
     */
    fun addCameraShot(bytes: ByteArray, gradingType: String) {
        draftFlow.update {
            it.copy(
                shots = it.shots + (gradingType to bytes),
                sources = it.sources +
                    (gradingType to PhotoGradeContract.IN_APP_CAPTURE_SOURCE),
                loadFailed = false,
            )
        }
    }

    fun addShot(uri: Uri, gradingType: String) {
        viewModelScope.launch {
            val outputDir = File(context.filesDir, "consumer-grade")
            val result = PhotoImport.importPicked(context, listOf(uri), outputDir, limit = 1)
                .firstOrNull()
                ?.getOrNull()
            if (result == null) {
                draftFlow.update { it.copy(loadFailed = true) }
                return@launch
            }
            val bytes = runCatching { result.processed.file.readBytes() }.getOrNull()
            if (bytes == null || bytes.isEmpty()) {
                draftFlow.update { it.copy(loadFailed = true) }
                return@launch
            }
            draftFlow.update {
                it.copy(
                    shots = it.shots + (gradingType to bytes),
                    // A library pick REPLACES any in-app source for this slot:
                    // retaking from the library after a camera shot must not
                    // keep the live claim.
                    sources = it.sources +
                        (gradingType to PhotoGradeContract.LIBRARY_CAPTURE_SOURCE),
                    loadFailed = false,
                )
            }
        }
    }

    fun submit() {
        val current = draftFlow.value
        if (!current.canSubmit) return
        viewModelScope.launch {
            // Ordered by the contract rather than by map order, so the parts
            // arrive in the sequence the strip showed them.
            val images = PhotoGradeContract.requiredGradingTypes.mapNotNull { type ->
                current.shots[type]?.let {
                    PhotoGradeImage(
                        type,
                        it,
                        current.sources[type]
                            ?: PhotoGradeContract.LIBRARY_CAPTURE_SOURCE,
                    )
                }
            }
            flow.start(
                images,
                PhotoGradeRequest(
                    garmentType = current.garmentType,
                    garmentCategory = current.garmentCategory,
                    title = current.title.trim(),
                ),
            )
        }
    }

    fun creditsPurchased(submissionId: String) {
        viewModelScope.launch { flow.creditsPurchased(submissionId) }
    }

    private fun MutableStateFlow<Draft>.update(block: (Draft) -> Draft) {
        value = block(value)
    }

    companion object {
        /**
         * Defaults come from the vocabulary the ROUTE validates against, not
         * from a literal here: grade.ts rejects an off-vocab garment_category
         * AFTER the upload. AiItemFields is the same set, held to
         * src/lib/constants.ts by a parity test.
         */
        val DEFAULT_TYPE: String = AiItemFields.garmentTypes.first()
        val DEFAULT_CATEGORY: String = AiItemFields.garmentCategories.first()
    }
}
