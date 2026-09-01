package com.gradethread.app.scout

import com.gradethread.app.inventory.CategorySuggestion
import com.gradethread.app.testing.MainDispatcherRule
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * US-3027: Android sends the photo ROLES, so a scan can reach visual search.
 *
 * ⚠ THE ROLE IS THE WHOLE GATE. The edge decides who identifies a prospect from
 * `imageRoles` alone (US-2759), and an absent or unrecognised role is
 * deliberately NOT permission - it takes the no-usable-role branch. Android sent
 * no roles at all, so every Android scan read the tag and could never reach eBay
 * visual search however good a garment shot the seller took.
 *
 * ⚠ AND POSITION IS NOT THE ROLE. Deriving "photo 0 is the front" from the list
 * order is the tempting shortcut and the wrong one: a seller who photographs
 * only the care label would have it labelled `front`, and US-2758 measured a
 * care label returning a midi dress, joggers and a mini skirt with no expressed
 * doubt. So the pairing is tested where it is most likely to come apart - when
 * one of the two photos will not read off disk.
 */
class ProspectRolesTest {

    @get:Rule
    val mainDispatcher = MainDispatcherRule()

    @get:Rule
    val folder = TemporaryFolder()

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    /** Captures what the ViewModel actually put on the wire. */
    private class RecordingScout : ScoutScanning {
        var sent: List<ProspectPhotoBytes>? = null
        var costCents: Int? = null

        override suspend fun suggestCategory(query: String): CategorySuggestion? = null

        override suspend fun scan(
            categoryId: String,
            q: String?,
            brand: String?,
            limit: Int,
        ): ScoutScanResponse = ScoutScanResponse()

        override suspend fun prospect(
            photos: List<ProspectPhotoBytes>,
            costCents: Int?,
        ): ProspectResponse {
            sent = photos
            this.costCents = costCents
            return ProspectResponse(identified = true)
        }

        override suspend fun buy(request: ProspectBuyRequest): ProspectBuyResponse =
            ProspectBuyResponse(id = "i1", status = "sourced")
    }

    private fun photoFile(name: String): File =
        folder.newFile(name).apply { writeBytes(byteArrayOf(0xFF.toByte(), 0xD8.toByte())) }

    // ── the roles themselves ─────────────────────────────────────────────

    @Test
    fun everyRoleIsOneTheEdgeCanIdentifyFrom() {
        // Read off the edge rather than restated here: a wire value that no
        // longer appears in IDENTIFYING_PHOTO_ROLES is silently the
        // no-usable-role branch again, with nothing on this side to notice.
        val source = File("../../services/edge-functions/src/lib/scout-identify.ts").readText()
        val declared = Regex("IDENTIFYING_PHOTO_ROLES[^\\[]*\\[(.*?)]", RegexOption.DOT_MATCHES_ALL)
            .find(source)
            ?.groupValues
            ?.get(1)
            .orEmpty()
        assertTrue("could not read IDENTIFYING_PHOTO_ROLES", declared.isNotBlank())

        ProspectPhotoRole.entries.forEach { role ->
            assertTrue(
                "${role.wire} is not a role the edge identifies from",
                declared.contains("\"${role.wire}\""),
            )
        }
    }

    @Test
    fun theTagRoleIsTheOneTheEdgeReadsAsTagPhotographed() {
        // prospect-identify.ts checks TAG_ROLES before anything else, so this
        // string decides whether a tag-only scan reads the tag or is treated as
        // a garment shot.
        val source = File("../../services/edge-functions/src/lib/prospect-identify.ts").readText()
        assertTrue(
            "TAG_ROLES no longer contains our tag wire value",
            Regex("TAG_ROLES[^\\[]*\\[(.*?)]", RegexOption.DOT_MATCHES_ALL)
                .find(source)
                ?.groupValues
                ?.get(1)
                .orEmpty()
                .contains("\"${ProspectPhotoRole.TAG.wire}\""),
        )
    }

    @Test
    fun theRequestCarriesRolesParallelToImages() {
        val body = json.encodeToString(
            ProspectRequest.serializer(),
            ProspectRequest(
                images = listOf("data:image/jpeg;base64,AA", "data:image/jpeg;base64,BB"),
                imageRoles = listOf("front", "tag"),
                costCents = 2_400,
            ),
        )
        assertTrue("imageRoles missing from the wire body", body.contains("\"imageRoles\""))
        assertTrue(body.contains("[\"front\",\"tag\"]"))
    }

    // ── the slots ────────────────────────────────────────────────────────

    @Test
    fun eachSlotHoldsOnePhotoAndReshootingReplacesIt() {
        val vm = ProspectViewModel(RecordingScout())
        val first = photoFile("front-1.jpg")
        val second = photoFile("front-2.jpg")

        vm.setPhoto(ProspectPhotoRole.FRONT, first)
        vm.setPhoto(ProspectPhotoRole.FRONT, second)

        assertEquals(1, vm.state.value.photos.size)
        assertEquals(second, vm.state.value.photoFor(ProspectPhotoRole.FRONT))
    }

