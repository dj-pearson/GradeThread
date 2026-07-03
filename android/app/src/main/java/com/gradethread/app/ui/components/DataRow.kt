package com.gradethread.app.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.tooling.preview.Preview
import com.gradethread.app.ui.theme.GradeThreadTheme
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.brandData

/**
 * US-1303: labeled data row (iOS DataRow) — muted label left, value right in
 * tabular digits so stacked rows of prices/counts/measurements align.
 * TalkBack reads label and value as one element.
 */
@Composable
fun DataRow(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = Spacing.xxs)
            .semantics(mergeDescendants = true) {},
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(value, style = brandData())
    }
}

@Preview(showBackground = true)
@Composable
private fun DataRowPreview() {
    GradeThreadTheme {
        Column(Modifier.padding(Spacing.md)) {
            DataRow("Sold price", "$128.00")
            DataRow("Fees", "$16.42")
            DataRow("Net profit", "$83.13")
        }
    }
}
