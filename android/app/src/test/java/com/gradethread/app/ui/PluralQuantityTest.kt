package com.gradethread.app.ui

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.gradethread.app.R
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.Locale

/**
 * US-2977 AC5: a count of exactly ONE renders the singular, in both locales.
 *
 * WHY ONE IS THE VALUE THAT MATTERS. The bug this story fixes is not visible at
 * any other count — "5 items selected" was always correct. It is one that read
 * "1 items selected", and one is also the value a smoke test skips, because
 * whoever is clicking around has three things on screen.
 *
 * ⚠ AND SPANISH IS THE HALF THAT WOULD BE MISSED. Several of the converted
 * strings read IDENTICALLY at one and other in English — "%d noted", "%d bought
 * here", "%d won't be submitted" — and differ in Spanish, where the participle
 * agrees in number. A reviewer checking only the English diff sees nothing
 * change there, so the es assertions are not symmetry for its own sake; they are
 * the only place that half of the fix is visible.
 *
 * Robolectric renders the real resource tables, so this exercises the actual
 * plural selection rather than a model of it.
 */
@RunWith(RobolectricTestRunner::class)
class PluralQuantityTest {

    private fun res(locale: Locale) = ApplicationProvider.getApplicationContext<Context>()
        .createConfigurationContext(
            android.content.res.Configuration(
                ApplicationProvider.getApplicationContext<Context>().resources.configuration,
            ).apply { setLocale(locale) },
        )
        .resources

    private val en = Locale.ENGLISH
    private val es = Locale.forLanguageTag("es")

    @Test
    fun englishSingularDropsTheS() {
        val r = res(en)
        assertEquals("1 item selected", r.getQuantityString(R.plurals.bulk_selected_count, 1, 1))
        assertEquals("3 items selected", r.getQuantityString(R.plurals.bulk_selected_count, 3, 3))

        assertEquals("1 photo", r.getQuantityString(R.plurals.autolister_group_size, 1, 1))
        assertEquals("2 photos", r.getQuantityString(R.plurals.autolister_group_size, 2, 2))

        assertEquals("Create 1 item?", r.getQuantityString(R.plurals.reconciliation_create_title, 1, 1))
        assertEquals("Create 4 items?", r.getQuantityString(R.plurals.reconciliation_create_title, 4, 4))
    }

    @Test
    fun theStringThatWasAlreadyApologisingNoLongerSaysPhotoTypeS() {
        // capture_slots_need_update read "%d photo type(s) ... add them from a
        // browser". The "(s)" is what a developer writes when they know the
        // string is wrong and cannot fix it inside a <string>.
        val one = res(en).getQuantityString(R.plurals.capture_slots_need_update, 1, 1)
        assertEquals(true, one.contains("1 photo type "))
        assertEquals(false, one.contains("(s)"))
        assertEquals(true, one.contains("add it from a browser"))
    }

    @Test
    fun spanishAgreesInNumberWhereEnglishDoesNot() {
        val r = res(es)
        // English is "%d noted" at every count; Spanish is not.
        assertEquals("1 anotado", r.getQuantityString(R.plurals.disclosure_noted, 1, 1))
        assertEquals("2 anotados", r.getQuantityString(R.plurals.disclosure_noted, 2, 2))

        assertEquals("1 comprado aquí", r.getQuantityString(R.plurals.radar_off_map_items, 1, 1))
        assertEquals("5 comprados aquí", r.getQuantityString(R.plurals.radar_off_map_items, 5, 5))

        assertEquals(
            "1 seleccionado",
            r.getQuantityString(R.plurals.bulk_selected, 1, 1),
        )
        assertEquals(
            "6 seleccionados",
            r.getQuantityString(R.plurals.bulk_selected, 6, 6),
        )
    }

    @Test
    fun spanishSingularIsUsedForTheOrdinaryPlurals() {
        val r = res(es)
        assertEquals("1 foto", r.getQuantityString(R.plurals.autolister_group_size, 1, 1))
        assertEquals("3 fotos", r.getQuantityString(R.plurals.autolister_group_size, 3, 3))
        assertEquals(
            "Escaneada hace 1 día",
            r.getQuantityString(R.plurals.radar_fresh_days, 1, 1),
        )
        assertEquals(
            "Escaneada hace 9 días",
            r.getQuantityString(R.plurals.radar_fresh_days, 9, 9),
        )
    }

    @Test
    fun zeroTakesTheOtherFormInBothLocales() {
        // Neither English nor Spanish has a `zero` category, so zero must fall to
        // `other`. Worth pinning: a translator adding a zero form to one locale
        // and not the other is a silent divergence.
        assertEquals("0 photos", res(en).getQuantityString(R.plurals.autolister_group_size, 0, 0))
        assertEquals("0 fotos", res(es).getQuantityString(R.plurals.autolister_group_size, 0, 0))
    }
}
