package com.gradethread.app.consignment

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * US-1372 (iOS `Consignor`, US-676): someone whose items the reseller sells on
 * their behalf.
 *
 * Owner-scoped `consignors` row (migration 00107), read and written directly
 * through the RLS-scoped client. RLS is the whole isolation story here — every
 * query rides the signed-in user's JWT, so there is no service-role path to get
 * wrong.
 */
@Serializable
data class Consignor(
    val id: String,
    val name: String,
    @SerialName("contact_email") val contactEmail: String? = null,
    @SerialName("contact_phone") val contactPhone: String? = null,
    /**
     * Default share of NET sale proceeds (0–100) owed to this consignor when an
     * item carries no per-item override.
     */
    @SerialName("default_split_pct") val defaultSplitPct: Double = 50.0,
    val notes: String? = null,
)

/** Editable draft behind the create/edit sheet. */
data class ConsignorDraft(
    val name: String = "",
    val contactEmail: String = "",
    val contactPhone: String = "",
    /** Typed, not a Double: an empty field is a state a number can't hold. */
    val splitText: String = "50",
    val notes: String = "",
) {
    val trimmedName: String get() = name.trim()

    /**
     * The split as a number, or null when what's typed isn't one.
     *
     * Null is NOT 50: an unparseable split has to block the save rather than
     * quietly become the default, because the number here decides what a third
     * party gets paid.
     */
    val splitPct: Double? get() = splitText.trim().toDoubleOrNull()

    val splitInRange: Boolean get() = splitPct?.let { it in 0.0..100.0 } == true

    val isValid: Boolean get() = trimmedName.isNotEmpty() && splitInRange

    /** What's wrong, in words, or null when nothing is. */
    val validationMessage: String?
        get() = when {
            trimmedName.isEmpty() -> "Give this consignor a name."
            splitPct == null -> "The split has to be a number between 0 and 100."
            !splitInRange -> "The split has to be between 0 and 100."
            else -> null
        }

    companion object {
        fun of(consignor: Consignor) = ConsignorDraft(
            name = consignor.name,
            contactEmail = consignor.contactEmail.orEmpty(),
            contactPhone = consignor.contactPhone.orEmpty(),
            splitText = formatPct(consignor.defaultSplitPct),
            notes = consignor.notes.orEmpty(),
        )

        /** "50" not "50.00"; "33.5" keeps its half. */
        fun formatPct(value: Double): String =
            if (value % 1.0 == 0.0) value.toInt().toString() else value.toString()
    }
}
