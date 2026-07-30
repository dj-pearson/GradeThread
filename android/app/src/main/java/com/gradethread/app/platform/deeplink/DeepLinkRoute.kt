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
                "com.gradethread.app" -> fromWidget(uri)
                "https" -> fromAppLink(uri)
                else -> null
            }
        }

        private fun fromWidget(uri: Uri): DeepLinkRoute? {
            if (uri.host != "widget") return null // auth-callback etc. are not ours
            return when (uri.pathSegments.firstOrNull()) {
                "marketplaces" -> MarketplacesTab
                "money" -> SalesTab(inventoryItemId = null)
                "shipping" -> Shipping
                else -> null
            }
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
        is SupportTickets -> ShellRoutes.SETTINGS
        // US-1377: a mark-shipped notification action resolves HERE, on the
        // queue itself, rather than on a tab the seller then has to search.
        Shipping -> ShellRoutes.FULFILLMENT
    }
}
