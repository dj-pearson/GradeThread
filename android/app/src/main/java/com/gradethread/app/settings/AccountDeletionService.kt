package com.gradethread.app.settings

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-2776: `POST /api/account/delete` — the erasure right, on the phone.
 *
 * Google Play's User Data policy requires an in-app deletion path for any app
 * that lets people create an account. Android shipped a dialog that told the
 * seller to email support instead, which is the one answer the policy names as
 * insufficient, so the app could not be submitted.
 *
 * **The endpoint is the same one the website calls**, deliberately. Deleting an
 * account has to cascade across storage buckets, the Stripe customer, marketplace
 * tokens and email-keyed PII, and a second implementation of that is a second
 * chance to miss one. iOS calls the older `delete_account` RPC, which does less;
 * this is the fuller path and the one worth converging on.
 *
 * **No user id is sent.** The server reads the subject from the bearer token —
 * an id in the body is an id a caller could change, on the one endpoint where
 * changing it would destroy somebody else's account.
 */
@Singleton
class AccountDeletionService @Inject constructor(@Named("shared") private val edge: EdgeApi) {

    /** What the server said. */
    sealed interface Outcome {
        /** Gone. The caller must now tear the local session down. */
        object Deleted : Outcome

        /**
         * The account signs in with a password and the server wants it.
         *
         * Asked for by the SERVER rather than guessed at by the client. The
         * alternative is introspecting the auth providers here and demanding a
         * password from accounts that have none, which is how an OAuth user ends
         * up unable to delete their account. The server already knows; it says so
         * with `code: "password_required"`, and this is that answer typed.
         */
        object PasswordRequired : Outcome

        /** Anything else, with copy the caller can show as-is. */
        data class Failed(val message: String) : Outcome
    }

    /**
     * Delete the signed-in account.
     *
     * [password] is sent only when the caller has one to send. A first call
     * without it is not a wasted round trip — it is how an OAuth account, which
     * is exempt, deletes in one step.
     */
    suspend fun delete(password: String?): Outcome = withContext(Dispatchers.IO) {
        val body = buildString {
            append("{\"confirm\":").append(JsonPrimitive(CONFIRM_PHRASE))
            if (!password.isNullOrEmpty()) {
                append(",\"password\":").append(JsonPrimitive(password))
            }
            append("}")
        }
        runCatching { edge.postRaw(DELETE_PATH, body) }.fold(
            onSuccess = { Outcome.Deleted },
            onFailure = { error ->
                if (errorCode(error) == PASSWORD_REQUIRED) {
                    Outcome.PasswordRequired
                } else {
                    Outcome.Failed(message(error))
                }
            },
        )
    }

    companion object {
        const val DELETE_PATH = "/api/account/delete"

        /**
         * The exact string the server checks for. Not localized, and not
         * translatable: the server compares this literal, so a translated
         * confirmation would be typed correctly and rejected. The UI says which
         * words to type; the words themselves are a protocol constant.
         */
        const val CONFIRM_PHRASE = "DELETE MY ACCOUNT"

        private const val PASSWORD_REQUIRED = "password_required"

        private val lenient = Json {
            ignoreUnknownKeys = true
            isLenient = true
        }

        /** The `code` discriminator out of a 4xx body, or null. */
        private fun errorCode(error: Throwable): String? {
            val raw = (error as? EdgeApiError.BadRequest)?.body ?: return null
            return runCatching {
                (lenient.parseToJsonElement(raw) as? JsonObject)
                    ?.get("code")?.jsonPrimitive?.content
            }.getOrNull()
        }

        /**
         * The server's own sentence where there is one.
         *
         * `EdgeApiError.userMessage()` is right for a transport failure and
         * wrong here: the delete endpoint refuses with reasons a person can act
         * on ("Enter your password to confirm deleting your account", "Nothing
         * was removed from your account"), and replacing those with generic copy
         * is how a seller retries a deletion that will refuse again for the same
         * unstated reason. `detail` already carries the body's `error` string —
         * EdgeApiError decodes it before it picks a case.
         */
        fun message(error: Throwable): String {
            val fromServer = when (error) {
                is EdgeApiError.BadRequest -> error.detail
                is EdgeApiError.ServerError -> error.detail
                is EdgeApiError.Forbidden -> error.detail
                else -> null
            }
            return fromServer?.takeIf { it.isNotBlank() }
                ?: (error as? EdgeApiError)?.userMessage()
                ?: error.message
                ?: "We couldn't delete your account just now."
        }
    }
}
