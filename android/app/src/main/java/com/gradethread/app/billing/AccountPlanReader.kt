package com.gradethread.app.billing

import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.postgrest.from
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import javax.inject.Inject
import javax.inject.Singleton

@Serializable
private data class PlanRow(
    @SerialName("flipdesk_plan") val plan: String? = null,
    @SerialName("subscription_status") val status: String? = null,
)

/**
 * US-1367: what the SERVER says this account pays for.
 *
 * Not what Play says. Play knows what was bought on this device; the account may
 * be paying through Stripe on the web or through the App Store, and both the
 * paywall and the post-signup step would otherwise offer someone a plan they
 * already have — which Play will sell them, for real money.
 *
 * Read under the SIGNED-IN user, never the active workspace: a plan belongs to
 * the person paying for it, and reading it under a workspace owner's id would
 * show a member their host's plan.
 */
@Singleton
class AccountPlanReader @Inject constructor(
    private val client: SupabaseClient,
) {

    /** Null when free, unknown, or unreadable — never a guess. */
    suspend fun current(): PlanTier? {
        val userId = client.auth.currentUserOrNull()?.id ?: return null
        val row = runCatching {
            client.from("users").select {
                filter { eq("id", userId) }
                limit(1)
            }.decodeList<PlanRow>().firstOrNull()
        }
            // Silent on failure: the paywall still renders. The cost is an
            // unmarked current plan, which is a missing badge rather than a
            // broken screen.
            .getOrNull() ?: return null
        // A cancelled or past-due subscription is not a current plan — offering
        // it back is exactly what someone in that state came here to do.
        if (row.status != "active") return null
        return PlanTier.fromSlug(row.plan)
    }

    fun signedInUserId(): String? = client.auth.currentUserOrNull()?.id
}
