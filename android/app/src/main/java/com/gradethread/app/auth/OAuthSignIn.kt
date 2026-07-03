package com.gradethread.app.auth

import android.content.Context
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import com.gradethread.app.platform.AppConfig
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.auth.providers.Apple
import io.github.jan.supabase.auth.providers.Google
import io.github.jan.supabase.auth.providers.OAuthProvider

/**
 * US-1311: web-OAuth sign-in through Chrome Custom Tabs. Google is gated by
 * [AppConfig.googleSignInEnabled] (compile-time, mirroring iOS — off until
 * the provider is configured on the self-hosted GoTrue); Apple-on-Android is
 * the same web-OAuth flow (no native Apple SDK on Android).
 *
 * The consent URL carries the App Link redirect
 * (https://gradethread.com/app/auth-callback) so the return lands in
 * [AuthCallbackActivity] and completes the PKCE exchange there.
 *
 * Custom Tabs isolate the app from the page (no cookie/JS access for us) —
 * androidx.browser's ephemeral-browsing mode is still experimental, so it's
 * deliberately not enabled yet ("where possible" per the AC); revisit when it
 * stabilizes.
 */
object OAuthSignIn {

    const val REDIRECT_URL = "https://gradethread.com/app/auth-callback"

    enum class Provider(internal val sdk: OAuthProvider) {
        GOOGLE(Google),
        APPLE(Apple),
    }

    /** Whether the provider's entry point should render at all. */
    fun isAvailable(provider: Provider): Boolean = when (provider) {
        Provider.GOOGLE -> AppConfig.googleSignInEnabled
        Provider.APPLE -> true
    }

    /** Launch the provider consent page in a Custom Tab. */
    suspend fun launch(context: Context, client: SupabaseClient, provider: Provider) {
        require(isAvailable(provider)) { "${provider.name} sign-in is not enabled" }
        val url = client.auth.getOAuthUrl(provider.sdk, redirectUrl = REDIRECT_URL)
        CustomTabsIntent.Builder()
            .setShowTitle(true)
            .build()
            .launchUrl(context, Uri.parse(url))
    }
}
