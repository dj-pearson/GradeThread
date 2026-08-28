package com.gradethread.app.auth

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-2792: can a provider sign-in actually be STARTED?
 *
 * US-1311 built OAuthSignIn.launch() over Chrome Custom Tabs and wired the
 * return leg properly — AuthCallbackActivity is a manifest App Link that
 * completes the PKCE exchange. Nothing ever called launch(), so half a feature
 * shipped, and the half that shipped is the half nobody looks at.
 *
 * Wiring assertions, deliberately: whether launch() WORKS is a question for a
 * device, but whether anything calls it is a question this can answer, and it
 * is the one that was wrong for a year.
 */
class ProviderSignInWiringTest {

    private fun source(path: String) = File("src/main/java/com/gradethread/app/$path").readText()

    @Test
    fun theScreenOffersTheProviders() {
        val screen = source("auth/AuthScreen.kt")
        assertTrue("nothing renders provider buttons", screen.contains("ProviderSignIn("))
        assertTrue(
            "the buttons no longer reach the ViewModel",
            screen.contains("viewModel.signInWithProvider(context, it)"),
        )
    }

    @Test
    fun theChainReachesLaunch() {
        // Screen -> ViewModel -> Repository -> OAuthSignIn.launch. Any link
        // missing puts the app back where it started: a button that does
        // nothing, or a function nothing calls.
        assertTrue(
            "the ViewModel does not start the flow",
            source("auth/AuthViewModel.kt").contains("auth.startOAuth(context, provider)"),
        )
        assertTrue(
            "the repository never calls launch",
            source("auth/AuthRepository.kt").contains("OAuthSignIn.launch(context, client, provider)"),
        )
    }

    /**
     * The launch has to go through the repository's `run` wrapper.
     *
     * `AuthViewModel.signInWithProvider` calls this from a bare
     * `viewModelScope.launch` and its own comment promises that failures
     * "surface through the same lastError collector as email sign-in". Called
     * outside `run` they cannot: the throw reaches the coroutine's uncaught
     * handler and takes the process down instead. Two real throws sit behind
     * that call - `CustomTabsIntent.launchUrl` raises
     * ActivityNotFoundException on a phone with no browser, and `launch`'s own
     * `require(isAvailable(provider))` raises IllegalArgumentException.
     *
     * A source assertion, like the rest of this class, and with the same
     * limits: it proves the call is wrapped, not that the wrapper catches.
     * Proving the catch needs a fake SupabaseClient and an Android Context,
     * neither of which this JVM lane has.
     */
    @Test
    fun theLaunchGoesThroughTheErrorWrapper() {
        assertTrue(
            "startOAuth calls launch outside run { } - a browserless phone crashes the app",
            source("auth/AuthRepository.kt")
                .contains("run { OAuthSignIn.launch(context, client, provider) }"),
        )
    }

    @Test
    fun theButtonsAreFilteredByIsAvailable() {
        // isAvailable's own doc says "whether the provider's entry point should
        // render at all", and launch() has a require() on it — so rendering an
        // unavailable provider produces a button that throws when pressed.
        // Google is off until the provider is configured on the self-hosted
        // GoTrue; Apple is available today.
        val screen = source("auth/AuthScreen.kt")
        assertTrue(
            "providers are no longer filtered — an unavailable one would throw on press",
            screen.contains("filter(OAuthSignIn::isAvailable)"),
        )
        assertTrue(
            "no providers available renders an empty gap instead of nothing",
            screen.contains("if (available.isEmpty()) return"),
        )
    }

    @Test
    fun googleStaysGatedAndAppleDoesNot() {
        // Pins the CURRENT gate rather than asserting a preference. If Google is
        // switched on later this fails, and that is correct — it should be a
        // deliberate edit, not a silent one, because turning it on without the
        // provider configured ships a button that always errors.
        val oauth = source("auth/OAuthSignIn.kt")
        assertTrue(
            "Google is no longer gated on the compile-time flag",
            oauth.contains("Provider.GOOGLE -> AppConfig.googleSignInEnabled"),
        )
        assertTrue("Apple is no longer available", oauth.contains("Provider.APPLE -> true"))
        assertTrue(
            "the compile-time flag flipped without this test being updated",
            source("platform/AppConfig.kt").contains("const val googleSignInEnabled: Boolean = false"),
        )
    }
}
