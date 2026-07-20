package com.gradethread.app.capture

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.gradethread.app.sync.db.CaptureDraftEntity
import com.gradethread.app.sync.db.GradeThreadDb
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * US-1330: autosave survives a process kill, an empty form is not persisted,
 * and the details draft coexists with the photo-capture draft in the shared
 * `capture_drafts` table.
 */
@RunWith(RobolectricTestRunner::class)
class DetailsDraftStoreTest {

    private lateinit var db: GradeThreadDb

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext<Context>(),
            GradeThreadDb::class.java,
        ).allowMainThreadQueries().build()
    }

    @After
    fun tearDown() = db.close()

    private val filled = DetailsIntakeState(
        title = "Vintage Tee",
        sku = "A1",
        brand = "Nike",
        purchasePriceText = "12.50",
        notes = "small stain",
    )

    @Test
    fun aDraftSurvivesAProcessKill() = runTest {
        DetailsDraftStore.save(db, filled)

        // A cold start reads the same rows back — the "recover after kill" AC.
        val recovered = DetailsDraftStore.load(db)

        assertNotNull(recovered)
        assertEquals("Vintage Tee", recovered!!.title)
        assertEquals("A1", recovered.sku)
        assertEquals("12.50", recovered.purchasePriceText)
        assertEquals("small stain", recovered.notes)
    }

    @Test
    fun anEmptyFormIsDeletedRatherThanSaved() = runTest {
        DetailsDraftStore.save(db, filled)
        assertNotNull(DetailsDraftStore.load(db))

        // The user cleared every field — don't prompt to resume nothing.
        DetailsDraftStore.save(db, DetailsIntakeState())

        assertNull(DetailsDraftStore.load(db))
        assertNull(db.captureDrafts().byId(DetailsDraftStore.DRAFT_ID))
    }

    @Test
    fun savingTwice_updatesInPlace_ratherThanAccumulating() = runTest {
        DetailsDraftStore.save(db, filled)
        DetailsDraftStore.save(db, filled.copy(title = "Updated"))

        assertEquals("Updated", DetailsDraftStore.load(db)?.title)
    }

    @Test
    fun clearRemovesTheDraft() = runTest {
        DetailsDraftStore.save(db, filled)
        DetailsDraftStore.clear(db)
        assertNull(DetailsDraftStore.load(db))
    }

    @Test
    fun theDetailsDraftDoesNotCollideWithTheCaptureDraft() = runTest {
        // Both live in capture_drafts; distinct ids keep them independent —
        // this is what lets US-1330 skip a Room migration entirely.
        db.captureDrafts().upsert(
            CaptureDraftEntity(
                id = PhotoIntakeStore.DRAFT_ID,
                stateJson = """{"captures":[]}""",
                updatedAt = 1L,
            ),
        )
        DetailsDraftStore.save(db, filled)

        assertNotNull(db.captureDrafts().byId(PhotoIntakeStore.DRAFT_ID))
        assertEquals("Vintage Tee", DetailsDraftStore.load(db)?.title)

        // Clearing one must not touch the other.
        DetailsDraftStore.clear(db)
        assertNotNull(db.captureDrafts().byId(PhotoIntakeStore.DRAFT_ID))
    }

    @Test
    fun aCorruptDraftYieldsNull_ratherThanCrashLoopingTheScreen() = runTest {
        db.captureDrafts().upsert(
            CaptureDraftEntity(
                id = DetailsDraftStore.DRAFT_ID,
                stateJson = "{ this is not json",
                updatedAt = 1L,
            ),
        )

        // A lost draft is an annoyance; a crash on every open is not.
        assertNull(DetailsDraftStore.load(db))
    }

    @Test
    fun unknownFieldsFromANewerBuildStillDecode() = runTest {
        db.captureDrafts().upsert(
            CaptureDraftEntity(
                id = DetailsDraftStore.DRAFT_ID,
                stateJson = """{"title":"Tee","futureField":"whatever"}""",
                updatedAt = 1L,
            ),
        )

        assertEquals("Tee", DetailsDraftStore.load(db)?.title)
    }
}
