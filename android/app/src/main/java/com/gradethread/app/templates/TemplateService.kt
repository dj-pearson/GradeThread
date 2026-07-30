package com.gradethread.app.templates

import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.postgrest.from
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.postgrest.query.Columns
import io.github.jan.supabase.postgrest.query.Order
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import javax.inject.Inject
import javax.inject.Singleton

/**
 * US-1373: listing-template CRUD.
 *
 * Directly on `listing_templates` through the RLS-scoped client — every query
 * rides the signed-in user's JWT, so rows are owner-scoped by the database.
 *
 * Create and update go through the `create_listing_template` /
 * `update_listing_template` RPCs (migration 00317) rather than a plain
 * insert/update. That is load-bearing: only one template per owner may be the
 * default, and the old two-step "clear the previous default, then write" left
 * the seller with ZERO defaults whenever the second step failed. The RPCs do
 * both in one transaction.
 */
interface TemplateProviding {
    suspend fun list(): List<ListingTemplate>
    suspend fun create(draft: TemplateDraft): ListingTemplate
    suspend fun update(id: String, draft: TemplateDraft): ListingTemplate
    suspend fun delete(id: String)
}

class TemplateServiceError(message: String) : Exception(message)

@Singleton
class TemplateService @Inject constructor(
    private val client: SupabaseClient,
) : TemplateProviding {

    override suspend fun list(): List<ListingTemplate> = client
        .from(TABLE)
        .select(Columns.raw(COLUMNS)) {
            order("sort_order", Order.ASCENDING)
            order("name", Order.ASCENDING)
        }
        .decodeList()

    override suspend fun create(draft: TemplateDraft): ListingTemplate =
        callRpc("create_listing_template", fields(draft))

    override suspend fun update(id: String, draft: TemplateDraft): ListingTemplate =
        callRpc("update_listing_template", fields(draft) + ("p_id" to JsonPrimitive(id)))

    override suspend fun delete(id: String) {
        // RLS scopes DELETE to the caller. A template is only ever referenced by
        // listing_generation_batches.template_id, which is ON DELETE SET NULL,
        // so deleting one never takes a batch's history with it.
        client.from(TABLE).delete { filter { eq("id", id) } }
    }

    /**
     * The RPCs `RETURN public.listing_templates`, so PostgREST replies with a
     * single JSON object rather than an array.
     */
    private suspend fun callRpc(
        function: String,
        params: Map<String, kotlinx.serialization.json.JsonElement>,
    ): ListingTemplate {
        val raw = client.postgrest.rpc(function, JsonObject(params)).data
        return runCatching { json.decodeFromString(ListingTemplate.serializer(), raw) }
            .getOrElse { throw TemplateServiceError("The server didn't return the saved template.") }
    }

    /**
     * Every RPC argument, always.
     *
     * Explicit nulls rather than omitted keys: the functions declare no defaults,
     * and an omitted argument changes which overload PostgREST resolves — which
     * fails as "function does not exist" rather than as a missing field.
     */
    private fun fields(draft: TemplateDraft) = mapOf(
        "p_name" to JsonPrimitive(draft.trimmedName),
        "p_description_template" to draft.descriptionTemplate.toJson(),
        "p_ebay_condition" to draft.ebayCondition.toJson(),
        "p_condition_description" to draft.conditionDescription.toJson(),
        "p_item_specifics" to JsonObject(
            draft.cleanSpecifics.mapValues { JsonPrimitive(it.value.trim()) },
        ),
        "p_ebay_category_id" to draft.ebayCategoryId.toJson(),
        "p_return_policy_id" to draft.returnPolicyId.toJson(),
        "p_shipping_policy_id" to draft.shippingPolicyId.toJson(),
        "p_payment_policy_id" to draft.paymentPolicyId.toJson(),
        "p_is_default" to JsonPrimitive(draft.isDefault),
        "p_sort_order" to JsonPrimitive(draft.sortOrder),
    )

    private fun String.toJson(): kotlinx.serialization.json.JsonElement =
        trim().takeIf { it.isNotEmpty() }?.let { JsonPrimitive(it) } ?: JsonNull

    private companion object {
        const val TABLE = "listing_templates"
        const val COLUMNS =
            "id, name, description_template, ebay_condition, condition_description, " +
                "item_specifics, ebay_category_id, return_policy_id, shipping_policy_id, " +
                "payment_policy_id, is_default, sort_order"

        val json = Json { ignoreUnknownKeys = true }
    }
}
