package com.gradethread.app.ui.shell

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import androidx.compose.ui.Modifier
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1335: the Tools list, replacing the placeholder.
 *
 * It exists now because Snap-to-Value needed somewhere real to live — a
 * feature with no entry point is not shipped, whatever the code says. Later
 * tools append here.
 */
@Composable
fun ToolsScreen(
    onSnap: () -> Unit,
    modifier: Modifier = Modifier,
    onGrades: () -> Unit = {},
    /** US-2815: grade one garment from photos, with no inventory item. */
    onGradeAGarment: () -> Unit = {},
    onAnalytics: () -> Unit = {},
    onConsignors: () -> Unit = {},
    onTemplates: () -> Unit = {},
    onScout: () -> Unit = {},
    onProspect: () -> Unit = {},
    onVerified: () -> Unit = {},
    onShipping: () -> Unit = {},
    onReferrals: () -> Unit = {},
    onSupport: () -> Unit = {},
    onImport: () -> Unit = {},
    /** US-2495: which shops actually make money. */
    onMyStores: () -> Unit = {},
    /** US-2492: what everyone else has found in the shops near you. */
    onRadar: () -> Unit = {},
) {
    Column(
        modifier = modifier.fillMaxSize().padding(vertical = Spacing.sm),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        ToolRow(
            title = stringResource(R.string.tools_what_s_worth),
            subtitle = stringResource(R.string.tools_snap_one_photo_instant_condition),
            onClick = onSnap,
        )
        ToolRow(
            title = stringResource(R.string.tools_certified_grades),
            subtitle = stringResource(R.string.tools_every_graded_item_its_report),
            onClick = onGrades,
        )
        // US-2815: above the history, because grading something is the verb
        // and the list is what it produces.
        ToolRow(
            title = stringResource(R.string.tools_grade_a_garment),
            subtitle = stringResource(R.string.tools_grade_a_garment_subtitle),
            onClick = onGradeAGarment,
        )
        ToolRow(
            title = stringResource(R.string.tools_radar),
            subtitle = stringResource(R.string.tools_radar_subtitle),
            onClick = onRadar,
        )
        ToolRow(
            title = stringResource(R.string.tools_my_stores),
            subtitle = stringResource(R.string.tools_my_stores_subtitle),
            onClick = onMyStores,
        )
        ToolRow(
            title = stringResource(R.string.tools_analytics),
            subtitle = stringResource(R.string.tools_grades_brands_sell_through_inventory),
            onClick = onAnalytics,
        )
        ToolRow(
            title = stringResource(R.string.tools_consignors),
            subtitle = stringResource(R.string.tools_who_sell_their_split_what),
            onClick = onConsignors,
        )
        ToolRow(
            title = stringResource(R.string.tools_listing_templates),
            subtitle = stringResource(R.string.tools_save_condition_specifics_boilerplate_reuse),
            onClick = onTemplates,
        )
        ToolRow(
            title = stringResource(R.string.tools_scout),
            subtitle = stringResource(R.string.tools_find_underpriced_listings_ebay_graded),
            onClick = onScout,
        )
        ToolRow(
            title = stringResource(R.string.tools_prospect),
            subtitle = stringResource(R.string.tools_shop_photograph_find_out_if),
            onClick = onProspect,
        )
        ToolRow(
            title = stringResource(R.string.tools_verified_seller),
            subtitle = stringResource(R.string.tools_badge_status_what_s_left),
            onClick = onVerified,
        )
        ToolRow(
            title = stringResource(R.string.tools_shipping),
            subtitle = stringResource(R.string.tools_what_s_sold_still_needs),
            onClick = onShipping,
        )
        ToolRow(
            title = stringResource(R.string.tools_invite_friend),
            subtitle = stringResource(R.string.tools_share_code_earn_grading_credits),
            onClick = onReferrals,
        )
        ToolRow(
            title = stringResource(R.string.tools_import_spreadsheet),
            subtitle = stringResource(R.string.tools_bring_inventory_from_csv_sheets),
            onClick = onImport,
        )
        ToolRow(
            title = stringResource(R.string.tools_support),
            subtitle = stringResource(R.string.tools_open_request_read_our_replies),
            onClick = onSupport,
        )
    }
}

@Composable
private fun ToolRow(title: String, subtitle: String, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(Spacing.md)) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text(
            subtitle,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
    HorizontalDivider()
}
