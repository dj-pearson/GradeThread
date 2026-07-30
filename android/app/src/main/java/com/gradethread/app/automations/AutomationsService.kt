package com.gradethread.app.automations

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-1362: the automations API.
 *
 * The rules run on a server cron, so the client's only jobs are describing one
 * accurately and offering the dry run BEFORE it goes live.
 */
@Singleton
class AutomationsService @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
) {

    companion object {
        private const val BASE = "/api/flipdesk/automations"
        const val RULES_PATH = "$BASE/rules"
        const val RUN_PATH = "$BASE/run"

        fun rulePath(id: String) = "$RULES_PATH/$id"
        fun dryRunPath(id: String) = "${rulePath(id)}/dry-run"
        fun actionsPath(id: String) = "${rulePath(id)}/actions"
    }

    suspend fun rules(): List<AutomationRule> = edge.json.decodeFromString(
        AutomationRulesResponse.serializer(),
        edge.getRaw(RULES_PATH),
    ).rules

    suspend fun create(draft: AutomationDraft): AutomationRule? = edge.json.decodeFromString(
        AutomationRuleResponse.serializer(),
        edge.postRaw(RULES_PATH, body(draft)),
    ).rule

    suspend fun update(id: String, draft: AutomationDraft): AutomationRule? =
        edge.json.decodeFromString(
            AutomationRuleResponse.serializer(),
            edge.putRaw(rulePath(id), body(draft)),
        ).rule

    /**
     * Flip a rule on or off without re-sending the whole thing.
     *
     * A PATCH rather than a PUT on purpose: turning a rule off is the panic
     * button, and it shouldn't depend on the client still holding a complete,
     * valid copy of every other field.
     */
    suspend fun setActive(id: String, isActive: Boolean) {
        edge.patchRaw(rulePath(id), """{"is_active":$isActive}""")
    }

    suspend fun delete(id: String) {
        edge.deleteRaw(rulePath(id))
    }

    /** What the rule WOULD do. Applies nothing. */
    suspend fun dryRun(id: String): AutomationDryRunResult = edge.json.decodeFromString(
        AutomationDryRunResult.serializer(),
        edge.postRaw(dryRunPath(id), "{}"),
    )

    /** What the rule has already done. */
    suspend fun actions(id: String): List<AutomationActionRow> = edge.json.decodeFromString(
        AutomationActionsResponse.serializer(),
        edge.getRaw(actionsPath(id)),
    ).actions

    /** Run every active rule now instead of waiting for the cron. */
    suspend fun runNow(): AutomationRunResult = edge.json.decodeFromString(
        AutomationRunResult.serializer(),
        edge.postRaw(RUN_PATH, "{}"),
    )

    private fun body(draft: AutomationDraft): String =
        edge.json.encodeToString(AutomationRuleInput.serializer(), Automations.input(draft))

    fun message(error: Throwable): String =
        (error as? EdgeApiError)?.userMessage()
            ?: error.message
            ?: "Couldn't reach the automations service."
}
