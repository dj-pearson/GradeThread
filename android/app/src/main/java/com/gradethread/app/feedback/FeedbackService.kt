package com.gradethread.app.feedback

import android.os.Build
import com.gradethread.app.BuildConfig
import com.gradethread.app.platform.net.EdgeApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/** US-1387: sending feedback. Behind an interface so the sheet is testable. */
interface FeedbackSending {
    suspend fun send(category: Feedback.Category, message: String)
}

@Singleton
class FeedbackService @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
) : FeedbackSending {

    override suspend fun send(category: Feedback.Category, message: String) {
        val payload = json.encodeToString(
            FeedbackBody.serializer(),
            FeedbackBody(
                message = Feedback.compose(category, message),
                source = Feedback.SOURCE,
                appVersion = appVersion(),
                osVersion = osVersion(),
                deviceModel = deviceModel(),
            ),
        )
        edge.postRaw(PATH, payload)
    }

    companion object {
        const val PATH = "/api/notifications/feedback"
        private val json = Json { encodeDefaults = true }

        fun appVersion(): String = "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})"

        fun osVersion(): String = "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})"

        /**
         * Manufacturer AND model.
         *
         * `Build.MODEL` alone is often a code name support cannot look up, and
         * the same model string is reused across manufacturers.
         */
        fun deviceModel(): String = "${Build.MANUFACTURER} ${Build.MODEL}"
    }
}

/**
 * What the edge stores.
 *
 * `breadcrumbs` is deliberately omitted rather than sent empty: the server
 * defaults it, and an empty array from us would look like a client that
 * collects them and found none.
 */
@Serializable
private data class FeedbackBody(
    val message: String,
    val source: String,
    @SerialName("app_version") val appVersion: String,
    @SerialName("os_version") val osVersion: String,
    @SerialName("device_model") val deviceModel: String,
)
