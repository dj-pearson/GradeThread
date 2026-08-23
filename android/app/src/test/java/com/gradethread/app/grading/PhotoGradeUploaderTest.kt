package com.gradethread.app.grading

import com.gradethread.app.platform.net.EdgeApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-2815: the body shape and the refusals, without a network.
 *
 * `body()` is internal precisely so this can read it. The alternative — asserting
 * on a built MultipartBody — would test OkHttp rather than the decision that
 * matters here, which is the ORDER the parts go in.
 */
class PhotoGradeUploaderTest {

    private fun image(type: String) = PhotoGradeImage(type, byteArrayOf(0xFF.toByte()))

    private fun request() = PhotoGradeRequest(
        garmentType = "tops",
        garmentCategory = "t-shirt",
        title = "Levis tee",
    )

    private val complete = listOf(image("front"), image("back"), image("label"))

    // ── the positional pairing ───────────────────────────────────────────

    @Test
    fun eachImageIsImmediatelyFollowedByItsOwnType() {
        // THE PROPERTY THAT MATTERS. The route zips images[i] with
        // image_types[i], so the two arrays are positional. Appending all the
        // files and then all the types would still produce a valid body and a
        // WRONG GRADE: a back shot read as a tag charges the customer and
        // returns a confidently wrong certificate. Nothing errors.
        val parts = PhotoGradeUploader.body(complete, request())
        val fileIndexes = parts.indices.filter {
            parts[it] is EdgeApi.Part.File
        }
        assertEquals(3, fileIndexes.size)
        fileIndexes.forEach { i ->
            val file = parts[i] as EdgeApi.Part.File
            val next = parts.getOrNull(i + 1)
            assertTrue(
                "part after ${file.fileName} is not its image_types field",
                next is EdgeApi.Part.Field && next.name == "image_types",
            )
            assertEquals(
                "image_types does not match the image beside it",
                file.fileName.substringBeforeLast("-"),
                (next as EdgeApi.Part.Field).value,
            )
        }
    }

    @Test
    fun theTypesArriveInTheSameOrderAsTheImages() {
        val parts = PhotoGradeUploader.body(complete, request())
        val types = parts.filterIsInstance<EdgeApi.Part.Field>()
            .filter { it.name == "image_types" }
            .map { it.value }
        assertEquals(listOf("front", "back", "label"), types)
    }

    @Test
    fun everyImageGoesUnderTheFieldNameTheRouteReads() {
        val files = PhotoGradeUploader.body(complete, request()).filterIsInstance<EdgeApi.Part.File>()
        assertTrue(files.isNotEmpty())
        assertTrue("the route reads getAll(\"images\")", files.all { it.name == "images" })
    }

    // ── the fields ───────────────────────────────────────────────────────

    @Test
    fun optInsAreSentExplicitlyFalseRatherThanOmitted() {
        // The server re-checks either way, but leaving a request's meaning to a
        // default lets that default change without this client knowing.
        val fields = PhotoGradeFields.fields(request()).toMap()
        assertEquals("false", fields["verified_capture_opt_in"])
        assertEquals("false", fields["authenticity_addon"])
    }

    @Test
    fun emptyOptionalsAreOmittedEntirely() {
        // Sending brand="" is not the same as sending no brand: one is a value.
        val fields = PhotoGradeFields.fields(request().copy(brand = "")).toMap()
        assertTrue("an empty brand was sent as a value", "brand" !in fields)
    }

    @Test
    fun suppliedOptionalsAreIncluded() {
        val fields = PhotoGradeFields.fields(
            request().copy(brand = "Levis", closetItemId = "closet-1"),
        ).toMap()
        assertEquals("Levis", fields["brand"])
        assertEquals("closet-1", fields["closet_item_id"])
    }

    // ── refusing before the upload ───────────────────────────────────────

    @Test
    fun aCompleteSetIsAccepted() {
        assertNull(PhotoGradeUploader.validate(complete))
    }

    @Test
    fun aMissingRequiredShotIsNamedInTheSELLERsWords() {
        // `label` is the route's word; the capture strip says `tag`. An error
        // that says label sends someone looking for a control that does not
        // exist.
        val error = PhotoGradeUploader.validate(listOf(image("front"), image("back")))
        assertTrue(error is PhotoGradeError.MissingRequired)
        assertTrue(
            "the message uses the route's vocabulary: ${error?.message}",
            error?.message?.contains("tag") == true,
        )
        assertTrue(error?.message?.contains("label") == false)
    }

    @Test
    fun anEmptySetIsRefusedBeforeAnythingIsSent() {
        assertTrue(PhotoGradeUploader.validate(emptyList()) is PhotoGradeError.NoImages)
    }

    @Test
    fun overTheCapIsRefusedWithTheRealNumber() {
        val many = (1..PhotoGradeContract.MAX_IMAGES + 1).map { image("front") }
        val error = PhotoGradeUploader.validate(many)
        assertTrue(error is PhotoGradeError.TooManyImages)
        assertTrue(
            "the cap in the message is not the contract's",
            error?.message?.contains("${PhotoGradeContract.MAX_IMAGES}") == true,
        )
    }
}
