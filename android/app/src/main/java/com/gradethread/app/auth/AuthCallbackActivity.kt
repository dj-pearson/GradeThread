package com.gradethread.app.auth

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import com.gradethread.app.MainActivity
import com.gradethread.app.platform.telemetry.Telemetry
import dagger.hilt.android.AndroidEntryPoint
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1311: the OAuth return point. Receives the App Link
 * (https://gradethread.com/app/auth-callback) or custom-scheme callback,
 * validates it against the [OAuthCallback] allowlist, completes the PKCE
 * exchange exactly once (the [OAuthCallback.CompletionGuard] absorbs browser
 * re-deliveries and onCreate/onNewIntent races — AC4), then returns to the
 * shell. An invalid or duplicate callback finishes silently: no crash, no
 * double session (the auth-state Flow drives whatever the outcome was).
 *
 * launchMode=singleTask in the manifest so a mid-flow re-entry reuses this
 * instance via onNewIntent instead of stacking activities.
 */
@AndroidEntryPoint
class AuthCallbackActivity : ComponentActivity() {

    @Inject
    lateinit var client: SupabaseClient

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent?) {
        val code = OAuthCallback.parseCode(intent?.data)
        if (code == null || !guard.tryConsume(code)) {
            // Not ours / already handled — never crash, never double-complete.
            returnToShell()
            return
        }
        lifecycleScope.launch {
            try {
                client.auth.exchangeCodeForSession(code)
            } catch (t: Throwable) {
                // The auth-state Flow stays signed-out; the login screen shows
                // the friendly error on the next attempt. Breadcrumb only.
                Telemetry.breadcrumb(
                    "oauth exchange failed: ${t.message ?: t.javaClass.simpleName}",
                    category = "auth",
                )
            }
            returnToShell()
        }
    }

    private fun returnToShell() {
        startActivity(
            Intent(this, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            },
        )
        finish()
    }

    private companion object {
        // Process-wide: survives activity recreation during one app session.
        val guard = OAuthCallback.CompletionGuard()
    }
}
