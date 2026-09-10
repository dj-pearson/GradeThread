package com.gradethread.app.money

import android.content.Context
import android.net.Uri
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.sync.OfflineMutationQueue
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.testing.MainDispatcherRule
import io.github.jan.supabase.createSupabaseClient
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * US-3119: the receipt photo is read on the dispatcher the test is driving.
 *
 * ⚠ WHAT THIS FILE IS REALLY GUARDING. `ReceiptScanViewModel.scan()` read the
 * picked photo under `withContext(Dispatchers.IO)`. That pool is not on the
 * test scheduler, so `advanceUntilIdle()` returned while the read was still in
 * flight and the assertions after it saw `State(scanning = true)` and nothing
 * else. A test written that way passes or fails for reasons unconnected to the
 * code it names, which is how four of ProspectRolesTest's cases sat red on main
 * for months in US-3027 accusing correct code.
 *
 * The dispatcher is now a constructor argument and these cases hand it the one
 * `MainDispatcherRule` drives.
 *
 * ⚠ THE TWO REFUSAL CASES NEVER REACH THE NETWORK, ON PURPOSE, and each
 * asserts `server.requestCount == 0` as part of the point: refusing a photo the
 * server was always going to reject saves the seller a slow upload.
 *
 * ⚠ AND NO CASE HERE ASSERTS ON THE STATE A SUCCESSFUL SCAN PRODUCES.
 * `EdgeApi.postMultipartImage` does its own `withContext(Dispatchers.IO)`, so
 * the upload is off the test scheduler whatever this ViewModel does and
 * `advanceUntilIdle()` cannot wait for it. The control case therefore asserts
 * on the REQUEST, which MockWebServer hands over on the real clock. That is the
 * same defect one layer down; it belongs to EdgeApi, not here.
 *
 * Each case was watched to fail (US-3119 AC2): the production line it covers
 * was mutated and the test went red before it was restored.
 */
@RunWith(RobolectricTestRunner::class)
class ReceiptScanViewModelTest {

    @get:Rule
    val mainDispatcher = MainDispatcherRule()

    @get:Rule
    val folder = TemporaryFolder()

    private val context = ApplicationProvider.getApplicationContext<Context>()

    private lateinit var server: MockWebServer
    private lateinit var db: GradeThreadDb

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        db = Room.inMemoryDatabaseBuilder(context, GradeThreadDb::class.java)
            .allowMainThreadQueries()
            .build()
        // Enqueued but not expected. A mutation that lets a refused photo
        // through gets a clean red on requestCount instead of hanging on a
        // server with nothing to say.
        server.enqueue(
            MockResponse().setResponseCode(200)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"staging_path":"staged/1.jpg"}"""),
        )
    }

    @After
    fun tearDown() {
        db.close()
        server.shutdown()
    }

    private fun viewModel(): ReceiptScanViewModel {
        val edge = EdgeApi(
            baseUrl = server.url("/").toString().removeSuffix("/"),
            client = OkHttpClient(),
            tokenProvider = { "tk_1" },
            tokenRefresher = { null },
            sleeper = { /* no real sleeping in tests */ },
        )
        val supabase = createSupabaseClient(supabaseUrl = "https://example.test", supabaseKey = "test-key") {}
        return ReceiptScanViewModel(
            scans = ReceiptScanService(edge),
            expenses = ExpenseRepository(supabase, db, OfflineMutationQueue(db)),
            context = context,
            io = mainDispatcher.dispatcher,
        )
    }

    private fun photo(name: String, bytes: Int): Uri =
        Uri.fromFile(folder.newFile(name).apply { writeBytes(ByteArray(bytes) { 0x41 }) })

    @Test
    fun `a photo that cannot be opened is reported rather than uploaded`() = runTest(mainDispatcher.dispatcher) {
        val vm = viewModel()

        vm.scan(Uri.fromFile(File(folder.root, "never-written.jpg")))
        advanceUntilIdle()

        assertEquals("Couldn't open that photo.", vm.state.value.notice)
        // scanning=false is half the assertion: this is the state the
        // ViewModel is left in when the read fails, and it is exactly what
        // an off-scheduler read could never reach in time.
        assertFalse(vm.state.value.scanning)
        assertNull(vm.state.value.draft)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `a photo over the server cap is refused before the upload`() = runTest(mainDispatcher.dispatcher) {
        val vm = viewModel()

        vm.scan(photo("huge.jpg", ReceiptScanViewModel.MAX_BYTES + 1))
        advanceUntilIdle()

        assertTrue(
            "oversize photo did not name the cap: ${vm.state.value.notice}",
            vm.state.value.notice.orEmpty().contains("over 10MB"),
        )
        assertFalse(vm.state.value.scanning)
        // THE POINT of the branch. Sending it anyway would spend a slow
        // cellular upload to be told what was already known on the phone.
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `an ordinary photo gets past both early branches and onto the wire`() = runTest(mainDispatcher.dispatcher) {
        // The control. Without it the two cases above would still pass if
        // `readBytes` returned null for everything, or if the size
        // comparison were inverted - both of which refuse every receipt.
        val vm = viewModel()

        vm.scan(photo("receipt.jpg", 4_096))
        advanceUntilIdle()

        assertFalse(
            "an ordinary photo was refused: ${vm.state.value.notice}",
            vm.state.value.notice.orEmpty().let {
                it.contains("over 10MB") || it.contains("Couldn't open")
            },
        )
        // Waited for on the REAL clock, not the scheduler: the upload
        // itself is inside EdgeApi's own withContext(Dispatchers.IO), so
        // advanceUntilIdle() has nothing to say about it. Asserting on the
        // request rather than on the resulting state is what keeps this
        // case honest instead of racing.
        val request = server.takeRequest(10, TimeUnit.SECONDS)
        assertNotNull("no request reached the server", request)
        assertEquals(ReceiptScanService.EXTRACT_PATH, request?.path)
    }

    @Test
    fun `a scan already in flight refuses a second photo`() = runTest(mainDispatcher.dispatcher) {
        val vm = viewModel()

        // Not advanced between the two: the first scan is still suspended,
        // so the second must be dropped rather than replacing its state.
        vm.scan(photo("huge.jpg", ReceiptScanViewModel.MAX_BYTES + 1))
        vm.scan(Uri.fromFile(File(folder.root, "never-written.jpg")))
        advanceUntilIdle()

        assertTrue(
            "the second scan replaced the first: ${vm.state.value.notice}",
            vm.state.value.notice.orEmpty().contains("over 10MB"),
        )
    }
}
