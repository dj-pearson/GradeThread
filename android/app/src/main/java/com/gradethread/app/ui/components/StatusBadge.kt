package com.gradethread.app.ui.components

import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage
import com.gradethread.app.ui.theme.BrandPalette
import com.gradethread.app.ui.theme.CornerRadius
import com.gradethread.app.ui.theme.GradeThreadTheme

/**
 * US-1303: the shared item-status badge — one place a status maps to color +
 * label so it looks identical across Inventory / Sales / Money / Marketplaces
 * (iOS StatusBadge, US-753). Pipeline phases: pre-list prep reads
 * work-in-progress navy, drafted amber, listed navy, sold/shipped/completed
 * emerald, returned red.
 */
object StatusStyle {

    /**
     * US-2368: the known statuses, each with its own resource.
     *
     * [label] title-cases the wire value, which reads correctly in English and
     * translates in no language at all — "to_list" has no words in it, only a
     * key. The statuses are a fixed set, so they get real strings; anything
     * outside the set still falls back to [label], because a slug rendered
     * as-is beats a blank badge.
     */
    private val LABEL_RES = mapOf(
        "sourced" to R.string.status_sourced,
        "cataloged" to R.string.status_cataloged,
        "measured" to R.string.status_measured,
        "photographed" to R.string.status_photographed,
        "comped" to R.string.status_comped,
        "drafted" to R.string.status_drafted,
        "to_list" to R.string.status_to_list,
        "listed" to R.string.status_listed,
        "active" to R.string.status_active,
        "sold" to R.string.status_sold,
        "shipped" to R.string.status_shipped,
        "completed" to R.string.status_completed,
        "returned" to R.string.status_returned,
        "archived" to R.string.status_archived,
    )

    /** The resource for a known status, or null when it is not one. Pure. */
    @StringRes
    fun labelRes(status: String): Int? = LABEL_RES[status]

    /**
     * Fallback label: "to_list" → "To List". Pure; unit-tested. Reached only for
     * a status [LABEL_RES] does not know — a new server value that shipped ahead
     * of its string.
     */
    fun label(status: String): String = status
        .split('_')
        .filter { it.isNotEmpty() }
        .joinToString(" ") { part -> part.replaceFirstChar { it.uppercaseChar() } }

    /**
     * The status as something showable, from a class with no Context.
     *
     * US-2976: a status we know is one of OUR words and translates. A status
     * we do not know is the SERVER's word, and it rides as `detail` so it is
     * shown exactly as sent - untranslated is the honest outcome for a value
     * that shipped ahead of its string. Same split as
     * PassportFormat.eventLabel.
     */
    fun message(status: String): UiMessage = labelRes(status)
        ?.let { UiMessage(it) }
        ?: UiMessage(R.string.status_other, detail = label(status))

    /**
     * Pipeline-phase tone. Pure; unit-tested.
     *
     * ⚠ DELIBERATELY NOT theme-aware, unlike the other status colours moved to
     * [statusEmerald]/[statusAmber] in US-3010. Making this @Composable would
     * cost its purity and the seven StatusStyleTest assertions that read it
     * directly, and the swap is not mechanical: a caller would have to resolve
     * the colour and pass it in. Worth doing, worth doing on purpose.
     */
    fun tone(status: String): Color = when (status) {
        "sold", "shipped", "completed" -> BrandPalette.Emerald
        "listed", "active" -> BrandPalette.Navy
        "drafted" -> BrandPalette.Amber
        "returned" -> BrandPalette.Red
        else -> BrandPalette.Navy.copy(alpha = 0.75f) // pre-list prep (steel)
    }
}

/** The status in the reader's language, falling back to the title-cased slug. */
@Composable
fun statusLabel(status: String): String =
    StatusStyle.labelRes(status)?.let { stringResource(it) } ?: StatusStyle.label(status)

@Composable
fun StatusBadge(status: String, modifier: Modifier = Modifier) {
    val tone = StatusStyle.tone(status)
    val label = statusLabel(status)
    // Hoisted out of clearAndSetSemantics, which is not a composable scope.
    val spoken = stringResource(R.string.a11y_status, label)
    Text(
        text = label,
        style = MaterialTheme.typography.bodySmall,
        fontWeight = FontWeight.SemiBold,
        color = tone,
        modifier = modifier
            .clip(RoundedCornerShape(CornerRadius.pill))
            .background(tone.copy(alpha = 0.12f))
            .padding(horizontal = 8.dp, vertical = 3.dp)
            // Status is conveyed by color — say it explicitly for TalkBack
            // (the iOS US-1202 fix, carried over).
            .clearAndSetSemantics { contentDescription = spoken },
    )
}

@Preview(showBackground = true)
@Composable
private fun StatusBadgePreview() {
    GradeThreadTheme {
        androidx.compose.foundation.layout.Column {
            StatusBadge("sold")
            StatusBadge("drafted")
            StatusBadge("listed")
            StatusBadge("returned")
            StatusBadge("to_list")
        }
    }
}
