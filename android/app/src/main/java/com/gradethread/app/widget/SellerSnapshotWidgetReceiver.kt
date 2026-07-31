package com.gradethread.app.widget

import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver

/**
 * US-1380: the manifest entry point for the seller-snapshot widget.
 *
 * Nothing but the binding. The receiver runs on the system's schedule and has
 * no session, so every decision it could make is one it would have to make
 * blind — the app publishes, the widget draws.
 */
class SellerSnapshotWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget get() = SellerSnapshotWidget
}
