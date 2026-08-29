package com.gradethread.app.upload

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * US-1328: bucket routing, path/id determinism, and both HTTP phases proven
 * against a live server — including the `{}` mint body (the iOS empty-body
 * 400) and the x-upsert idempotency header.
 */
class PhotoUploadTest {

    @get:Rule
    val temp = TemporaryFolder()

    // ── Routing (AC2) ──

    @Test
    fun privateTypes_routeToSubmissionImages_withEmptyPublicUrl() {
        for (type in listOf("tag", "tag_2", "certificate")) {
            val bucket = PhotoUpload.bucketFor(type)
            assertEquals(PhotoUpload.Bucket.SUBMISSION_IMAGES, bucket)
            // NEVER a public URL for grading-sensitive imagery.
            assertEquals("", PhotoUpload.publicUrlFor("https://api.x.com", bucket, "p"))
        }
    }

    @Test
    fun everythingElse_routesToThePublicItemPhotos() {
        for (type in listOf("front", "back", "detail", "defect", "flatlay", "serial")) {
            val bucket = PhotoUpload.bucketFor(type)
            assertEquals(PhotoUpload.Bucket.ITEM_PHOTOS, bucket)
        }
        assertEquals(
            "https://api.x.com/storage/v1/object/public/item-photos/u/i/front_1.jpg",
            PhotoUpload.publicUrlFor(
                "https://api.x.com",
                PhotoUpload.Bucket.ITEM_PHOTOS,
                "u/i/front_1.jpg",
            ),
        )
    }

    @Test
    fun uploadPath_lowercasesUuids_andCarriesTypeAndTimestamp() {
        assertEquals(
            "user-abc/item-def/front_1700000000000.jpg",
            PhotoUpload.uploadPath("USER-ABC", "Item-DEF", "front", 1_700_000_000_000),
        )
    }

    // ── Phase 1: mint (the {} body lesson) ──

    @Test
    fun mint_postsAnEmptyJsonObject_andAbsolutizesTheSignedUrl() = runTest {
        val server = MockWebServer()
        server.start()
        server.enqueue(
            MockResponse().setBody("""{"url":"/object/upload/sign/item-photos/u/i/f.jpg?token=abc"}"""),
        )
        val base = server.url("/").toString().trimEnd('/')

        val signed = PhotoUpload.mintSignedUploadUrl(
            OkHttpClient(),
            base,
            "jwt-token",
            PhotoUpload.Bucket.ITEM_PHOTOS,
            "u/i/f.jpg",
        )

        val recorded = server.takeRequest()
        assertEquals("POST", recorded.method)
        assertEquals(
            "/storage/v1/object/upload/sign/item-photos/u/i/f.jpg",
            recorded.path,
        )
        // THE iOS lesson: the body must be {}, not empty (Fastify 400s).
        assertEquals("{}", recorded.body.readUtf8())
        assertEquals("Bearer jwt-token", recorded.getHeader("Authorization"))
        // Relative response absolutized against the storage root.
        assertEquals(
            "$base/storage/v1/object/upload/sign/item-photos/u/i/f.jpg?token=abc",
            signed,
        )
        server.shutdown()
    }

    // ── Phase 2: the single PUT ──

    @Test
    fun put_sendsTheBytesWithXUpsert() = runTest {
        val server = MockWebServer()
        server.start()
        server.enqueue(MockResponse().setResponseCode(200))
        val file = temp.newFile("photo.jpg").apply { writeBytes(ByteArray(64) { 7 }) }

        PhotoUpload.putBytes(OkHttpClient(), server.url("/signed?token=x").toString(), file)

        val recorded = server.takeRequest()
        assertEquals("PUT", recorded.method)
        // Idempotent replay: the same object overwrites, never errors (AC3).
        assertEquals("true", recorded.getHeader("x-upsert"))
        assertEquals(64, recorded.bodySize)
        server.shutdown()
    }

    @Test
    fun putFailure_throws_notSilentlyDequeues() = runTest {
        val server = MockWebServer()
        server.start()
        server.enqueue(MockResponse().setResponseCode(503))
        val file = temp.newFile("p.jpg").apply { writeBytes(ByteArray(8)) }

        val result = runCatching {
            PhotoUpload.putBytes(OkHttpClient(), server.url("/s").toString(), file)
        }
        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("503"))
        server.shutdown()
    }

    // ── Worker payload determinism ──

    @Test
    fun workRequest_lowercasesTheItemId_andCarriesEveryField() {
        val request = UploadWorker.request(
            UploadWorker.Input(
                stagedPath = "/data/p.jpg",
                itemId = "ITEM-ABC",
                serverType = "front",
                sortOrder = 2,
                capturedAt = 123L,
                width = 1024,
                height = 768,
            ),
        )
        val data = request.workSpec.input
        assertEquals("item-abc", data.getString(UploadWorker.KEY_ITEM_ID))
        assertEquals("front", data.getString(UploadWorker.KEY_SERVER_TYPE))
        assertEquals(2, data.getInt(UploadWorker.KEY_SORT_ORDER, -1))
        assertEquals(123L, data.getLong(UploadWorker.KEY_CAPTURED_AT, -1))
        assertEquals(1024, data.getInt(UploadWorker.KEY_WIDTH, -1))
        assertTrue(request.tags.contains("photo-upload"))
    }

    @Test
    fun mutationPayload_carriesTheDeterministicPhotoId() {
        val payload = UploadWorker.uploadPayload(
            "photo-1",
            "item-1",
            "front",
            null,
            "u/i/front_1.jpg",
            0,
            99L,
        ).decodeToString()
        assertTrue(payload.contains("\"photo_id\":\"photo-1\""))
        assertTrue(payload.contains("\"storage_path\":\"u/i/front_1.jpg\""))
        assertTrue(payload.contains("\"sort_order\":0"))
    }

    // ── US-2488: the role survives the offline queue ──

    @Test
    fun mutationPayload_carriesTheRoleWhenTheSlotHasOne() {
        val payload = UploadWorker.uploadPayload(
            "photo-1",
            "item-1",
            "tag",
            "size_alt",
            "u/i/tag_1.jpg",
            3,
            99L,
        ).decodeToString()
        assertTrue(payload.contains("\"photo_role\":\"size_alt\""))
    }

    @Test
    fun mutationPayload_omitsAnAbsentRoleRatherThanWritingBlank() {
        // A "" role is NOT the same slot as no role: the retag menu, the
        // grader and the listing adapters all look a role up, and an empty
        // string resolves to nothing while still counting as "qualified".
        for (role in listOf(null, "", "   ")) {
            val payload = UploadWorker.uploadPayload(
                "photo-1",
                "item-1",
                "front",
                role,
                "u/i/front_1.jpg",
                0,
                99L,
            ).decodeToString()
            assertTrue("role=$role leaked", !payload.contains("photo_role"))
        }
    }

    @Test
    fun workRequest_carriesTheRoleAndNormalizesBlankToNull() {
        fun roleOf(role: String?) = UploadWorker.request(
            UploadWorker.Input(
                stagedPath = "/data/p.jpg",
                itemId = "item-1",
                serverType = "tag",
                sortOrder = 0,
                capturedAt = 1L,
                photoRole = role,
            ),
        ).workSpec.input.getString(UploadWorker.KEY_PHOTO_ROLE)

        assertEquals("brand", roleOf("brand"))
        assertEquals(null, roleOf(""))
        assertEquals(null, roleOf(null))
    }
}
