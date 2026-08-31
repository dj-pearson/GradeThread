package com.gradethread.app.widget

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.provideContent
import androidx.glance.action.clickable
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import com.gradethread.app.R

/**
 * US-1380: the seller-snapshot home-screen widget.
 *
 * Reads ONE stored snapshot and draws it. No Room, no network, no rollup work
 * here — a widget render happens on the system's schedule with a hard budget,
 * and anything slow shows up as a blank tile on someone's home screen.
 *
 * Glance draws to RemoteViews, not to Compose UI, so nothing in the app's
 * component library can be reused. That is a platform constraint, not an
 * oversight: the copy lives in [WidgetCopy] so at least the words are shared
 * with the tests.
 */
object SellerSnapshotWidget : GlanceAppWidget() {

    /**
     * Two layouts, not a scaling one. A 2x1 tile has room for two numbers and a
     * 4x1 has room for three; squeezing three into the small size produces
     * figures too small to read at arm's length, which is the only distance a
     * home screen is ever read from.
     */
    override val sizeMode = SizeMode.Responsive(
        setOf(
            DpSize(140.dp, 110.dp),
            DpSize(250.dp, 110.dp),
        ),
    )

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        // Read BEFORE provideContent: the read is suspending and the content
        // block is not, and a widget must never render a spinner it has no way
        // to replace on its own.
        val snapshot = WidgetSnapshotStore.read(context) ?: WidgetSnapshot.signedOut()
        val now = System.currentTimeMillis()
        provideContent { Content(snapshot, now) }
    }

    @Composable
    private fun Content(snapshot: WidgetSnapshot, nowMs: Long) {
        // US-2976: WidgetCopy resolves resources now, so every label needs a
        // Context. Glance supplies one through LocalContext, the same as
        // Compose does.
        val context = LocalContext.current
        GlanceTheme {
            Column(
                modifier = GlanceModifier
                    .fillMaxSize()
                    .background(GlanceTheme.colors.widgetBackground)
                    .padding(horizontal = 14.dp, vertical = 12.dp)
                    // The whole tile reads as one sentence. TalkBack users get
                    // the snapshot in one swipe rather than hunting three
                    // unlabelled numbers.
                    .semantics { contentDescription = WidgetCopy.accessibilityLabel(context, snapshot) },
                verticalAlignment = Alignment.Vertical.Top,
            ) {
                if (!snapshot.isSignedIn) {
                    SignedOut()
                    return@Column
                }
                Metrics(snapshot)
                WidgetCopy.updatedAgo(context, snapshot.generatedAt, nowMs)?.let { stamp ->
                    Spacer(GlanceModifier.height(6.dp))
                    Text(
                        stamp,
                        style = TextStyle(
                            fontSize = 11.sp,
                            color = GlanceTheme.colors.onSurfaceVariant,
                        ),
                    )
                }
            }
        }
    }

    @Composable
    private fun SignedOut() {
        val context = LocalContext.current
        Column(
            modifier = GlanceModifier.fillMaxSize().clickable(openApp(WidgetDeepLink.MONEY)),
            verticalAlignment = Alignment.Vertical.CenterVertically,
            horizontalAlignment = Alignment.Horizontal.Start,
        ) {
            Text(
                WidgetCopy.title(context),
                style = TextStyle(
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    color = GlanceTheme.colors.onSurface,
                ),
            )
            Spacer(GlanceModifier.height(4.dp))
            Text(
                WidgetCopy.signedOut(context),
                style = TextStyle(fontSize = 12.sp, color = GlanceTheme.colors.onSurfaceVariant),
            )
        }
    }

    @Composable
    private fun Metrics(snapshot: WidgetSnapshot) {
        val wide = LocalSize.current.width >= 220.dp
        // Glance is not Compose UI: androidx.compose.ui.res.stringResource needs
        // a LocalConfiguration that a widget's composition does not provide, so
        // the labels come off the context instead.
        val context = LocalContext.current
        Row(modifier = GlanceModifier.fillMaxWidth()) {
            Metric(
                label = context.getString(R.string.widget_sold_today),
                value = WidgetCopy.soldToday(snapshot),
                sub = WidgetCopy.soldTodaySub(context, snapshot),
                description = WidgetCopy.moneyActionLabel(context, snapshot),
                link = WidgetDeepLink.MONEY,
            )
            Spacer(GlanceModifier.width(12.dp))
            Metric(
                label = context.getString(R.string.widget_pending),
                value = WidgetCopy.pendingPayout(snapshot),
                sub = WidgetCopy.pendingSub(context, snapshot),
                description = WidgetCopy.pendingActionLabel(context, snapshot),
                link = WidgetDeepLink.MONEY,
            )
            // Active listings is the first thing dropped at the small size:
            // it is the slowest-moving of the three, so it is the one a seller
            // is least likely to be glancing for.
            if (wide) {
                Spacer(GlanceModifier.width(12.dp))
                Metric(
                    label = context.getString(R.string.widget_listed),
                    value = WidgetCopy.activeListings(snapshot),
                    sub = null,
                    description = WidgetCopy.listingsActionLabel(context, snapshot),
                    link = WidgetDeepLink.MARKETPLACES,
                )
            }
        }
    }

    @Composable
    private fun Metric(label: String, value: String, sub: String?, description: String, link: WidgetDeepLink) {
        Column(
            modifier = GlanceModifier
                .clickable(openApp(link))
                .semantics { contentDescription = description },
        ) {
            Text(
                label,
                style = TextStyle(fontSize = 11.sp, color = GlanceTheme.colors.onSurfaceVariant),
            )
            Text(
                value,
                style = TextStyle(
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                    color = GlanceTheme.colors.onSurface,
                ),
            )
            sub?.let {
                Text(
                    it,
                    style = TextStyle(
                        fontSize = 11.sp,
                        color = GlanceTheme.colors.onSurfaceVariant,
                    ),
                )
            }
        }
    }

    @Composable
    private fun openApp(link: WidgetDeepLink) = actionStartActivity(
        Intent(Intent.ACTION_VIEW, Uri.parse(link.uri))
            // Explicit package: an unqualified VIEW on our own scheme could in
            // principle be offered to another app that claimed it.
            .setPackage(LocalContext.current.packageName),
    )
}
