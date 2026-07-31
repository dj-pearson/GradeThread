package com.gradethread.app.consignment

import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.postgrest.from
import io.github.jan.supabase.postgrest.query.Columns
import io.github.jan.supabase.postgrest.query.Order
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import javax.inject.Inject
import javax.inject.Singleton

/**
 * US-1372: consignor CRUD.
 *
 * Straight at the `consignors` table through the RLS-scoped client — every
 * query rides the signed-in user's JWT, so rows are owner-scoped by the
 * database rather than by anything this class remembers to do. There is no
 * service-role path here to get wrong.
 *
 * Behind an interface so the list, the validation and the delete warning are
 * testable without a database.
 */
interface ConsignorProviding {
    suspend fun list(): List<Consignor>
    suspend fun create(draft: ConsignorDraft): Consignor
    suspend fun update(id: String, draft: ConsignorDraft): Consignor
    suspend fun delete(id: String)
}

class ConsignorServiceError(message: String) : Exception(message)

@Serializable
private data class InsertPayload(
    @SerialName("user_id") val userId: String,
    val name: String,
    @SerialName("contact_email") val contactEmail: String?,
    @SerialName("contact_phone") val contactPhone: String?,
    @SerialName("default_split_pct") val defaultSplitPct: Double,
    val notes: String?,
)

@Singleton
class ConsignorService @Inject constructor(
    private val client: SupabaseClient,
) : ConsignorProviding {

    override suspend fun list(): List<Consignor> = client
        .from(TABLE)
        .select(Columns.raw(COLUMNS)) {
            order("name", Order.ASCENDING)
        }
        .decodeList()

    override suspend fun create(draft: ConsignorDraft): Consignor {
        val userId = client.auth.currentUserOrNull()?.id
            ?: throw ConsignorServiceError("Sign in again to add a consignor.")
        return client
            .from(TABLE)
            .insert(
                InsertPayload(
                    userId = userId,
                    name = draft.trimmedName,
                    contactEmail = draft.contactEmail.nilIfBlank(),
                    contactPhone = draft.contactPhone.nilIfBlank(),
                    defaultSplitPct = ConsignmentReport.clampPct(draft.splitPct ?: 50.0),
                    notes = draft.notes.nilIfBlank(),
                ),
            ) { select(Columns.raw(COLUMNS)) }
            .decodeList<Consignor>()
            .firstOrNull()
            ?: throw ConsignorServiceError("The server didn't return the saved consignor.")
    }

    override suspend fun update(id: String, draft: ConsignorDraft): Consignor = client
        .from(TABLE)
        // A JsonObject with EXPLICIT nulls, not an object that omits blank
        // fields: omitting them would leave the old email in place when someone
        // clears the field, which reads as the edit not having saved.
        .update(
            JsonObject(
                mapOf(
                    "name" to JsonPrimitive(draft.trimmedName),
                    "contact_email" to draft.contactEmail.nilIfBlank().toJson(),
                    "contact_phone" to draft.contactPhone.nilIfBlank().toJson(),
                    "default_split_pct" to JsonPrimitive(
                        ConsignmentReport.clampPct(draft.splitPct ?: 50.0),
                    ),
                    "notes" to draft.notes.nilIfBlank().toJson(),
                ),
            ),
        ) {
            filter { eq("id", id) }
            select(Columns.raw(COLUMNS))
        }
        .decodeList<Consignor>()
        .firstOrNull()
        ?: throw ConsignorServiceError("The server didn't return the saved consignor.")

    override suspend fun delete(id: String) {
        // `inventory_items.consignor_id` is ON DELETE SET NULL, so this
        // un-links their items rather than deleting them — the sale history
        // stays intact and the item simply loses its consignor pointer.
        client.from(TABLE).delete { filter { eq("id", id) } }
    }

    private fun String.nilIfBlank(): String? = trim().takeIf { it.isNotEmpty() }

    private fun String?.toJson() = this?.let { JsonPrimitive(it) } ?: JsonNull

    private companion object {
        const val TABLE = "consignors"
        const val COLUMNS = "id, name, contact_email, contact_phone, default_split_pct, notes"
    }
}
