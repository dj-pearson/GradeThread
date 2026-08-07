package com.gradethread.app.platform.locale

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1393: the language-override rules.
 *
 * The expensive failure here is offering a language the app has no strings
 * for: the picker changes nothing, looks broken, and — if it were ever
 * applied — leaves someone in an app they cannot read well enough to change
 * back.
 */
class AppLocaleTest {

    @Test
    fun `every offered language is a real one`() {
        AppLocale.SUPPORTED.forEach {
            assertTrue(it.tag, it.tag.isNotBlank())
            assertTrue(it.englishName, it.englishName.isNotBlank())
            assertTrue(it.nativeName, it.nativeName.isNotBlank())
        }
        // Tags are unique — two entries for one tag would put a duplicate row
        // in the picker.
        assertEquals(AppLocale.SUPPORTED.size, AppLocale.SUPPORTED.map { it.tag }.toSet().size)
    }

    @Test
    fun `follow-the-phone is always allowed`() {
        assertTrue(AppLocale.isSupported(AppLocale.SYSTEM_TAG))
    }

    @Test
    fun `a language we do not ship is refused`() {
        // A build that drops a translation leaves the old tag set; without this
        // the app renders default strings while the picker names a language it
        // is not in.
        assertFalse(AppLocale.isSupported("xx"))
        assertTrue(AppLocale.isSupported("en"))
    }

    @Test
    fun `the system option is labelled, not left blank`() {
        assertEquals("Match my phone", AppLocale.label(AppLocale.SYSTEM_TAG))
        assertEquals("English", AppLocale.label("en"))
    }

    @Test
    fun `an unknown tag falls back to showing the tag itself`() {
        // Better than an empty row: it at least says which language is set.
        assertEquals("xx", AppLocale.label("xx"))
    }

    @Test
    fun `the picker hides itself while there is nothing to choose`() {
        assertEquals(AppLocale.SUPPORTED.size > 1, AppLocale.hasChoice)
    }

    @Test
    fun `Spanish is offered and the picker is visible`() {
        // US-2368 shipped values-es, which is what turns the picker on. If this
        // fails because the translation was dropped, locales_config.xml and
        // SUPPORTED have to come out with it — android/scripts/check-string-formats.py
        // fails the build when those three stop agreeing.
        assertTrue(AppLocale.isSupported("es"))
        assertEquals("Español", AppLocale.label("es"))
        assertTrue(AppLocale.hasChoice)
    }
}
