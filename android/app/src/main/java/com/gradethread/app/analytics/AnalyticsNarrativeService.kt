package com.gradethread.app.analytics

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/** Body of `POST /api/flipdesk/ai/analytics-narrative`. */
@Serializable
data class AnalyticsNarrativeRequest(
    @SerialName("period_label") val periodLabel: String,
    @SerialName("gross_revenue") val grossRevenue: Double,
    val fees: Double,
    val cogs: Double,
    @SerialName("units_sold") val unitsSold: Int,
    @SerialName("sell_through_rate") val sellThroughRate: Double? = null,
    @SerialName("grading_roi_lift") val gradingRoiLift: Double? = null,
    @SerialName("top_brand") val topBrand: String? = null,
    val currency: String? = null,
)

@Serializable
data class AnalyticsNarrative(
    val summary: String = "",
    val highlights: List<String> = emptyList(),
    val actions: List<String> = emptyList(),
    val model: String? = null,
    @SerialName("actions_remaining") val actionsRemaining: Int = -1,
) {
    /** -1 is the server's "unlimited" marker, not a count. */
    val remainingLabel: String?
        get() = if (actionsRemaining < 0) null else "$actionsRemaining AI actions left this month"
}

/**
 * US-1368 AC2: the ONLY part of analytics that leaves the device.
 *
 * The client computes every number itself and posts the finished figures; the
 * server turns them into sentences. That split is deliberate — it means the
 * charts work with no signal and no AI quota, and the narrative is a garnish
 * that can fail without taking the tab down with it.
 */
@Singleton
class AnalyticsNarrativeService @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
) {

    companion object {
        const val PATH = "/api/flipdesk/ai/analytics-narrative"
        private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    }

    /**
     * Build the request from a computed period.
     *
     * Every optional field is genuinely optional: a null sell-through or ROI
     * lift means "we don't have enough data for this to mean anything", and
     * sending a zero instead would have the model narrate a fact that isn't one.
     */
    fun request(
        range: AnalyticsRange,
        pnl: PeriodPnL,
        sellThroughRate: Double?,
        roiLift: Double?,
        topBrand: String?,
    ) = AnalyticsNarrativeRequest(
        periodLabel = range.label,
        grossRevenue = pnl.grossRevenue,
        fees = pnl.fees,
        cogs = pnl.cogs,
        unitsSold = pnl.unitsSold,
        sellThroughRate = sellThroughRate,
        gradingRoiLift = roiLift,
        topBrand = topBrand,
        currency = "USD",
    )

    suspend fun generate(request: AnalyticsNarrativeRequest): AnalyticsNarrative {
        val body = json.encodeToString(AnalyticsNarrativeRequest.serializer(), request)
        return json.decodeFromString(
            AnalyticsNarrative.serializer(),
            edge.postRaw(PATH, body),
        )
    }

    /**
     * User-facing copy for a failed narrative.
     *
     * A quota wall is not a breakage and must not read like one: the tab is
     * fully usable without the summary, and "try again" would be a lie.
     */
    fun failureMessage(error: Throwable): String = when (error) {
        is EdgeApiError.UpgradeRequired, is EdgeApiError.RateLimited ->
            (error as EdgeApiError).userMessage()
        is EdgeApiError -> error.userMessage()
        else -> "The AI summary isn't available right now. Your charts are unaffected."
    }
}
