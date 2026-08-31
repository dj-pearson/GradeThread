package com.gradethread.app.pricing

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-1358: repricing rules, scan, and the suggestions it produces.
 *
 * Everything is server-side — the rules run on a schedule the phone isn't
 * awake for, and the scan needs eBay comps. The client's job is to describe a
 * rule accurately and act on what came back.
 */
@Singleton
class RepricingService @Inject constructor(@Named("shared") private val edge: EdgeApi) {

    companion object {
        private const val BASE = "/api/flipdesk/pricing"
        const val RULES_PATH = "$BASE/rules"
        const val ACTIONS_PATH = "$BASE/rules/actions"
        const val RUN_PATH = "$BASE/rules/run"
        const val SUGGESTIONS_PATH = "$BASE/suggestions"
        const val SCAN_PATH = "$BASE/scan"

        fun rulePath(id: String) = "$RULES_PATH/$id"
        fun applyPath(id: String) = "$SUGGESTIONS_PATH/$id/apply"
        fun dismissPath(id: String) = "$SUGGESTIONS_PATH/$id/dismiss"
    }

    // ── rules ────────────────────────────────────────────────────────────────

    suspend fun rules(): List<RepricingRule> =
        edge.json.decodeFromString(RulesResponse.serializer(), edge.getRaw(RULES_PATH)).rules

    suspend fun createRule(draft: RuleDraft): RepricingRule? = edge.json.decodeFromString(
        RuleResponse.serializer(),
        edge.postRaw(RULES_PATH, body(draft)),
    ).rule

    suspend fun updateRule(id: String, draft: RuleDraft): RepricingRule? = edge.json.decodeFromString(
        RuleResponse.serializer(),
        edge.putRaw(rulePath(id), body(draft)),
    ).rule

    suspend fun deleteRule(id: String) {
        edge.deleteRaw(rulePath(id))
    }

    /** Recent automatic changes, so automation is auditable rather than magic. */
    suspend fun actions(): List<RepricingAction> =
        edge.json.decodeFromString(ActionsResponse.serializer(), edge.getRaw(ACTIONS_PATH)).actions

    // ── suggestions ──────────────────────────────────────────────────────────

    suspend fun suggestions(): List<RepricingSuggestion> = edge.json.decodeFromString(
        SuggestionsResponse.serializer(),
        edge.getRaw(SUGGESTIONS_PATH),
    ).suggestions

    /** Look for new suggestions now, instead of waiting for the nightly pass. */
    suspend fun scan(limit: Int = Repricing.DEFAULT_SCAN_LIMIT): ScanResult = edge.json.decodeFromString(
        ScanResult.serializer(),
        edge.postRaw(
            SCAN_PATH,
            edge.json.encodeToString(
                ScanRequest.serializer(),
                ScanRequest(Repricing.clampScanLimit(limit)),
            ),
        ),
    )

    suspend fun apply(suggestionId: String) {
        edge.postRaw(applyPath(suggestionId), "{}")
    }

    suspend fun dismiss(suggestionId: String) {
        edge.postRaw(dismissPath(suggestionId), "{}")
    }

    private fun body(draft: RuleDraft): String =
        edge.json.encodeToString(RuleRequest.serializer(), Repricing.request(draft))

    /**
     * US-2976: the server's sentence when it sent one, our resource otherwise.
     *
     * `error.message` is dropped rather than shown - it is a JVM exception
     * string, which is a developer's sentence in a language nobody chose.
     */
    fun message(error: Throwable): UiMessage = UiMessage(
        R.string.repricing_unreachable,
        detail = (error as? EdgeApiError)?.userMessage(),
    )
}
