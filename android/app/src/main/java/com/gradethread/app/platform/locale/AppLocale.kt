package com.gradethread.app.platform.locale

import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat

/**
 * US-1393: the in-app language override.
 *
 * Android 13+ has a per-app language picker in system settings; below that
 * there is nothing, and a seller with a Spanish phone who wants the app in
 * English has no way to say so. `AppCompatDelegate.setApplicationLocales` is
 * the one API that spans both, writing through to the system store on 13+ and
 * persisting itself below (see the `autoStoreLocales` service in the manifest).
 *
 * The list and the resolution rules are pure so they can be checked without a
 * device — a locale offered but not shipped is worse than one not offered,
 * because the picker changes nothing and looks broken.
 */
object AppLocale {

    /** A language this app actually ships strings for. */
    data class Option(val tag: String, val englishName: String, val nativeName: String)

    /**
     * Must stay in step with `res/xml/locales_config.xml` AND with the
     * `values-<tag>/` directories that exist. All three move together or the
     * picker offers a language nothing backs.
     */
    val SUPPORTED: List<Option> = listOf(
        Option("en", "English", "English"),
    )

    /** What "use my phone's language" is stored as. */
    const val SYSTEM_TAG = ""

    /**
     * The tag currently in force, or [SYSTEM_TAG] when following the device.
     *
     * Read back from AppCompat rather than from our own preference: on
     * Android 13+ the seller can change it in system settings without the app
     * ever running, so our copy would be stale the moment they did.
     */
    fun current(): String =
        AppCompatDelegate.getApplicationLocales().toLanguageTags().takeIf { it.isNotEmpty() }
            ?.substringBefore(',')
            ?: SYSTEM_TAG

    /**
     * Whether a stored tag is still offered.
     *
     * A build that drops a translation leaves the old tag set, and the app then
     * renders default strings while the picker shows a language it is not in.
     */
    fun isSupported(tag: String): Boolean =
        tag == SYSTEM_TAG || SUPPORTED.any { it.tag == tag }

    /** What the picker shows for a tag. */
    fun label(tag: String, systemLabel: String = "Match my phone"): String =
        if (tag == SYSTEM_TAG) {
            systemLabel
        } else {
            SUPPORTED.firstOrNull { it.tag == tag }?.nativeName ?: tag
        }

    /**
     * Apply a language.
     *
     * An unsupported tag falls back to the system rather than being set: the
     * alternative is an app stuck in a language it has no strings for, which
     * the seller then cannot read well enough to change back.
     */
    fun apply(tag: String) {
        val locales = if (isSupported(tag) && tag != SYSTEM_TAG) {
            LocaleListCompat.forLanguageTags(tag)
        } else {
            LocaleListCompat.getEmptyLocaleList()
        }
        AppCompatDelegate.setApplicationLocales(locales)
    }

    /**
     * Whether the picker is worth showing at all.
     *
     * With one shipped language there is nothing to choose, and a control whose
     * only option is the one you already have is noise.
     */
    val hasChoice: Boolean get() = SUPPORTED.size > 1
}