    @Test
    fun theWireOrderIsRoleOrderWhicheverSlotWasFilledFirst() {
        val vm = ProspectViewModel(RecordingScout())
        vm.setPhoto(ProspectPhotoRole.TAG, photoFile("tag.jpg"))
        vm.setPhoto(ProspectPhotoRole.FRONT, photoFile("front.jpg"))

        assertEquals(
            listOf(ProspectPhotoRole.FRONT, ProspectPhotoRole.TAG),
            vm.state.value.photos.map { it.role },
        )
    }

    @Test
    fun removingASlotLeavesTheOtherAlone() {
        val vm = ProspectViewModel(RecordingScout())
        vm.setPhoto(ProspectPhotoRole.FRONT, photoFile("front.jpg"))
        vm.setPhoto(ProspectPhotoRole.TAG, photoFile("tag.jpg"))

        vm.removePhoto(ProspectPhotoRole.FRONT)

        assertNull(vm.state.value.photoFor(ProspectPhotoRole.FRONT))
        assertNotNull(vm.state.value.photoFor(ProspectPhotoRole.TAG))
    }

    // ── what reaches the edge ────────────────────────────────────────────

    @Test
    fun aTagOnlyScanSendsOnePhotoWhoseRoleIsTag() = runTest(mainDispatcher.dispatcher) {
        val service = RecordingScout()
        val vm = ProspectViewModel(service)
        vm.setPhoto(ProspectPhotoRole.TAG, photoFile("tag.jpg"))

        vm.run()
        advanceUntilIdle()

        assertEquals(listOf("tag"), service.sent?.map { it.role.wire })
    }

    @Test
    fun aGarmentOnlyScanSendsTheFrontRoleThatVisualSearchNeeds() =
        runTest(mainDispatcher.dispatcher) {
            // prospect-identify.ts checks TAG_ROLES first, so a front-only scan
            // is the one that reaches visual search - and therefore the one
            // that costs no AI action for identification (US-2760).
            val service = RecordingScout()
            val vm = ProspectViewModel(service)
            vm.setPhoto(ProspectPhotoRole.FRONT, photoFile("front.jpg"))

            vm.run()
            advanceUntilIdle()

            assertEquals(listOf("front"), service.sent?.map { it.role.wire })
        }

    @Test
    fun anUnreadablePhotoDropsItsRoleWithIt() = runTest(mainDispatcher.dispatcher) {
        // THE FAILURE THIS EXISTS FOR. Two lists - files and roles - filtered
        // independently would leave one image and the role list still starting
        // at "front", so the tag macro would be handed to visual search as a
        // garment shot. The pair is filtered as one object, so the surviving
        // photo keeps its own role.
        val service = RecordingScout()
        val vm = ProspectViewModel(service)
        vm.setPhoto(ProspectPhotoRole.FRONT, File(folder.root, "never-written.jpg"))
        vm.setPhoto(ProspectPhotoRole.TAG, photoFile("tag.jpg"))

        vm.run()
        advanceUntilIdle()

        assertEquals(listOf("tag"), service.sent?.map { it.role.wire })
    }

    @Test
    fun noPhotoReadableIsAnErrorRatherThanARolelessScan() = runTest(mainDispatcher.dispatcher) {
        val service = RecordingScout()
        val vm = ProspectViewModel(service)
        vm.setPhoto(ProspectPhotoRole.FRONT, File(folder.root, "never-written.jpg"))

        vm.run()
        advanceUntilIdle()

        // An empty images list with an empty imageRoles list is the
        // no-usable-role branch, which would spend the request to be told
        // nothing. It never leaves the phone.
        assertNull(service.sent)
        assertNotNull(vm.state.value.errorMessage)
    }

    // ── the guard ────────────────────────────────────────────────────────

    @Test
    fun theServiceBuildsBothListsFromTheSamePairs() {
        // Source-level, because the two lists coming apart is invisible in a
        // response: the edge answers, it just answers about the wrong picture.
        val source = File("src/main/java/com/gradethread/app/scout/ScoutService.kt").readText()
        val call = source.substringAfter("override suspend fun prospect(")
            .substringBefore("override suspend fun buy(")
        assertTrue(
            "images no longer maps from the paired photos",
            call.contains("images = photos.map"),
        )
        assertTrue(
            "imageRoles no longer maps from the paired photos",
            call.contains("imageRoles = photos.map"),
        )
    }

    @Test
    fun theCaptureScreenNeverInfersARoleFromPosition() {
        val source = File("src/main/java/com/gradethread/app/scout/ProspectScreen.kt").readText()
        // Every slot is rendered from the enum, and every action names its role.
        assertTrue(
            "the slots are no longer built from the roles",
            source.contains("ProspectPhotoRole.entries.forEach"),
        )
        assertTrue(
            "the capture actions no longer carry a role",
            source.contains("val takePhoto: (ProspectPhotoRole) -> Unit"),
        )
    }
}
