package com.gradethread.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
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

    /** Human-readable label: "to_list" → "To List". Pure; unit-tested. */
    fun label(status: String): String = status
        .split('_')
        .filter { it.isNotEmpty() }
        .joinToString(" ") { part -> part.replaceFirstChar { it.uppercaseChar() } }

    /** Pipeline-phase tone. Pure; unit-tested. */
    fun tone(status: String): Color = when (status) {
        "sold", "shipped", "completed" -> BrandPalette.Emerald
        "listed", "active" -> BrandPalette.Navy
        "drafted" -> BrandPalette.Amber
        "returned" -> BrandPalette.Red
        else -> BrandPalette.Navy.copy(alpha = 0.75f) // pre-list prep (steel)
    }
}

@Composable
fun StatusBadge(status: String, modifier: Modifier = Modifier) {
    val tone = StatusStyle.tone(status)
    val label = StatusStyle.label(status)
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
            .clearAndSetSemantics { contentDescription = "Status: $label" },
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
