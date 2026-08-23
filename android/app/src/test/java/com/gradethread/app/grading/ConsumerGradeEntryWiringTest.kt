package com.gradethread.app.grading

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-2815: can a person actually REACH consumer grading on Android?
 *
 * Everything under the screen — contract, uploader, payment model, flow — is
 * unit-tested and would keep passing with nothing on screen at all. That is the
 * failure this whole story is about, and it is the one a behaviour suite cannot
 * see. check-android-orphans.mjs catches an unreferenced declaration; these
 * catch the subtler versions, where the wiring exists but is wrong.
 */
class ConsumerGradeEntryWiringTest {

    private fun source(path: String) = File("src/main/java/com/gradethread/app/$path").readText()

    @Test
    fun theToolsHubOffersIt() {
        val tools = source("ui/shell/ToolsScreen.kt")
        assertTrue("no callback for the entry", tools.contains("onGradeAGarment"))
        assertTrue(
            "the row is not rendered",
            tools.contains("R.string.tools_grade_a_garment)"),
        )
    }

    @Test
    fun theShellRoutesToTheScreen() {
        val shell = source("ui/shell/AppShell.kt")
        assertTrue(
            "the tools callback goes nowhere",
            shell.contains("onGradeAGarment = { navController.navigate(ShellRoutes.CONSUMER_GRADE) }"),
        )
        assertTrue(
            "no destination renders the screen",
            shell.contains("ConsumerGradeScreen("),
        )
        assertTrue(
            "the route constant is missing",
            source("ui/shell/Sections.kt").contains("const val CONSUMER_GRADE"),
        )
    }

    @Test
    fun theScreenDrivesTheSharedFlow() {
        // Not its own copy of the journey. The flow is where every not-a-failure
        // state is decided, and a screen with its own logic would drift from it.
        val screen = source("grading/ConsumerGradeScreen.kt")
        assertTrue(screen.contains("viewModel.flow.step.collectAsState()"))
        assertTrue(screen.contains("ConsumerGradeFlow.Step.NeedsPhotos"))
        assertTrue(screen.contains("ConsumerGradeFlow.Step.NeedsCredits"))
    }

    @Test
    fun theNoChargeStatesSaySoOnScreen() {
        // The flow decides that needs_photos and needsCredits are not failures.
        // The screen has to SAY it — that sentence is the whole difference
        // between a refusal and an apparent wasted purchase.
        val screen = source("grading/ConsumerGradeScreen.kt")
        assertTrue(
            "the reassurance is not rendered anywhere",
            screen.contains("You have not been charged."),
        )
        assertTrue(
            "the post-purchase gap has a bare spinner again",
            screen.contains("Purchase received"),
        )
    }

    @Test
    fun photosGoThroughTheProcessor_notARawRead() {
        // PhotoImport.importPicked stages the file and runs the processor, which
        // BAKES the EXIF orientation into the pixels. The grading pipeline
        // ignores that flag, so reading the Uri directly ships sideways photos
        // to the one consumer known to mishandle them.
        val vm = source("grading/ConsumerGradeViewModel.kt")
        assertTrue(vm.contains("PhotoImport.importPicked("))
        assertTrue(
            "the Uri is read directly, skipping the processor",
            !vm.contains("contentResolver.openInputStream"),
        )
    }

    @Test
    fun theSubmittedOrderFollowsTheContract_notMapOrder() {
        // images[i] pairs with image_types[i] on the route. Iterating a Map
        // would hand the server whatever order the hash produced, and a back
        // shot graded as a tag is a wrong grade rather than an error.
        val vm = source("grading/ConsumerGradeViewModel.kt")
        assertTrue(
            "submission order no longer comes from the contract",
            vm.contains("PhotoGradeContract.requiredGradingTypes.mapNotNull"),
        )
    }

    @Test
    fun defaultsComeFromTheValidatedVocabulary() {
        // grade.ts rejects an off-vocab garment_category AFTER the upload, so a
        // hardcoded default here is a 400 waiting for the first user who does
        // not change the picker.
        val vm = source("grading/ConsumerGradeViewModel.kt")
        assertTrue(vm.contains("AiItemFields.garmentTypes.first()"))
        assertTrue(vm.contains("AiItemFields.garmentCategories.first()"))
    }
}
