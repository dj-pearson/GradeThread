package com.gradethread.app.importer

import android.content.Context
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import com.gradethread.app.testing.MainDispatcherRule
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

/**
 * US-3119: the CSV file read happens on the dispatcher the test is driving.
 *
 * ⚠ WHY THIS FILE EXISTS AT ALL. `ImportViewModel.load()` read the picked file
 * under `withContext(Dispatchers.IO)`, which is a real background pool that no
 * test scheduler is on. `advanceUntilIdle()` advances the TEST scheduler, so it
 * would have returned while the read was still in flight and every assertion
 * below would have run against a ViewModel in its opening state - passing or
 * failing for reasons that have nothing to do with the import. US-3027 paid a
 * session to learn that on ProspectViewModel, where it presented as four red
 * tests describing a bug that was not in the code they named.
 *
 * So the dispatcher is a constructor argument and these tests hand it the one
 * `MainDispatcherRule` is already driving. That is the whole reason
 * `advanceUntilIdle()` means anything here.
 *
 * Each case was watched to fail (US-3119 AC2): the production line it covers
 * was mutated and the test went red before it was restored.
 */
@RunWith(RobolectricTestRunner::class)
class ImportViewModelTest {

    @get:Rule
    val mainDispatcher = MainDispatcherRule()

    @get:Rule
    val folder = TemporaryFolder()

    private val context = ApplicationProvider.getApplicationContext<Context>()

    /** Records what a commit was asked to do; the load path never reaches it. */
    private class RecordingCommitter : ImportCommitting {
        var committed: List<ImportDraft>? = null

        override suspend fun existingSkus(): Set<String> = emptySet()

        override suspend fun commit(drafts: List<ImportDraft>): CommitResult {
            committed = drafts
            return CommitResult()
        }
    }

    private class StubSheets(private val csv: String = "") : SheetsImporting {
        var fetched: String? = null

        override suspend fun fetchCsv(url: String): String {
            fetched = url
            return csv
        }
    }

    private fun viewModel(service: ImportCommitting = RecordingCommitter(), sheets: SheetsImporting = StubSheets()) =
        ImportViewModel(context, service, sheets, mainDispatcher.dispatcher)

    private fun csvFile(name: String, body: String): Uri = Uri.fromFile(folder.newFile(name).apply { writeText(body) })

    private val twoRows = "sku,title,brand\nA1,Vintage Tee,Nike\nA2,Denim Jacket,Levi's\n"

    @Test
    fun `the picked file has been read by the time advanceUntilIdle returns`() = runTest(mainDispatcher.dispatcher) {
        val vm = viewModel()

        vm.load(csvFile("inventory.csv", twoRows))
        advanceUntilIdle()

        // Every one of these is false in the opening state, which is what
        // the assertions would have seen if the read were off-scheduler.
        assertEquals(ImportViewModel.Step.MAP, vm.state.value.step)
        assertEquals(listOf("sku", "title", "brand"), vm.state.value.sheet?.headers)
        assertEquals(2, vm.state.value.sheet?.rows?.size)
        assertFalse(vm.state.value.busy)
        assertNull(vm.state.value.error)
    }

    @Test
    fun `the columns are guessed from the headers that were read`() = runTest(mainDispatcher.dispatcher) {
        val vm = viewModel()

        vm.load(csvFile("inventory.csv", twoRows))
        advanceUntilIdle()

        assertEquals(
            listOf(ImportField.SKU, ImportField.TITLE, ImportField.BRAND),
            vm.state.value.mapping,
        )
    }

    @Test
    fun `a file that cannot be opened says so instead of sitting busy`() = runTest(mainDispatcher.dispatcher) {
        val vm = viewModel()

        vm.load(Uri.fromFile(File(folder.root, "never-written.csv")))
        advanceUntilIdle()

        // busy=false matters as much as the sentence: a spinner that never
        // stops is the failure a seller actually reports.
        assertFalse(vm.state.value.busy)
        assertEquals(ImportViewModel.Step.PICK, vm.state.value.step)
        assertTrue(
            "unreadable file did not name CSV as the fix: ${vm.state.value.error}",
            vm.state.value.error.orEmpty().contains("Export it again as CSV"),
        )
    }

    @Test
    fun `a header-only export is named as its own mistake`() = runTest(mainDispatcher.dispatcher) {
        // Deliberately not the same sentence as an unreadable file. It is a
        // different mistake with a different fix, and telling a seller to
        // re-export a file that exported fine sends them round a loop.
        val vm = viewModel()

        vm.load(csvFile("headers-only.csv", "sku,title,brand\n"))
        advanceUntilIdle()

        assertEquals("That file has no rows under its header.", vm.state.value.error)
        assertEquals(ImportViewModel.Step.PICK, vm.state.value.step)
        assertNull(vm.state.value.sheet)
    }

    @Test
    fun `the sheet path lands in the same parser as the file path`() = runTest(mainDispatcher.dispatcher) {
        // US-2410's promise: two front doors, one importer. Asserted by
        // driving the sheet door and checking it arrives at the state the
        // file door produces.
        val sheets = StubSheets(twoRows)
        val vm = viewModel(sheets = sheets)
        vm.setSheetUrl("https://docs.google.com/spreadsheets/d/1AbC/edit")

        vm.loadFromSheet()
        advanceUntilIdle()

        assertEquals("https://docs.google.com/spreadsheets/d/1AbC/edit", sheets.fetched)
        assertEquals(ImportViewModel.Step.MAP, vm.state.value.step)
        assertEquals(listOf("sku", "title", "brand"), vm.state.value.sheet?.headers)
    }

    @Test
    fun `a commit sends the planned rows and reports the outcome`() = runTest(mainDispatcher.dispatcher) {
        val service = RecordingCommitter()
        val vm = viewModel(service = service)

        vm.load(csvFile("inventory.csv", twoRows))
        advanceUntilIdle()
        vm.preview()
        advanceUntilIdle()
        vm.commit()
        advanceUntilIdle()

        assertEquals(listOf("Vintage Tee", "Denim Jacket"), service.committed?.map { it.title })
        assertEquals(ImportViewModel.Step.DONE, vm.state.value.step)
        assertNotNull(vm.state.value.outcome)
    }
}
