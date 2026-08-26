package com.gradethread.app.platform.telemetry

/**
 * US-2897: which consent model applies to this seller.
 *
 * A PORT, not a new decision. `src/lib/consent-regime.ts` already made this
 * call for the web and it is the same company, the same PostHog project and the
 * same privacy policy — so the rules here mirror that file line for line, and a
 * change to either belongs in both.
 *
 * WHAT WAS ACTUALLY WRONG, because the story that prompted this got it
 * backwards. It claimed Android defaulted analytics ON while iOS asked first.
 * iOS does NOT ask first: `Telemetry.swift` reads
 * `UserDefaults…object(forKey:) ?? true`, and its own doc comment says
 * "Opt-out, on by default". Both mobile clients behaved identically. The real
 * gap was between MOBILE and WEB: the web is location-aware and both phones
 * were not, so an EU seller on a phone got a posture the web side had already
 * decided was not acceptable for them.
 *
 *  - opt-in  — GDPR / UK-GDPR / ePrivacy, and everywhere we are unsure.
 *              Nothing non-essential runs until the seller actively agrees.
 *  - opt-out — United States (CCPA/CPRA and the ~20 state laws). Analytics may
 *              run by default, with a visible way to turn it off.
 */
enum class ConsentRegime { OPT_IN, OPT_OUT }

/**
 * The coarse location signal the regime is chosen from.
 *
 * Deliberately coarse. Country and an EU flag are all the decision needs, so
 * they are all that is asked for — a finer fix would be more data held for no
 * additional purpose, which is the same reasoning behind Radar's
 * COARSE_LOCATION.
 */
data class GeoSignal(
    /** ISO 3166-1 alpha-2, uppercased, or null when unknown. */
    val country: String? = null,
    /** Subdivision where known (e.g. "CA"), else null. */
    val regionCode: String? = null,
    /** True when the country is inside the EU. */
    val isEU: Boolean = false,
) {
    companion object {
        /** Used whenever geo is unknown, which drives the strict default. */
        val UNKNOWN = GeoSignal()
    }
}

object Consent {

    /**
     * Countries whose law is opt-out (notice plus a right to opt out) rather
     * than prior opt-in. A set so adding another is a one-line change — the
     * same shape `consent-regime.ts` uses.
     */
    private val OPT_OUT_COUNTRIES = setOf("US")

    /**
     * The regime for a signal.
     *
     * FAILS SAFE. A null signal, or one with no country, resolves to OPT_IN —
     * that covers a VPN, Tor, an edge failure, and the window before the fetch
     * completes. Getting this backwards would mean analytics running by default
     * for exactly the sellers most likely to be covered by GDPR, so the strict
     * answer is the one that has to be the default rather than the fallback.
     */
    fun regimeFor(geo: GeoSignal?): ConsentRegime {
        val country = geo?.country?.takeIf { it.isNotBlank() } ?: return ConsentRegime.OPT_IN
        return if (country.uppercase() in OPT_OUT_COUNTRIES) ConsentRegime.OPT_OUT else ConsentRegime.OPT_IN
    }

    /**
     * Should analytics run, given the regime and whatever the seller has said?
     *
     * [explicitChoice] is TRI-STATE and that is the whole mechanism:
     *  - `true`  — they turned it on. Runs under either regime.
     *  - `false` — they turned it off. Never runs, under either regime. An
     *              opt-out jurisdiction does not override someone who has
     *              already said no.
     *  - `null`  — they have not been asked and have not touched the toggle.
     *              The regime decides, which is the case that used to be
     *              hard-coded to "on".
     */
    fun analyticsAllowed(regime: ConsentRegime, explicitChoice: Boolean?): Boolean =
        explicitChoice ?: (regime == ConsentRegime.OPT_OUT)
}
