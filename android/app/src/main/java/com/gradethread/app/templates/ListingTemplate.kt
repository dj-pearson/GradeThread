package com.gradethread.app.templates

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * US-1373 (iOS `ListingTemplate`, US-674): a reusable listing preset.
 *
 * Mirrors the `listing_templates` row (migration 00105). Read and written
 * through the RLS-scoped client rather than the edge API, and that is not a
 * style choice: the edge client's snake_case key conversion would mangle the
 * free-form `item_specifics` map keys ("Sleeve Length" is a real aspect name).
 */
@Serializable
data class ListingTemplate(
    val id: String,
    val name: String,
    @SerialName("description_template") val descriptionTemplate: String? = null,
    @SerialName("ebay_condition") val ebayCondition: String? = null,
    @SerialName("condition_description") val conditionDescription: String? = null,
    /** Aspect defaults: `{ "Sleeve Length": "Long Sleeve" }`. */
    @SerialName("item_specifics") val itemSpecifics: Map<String, String> = emptyMap(),
    @SerialName("ebay_category_id") val ebayCategoryId: String? = null,
    @SerialName("return_policy_id") val returnPolicyId: String? = null,
    @SerialName("shipping_policy_id") val shippingPolicyId: String? = null,
    @SerialName("payment_policy_id") val paymentPolicyId: String? = null,
    @SerialName("is_default") val isDefault: Boolean = false,
    @SerialName("sort_order") val sortOrder: Int = 0,
) {
    /** A one-line "what this template actually sets", for the list row. */
    val summary: String
        get() {
            val parts = buildList {
                ebayCondition?.takeIf { it.isNotBlank() }?.let { add(prettyCondition(it)) }
                if (itemSpecifics.isNotEmpty()) {
                    add(
                        "${itemSpecifics.size} " +
                            if (itemSpecifics.size == 1) "specific" else "specifics",
                    )
                }
                if (!descriptionTemplate.isNullOrBlank()) add("description block")
                if (policyCount > 0) {
                    add("$policyCount ${if (policyCount == 1) "policy" else "policies"}")
                }
            }
            // An empty template is a real state — someone saved a name and
            // nothing else — and saying "sets nothing yet" beats a blank line
            // that looks like a rendering bug.
            return parts.takeIf { it.isNotEmpty() }?.joinToString(" · ") ?: "Sets nothing yet"
        }

    val policyCount: Int
        get() = listOfNotNull(returnPolicyId, shippingPolicyId, paymentPolicyId)
            .count { it.isNotBlank() }

    companion object {
        /** `USED_EXCELLENT` reads better as `Used excellent`. */
        fun prettyCondition(value: String): String = value
            .replace('_', ' ')
            .lowercase()
            .replaceFirstChar { it.uppercaseChar() }
    }
}

/**
 * Editable working copy.
 *
 * Strings use "" for unset; the service trims and nulls them before sending so
 * the server stores NULL rather than an empty string — otherwise "no condition
 * description" and "an empty one" become indistinguishable downstream.
 */
data class TemplateDraft(
    val name: String = "",
    val descriptionTemplate: String = "",
    val ebayCondition: String = "",
    val conditionDescription: String = "",
    val ebayCategoryId: String = "",
    val returnPolicyId: String = "",
    val shippingPolicyId: String = "",
    val paymentPolicyId: String = "",
    val itemSpecifics: Map<String, String> = emptyMap(),
    val isDefault: Boolean = false,
    val sortOrder: Int = 0,
) {
    val trimmedName: String get() = name.trim()

    val isValid: Boolean get() = trimmedName.isNotEmpty()

    val validationMessage: String?
        get() = if (trimmedName.isEmpty()) "Give this template a name." else null

    /** Specifics with a blank value dropped — an empty default sets nothing. */
    val cleanSpecifics: Map<String, String>
        get() = itemSpecifics
            .mapKeys { it.key.trim() }
            .filterKeys { it.isNotEmpty() }
            .filterValues { it.isNotBlank() }

    fun withSpecific(name: String, value: String): TemplateDraft =
        copy(itemSpecifics = itemSpecifics + (name to value))

    fun withoutSpecific(name: String): TemplateDraft =
        copy(itemSpecifics = itemSpecifics - name)

    /** Rename a specific, keeping its value and dropping the old key. */
    fun renameSpecific(from: String, to: String): TemplateDraft {
        if (from == to) return this
        val value = itemSpecifics[from] ?: return this
        return copy(itemSpecifics = itemSpecifics - from + (to to value))
    }

    companion object {
        fun of(template: ListingTemplate) = TemplateDraft(
            name = template.name,
            descriptionTemplate = template.descriptionTemplate.orEmpty(),
            ebayCondition = template.ebayCondition.orEmpty(),
            conditionDescription = template.conditionDescription.orEmpty(),
            ebayCategoryId = template.ebayCategoryId.orEmpty(),
            returnPolicyId = template.returnPolicyId.orEmpty(),
            shippingPolicyId = template.shippingPolicyId.orEmpty(),
            paymentPolicyId = template.paymentPolicyId.orEmpty(),
            itemSpecifics = template.itemSpecifics,
            isDefault = template.isDefault,
            sortOrder = template.sortOrder,
        )
    }
}
