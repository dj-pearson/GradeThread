package com.gradethread.app.platform.deeplink

import android.net.Uri
import com.gradethread.app.ui.shell.ShellRoutes
import com.gradethread.app.ui.shell.ShellSection

/**
 * US-1314: deep-link destinations (iOS DeepLinkRoute) — taps from push,
 * widgets, shortcuts, and email links resolve to one of these, then to a
 * shell nav route. Two inbound grammars:
 *
 *  • App Links: `https://gradethread.com/app/<dest>[/<id>]` — the verified
 *    domain (assetlinks.json). `/app/auth-callback` is EXCLUDED here by
 *    design: it belongs to AuthCallbackActivity and its manifest filter, so
 *    an auth redirect can never be swallowed by content routing (AC4).
 *  • Widget scheme: `com.gradethread.app://widget/<dest>` — the widget host
 *    is deliberately distinct from `auth-callback` so a widget tap can never
 *    be mistaken for an OAuth redirect (the iOS WidgetDeepLink contract).
 */
sealed class DeepLinkRoute {
    data class SalesTab(val inventoryItemId: String?) : DeepLinkRoute()
    object MarketplacesTab : DeepLinkRoute()
    object ReconnectEbay : DeepLinkRoute()
    data class InventoryItem(val id: String) : DeepLinkRoute()
    object InventoryTab : DeepLinkRoute()
    data class NegotiationInbox(val filterItemId: String?) : DeepLinkRoute()
    object GradesList : DeepLinkRoute()
    object CaptureItem : DeepLinkRoute()
    object AddItem : DeepLinkRoute()
    data class SupportTickets(val ticketId: String?) : DeepLinkRoute()

    /** US-1377: the shipping queue, where a mark-shipped push lands. */
    object Shipping : DeepLinkRoute()

    companion object {

        /** Parse an inbound Uri; null = not ours (fall through to other handlers). */
        fun fromUri(uri: Uri?): DeepLinkRoute? {
            if (uri == null) return null
            return when (uri.scheme) {
                "com.gradethread.app" -> when (uri.host) {
                    "widget" -> fromWidget(uri)
                    "shortcut" -> fromShortcut(uri)
                    // auth-callback etc. are not ours
                    else -> null
                }
                "https" -> fromAppLink(uri)
                else -> null
            }
        }

        private fun fromWidget(uri: Uri): DeepLinkRoute? =
            when (uri.pathSegments.firstOrNull()) {
                "marketplaces" -> MarketplacesTab
                "money" -> SalesTab(inventoryItemId = null)
                "shipping" -> Shipping
                else -> null
            }

        /**
         * US-1381: launcher shortcuts.
         *
         * The custom scheme rather than the https app link, and its own host
         * rather than the widget's. App Links are only VERIFIED on the release
         * build, so a static shortcut carrying an https Uri opens a browser on
         * a debug build; a custom scheme has no such competition. Its own host
         * because the two grammars are edited by different features and a
         * shared one drifts.
         */
        private fun fromShortcut(uri: Uri): DeepLinkRoute? =
            when (uri.pathSegments.firstOrNull()) {
                "capture" -> CaptureItem
                "add" -> AddItem
                "money" -> SalesTab(inventoryItemId = null)
                else -> null
            }

        private fun fromAppLink(uri: Uri): DeepLinkRoute? {
            if (uri.host != "gradethread.com") return null
            val segments = uri.pathSegments
            if (segments.firstOrNull() != "app") return null
            return when (segments.getOrNull(1)) {
                // The auth redirect is AuthCallbackActivity's — never content.
                "auth-callback" -> null
                "item" -> segments.getOrNull(2)?.let { InventoryItem(it) }
                "inventory" -> InventoryTab
                "sales" -> SalesTab(inventoryItemId = segments.getOrNull(2))
                "marketplaces" -> MarketplacesTab
                "reconnect" -> ReconnectEbay
                "negotiation" -> NegotiationInbox(filterItemId = segments.getOrNull(2))
                "grades" -> GradesList
                "support" -> SupportTickets(ticketId = segments.getOrNull(2))
                "capture" -> CaptureItem
                "add" -> AddItem
                "shipping" -> Shipping
                else -> null
            }
        }
    }

    /**
     * US-1378: the app-link Uri for this route.
     *
     * The inverse of [fromAppLink], so a push tap travels as the SAME link the
     * app already handles from an email or a widget. One routing table rather
     * than a second, bespoke set of intent extras that can drift from it.
     */
    fun toDeepLinkUri(): String {
        val path = when (this) {
            is InventoryItem -> "item/$id"
            InventoryTab -> "inventory"
            is SalesTab -> inventoryItemId?.let { "sales/$it" } ?: "sales"
            MarketplacesTab -> "marketplaces"
            ReconnectEbay -> "reconnect"
            is NegotiationInbox -> filterItemId?.let { "negotiation/$it" } ?: "negotiation"
            GradesList -> "grades"
            CaptureItem -> "capture"
            AddItem -> "add"
            is SupportTickets -> ticketId?.let { "support/$it" } ?: "support"
            Shipping -> "shipping"
        }
        return "https://gradethread.com/app/$path"
    }

    /**
     * The shell navigation target. Routes point at today's registered graph
     * (section roots + capture placeholders); detail routes refine as their
     * feature stories register real destinations.
     */
    fun toNavRoute(): String = when (this) {
        is SalesTab -> ShellSection.MONEY.route
        MarketplacesTab, ReconnectEbay -> ShellSection.MARKETPLACES.route
        is InventoryItem, InventoryTab -> ShellSection.INVENTORY.route
        // US-1354: a real inbox at last. This used to land on the Marketplaces
        // root, so a push about one listing's offer dropped the seller on the
        // connections screen with no offer in sight.
        is NegotiationInbox -> ShellRoutes.negotiation(filterItemId)
        // US-1341: a real destination at last. Until the grades list existed
        // this fell back to the Home root, so gradethread.com/app/grades — a
        // link we send people — dropped them on a placeholder.
        GradesList -> ShellRoutes.GRADES
        CaptureItem -> "capture/photos"
        AddItem -> ShellSection.ADD.route
        // US-1386: a real destination at last. Until the support inbox existed
        // this fell back to Settings, so a "support replied" push dropped the
        // seller on a preferences screen with no reply in sight.
        is SupportTickets ->
            ticketId?.takeIf { it.isNotBlank() }
                ?.let { ShellRoutes.supportThread(it) }
                ?: ShellRoutes.SUPPORT
        // US-1377: a mark-shipped notification action resolves HERE, on the
        // queue itself, rather than on a tab the seller then has to search.
        Shipping -> ShellRoutes.FULFILLMENT
    }
}
