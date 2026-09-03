import SwiftData
import SwiftUI
import WebKit

/// US-3104 — see the listing the way a buyer will, before publishing.
///
/// The web composer has drawn this since US-558. From the phone there was
/// nothing: a seller pushed the listing and found out on eBay. That is the worst
/// possible moment, because by then buyers can see it too and fixing it means a
/// revise round trip.
///
/// READ-ONLY, and deliberately with no publish button of its own. The composer
/// behind it owns committing; a second commit path on a preview is how a seller
/// publishes a draft they were only looking at.
struct EbayViewItemPreviewSheet: View {
    let model: EbayPreviewModel
    /// Which item's photos to draw. The sheet reads them itself rather than
    /// taking them as a parameter: the composer never loaded photos (it has
    /// never needed them), and threading a fetch through it to feed a preview
    /// would put the gallery a layer away from the rows it draws.
    let inventoryItemId: String

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    @Query private var photos: [LocalItemPhoto]

    /// The web's `PreviewViewport`. On a phone the difference is width: eBay's
    /// desktop page is wide enough that a long title sits on one line, and its
    /// mobile page is not, which is exactly the thing worth previewing.
    @State private var viewport: Viewport = .mobile
    @State private var activePhotoId: String?

    enum Viewport: String, CaseIterable, Identifiable {
        case desktop
        case mobile
        var id: String { rawValue }

        var label: String {
            switch self {
            case .desktop: return String(localized: "Desktop")
            case .mobile: return String(localized: "Mobile")
            }
        }

        var systemImage: String {
            switch self {
            case .desktop: return "desktopcomputer"
            case .mobile: return "iphone"
            }
        }

        /// 22rem is the web component's mobile clamp. Desktop is unclamped,
        /// which on a phone means the sheet's own width.
        var maxWidth: CGFloat? {
            self == .mobile ? 352 : nil
        }
    }

    init(model: EbayPreviewModel, inventoryItemId: String) {
        self.model = model
        self.inventoryItemId = inventoryItemId
        let itemId = inventoryItemId
        _photos = Query(
            filter: #Predicate<LocalItemPhoto> { $0.inventoryItemId == itemId },
            sort: \.sortOrder
        )
    }

    /// Photos in publish order, minus the ones that never leave GradeThread.
    ///
    /// US-1571's rule, mirrored: internal photos and the MeasureCard calibration
    /// frame are dropped by the edge at publish, so a preview that showed them
    /// would promise a gallery the buyer never sees — and hide the fact that the
    /// listing is one photo shorter than it looks.
    private var listablePhotos: [LocalItemPhoto] {
        photos.filter { !PhotoSlotType.isNonListable($0.photoType, role: $0.photoRole) }
    }

    private var hero: LocalItemPhoto? {
        listablePhotos.first { $0.id == activePhotoId } ?? listablePhotos.first
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    ForEach(model.sections, id: \.self) { section in
                        self.section(section)
                    }
                }
                .frame(maxWidth: viewport.maxWidth, alignment: .leading)
                .frame(maxWidth: .infinity)
                .padding(16)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("Buyer preview")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .principal) { viewportToggle }
            }
        }
    }

    private var viewportToggle: some View {
        Picker("Layout", selection: $viewport) {
            ForEach(Viewport.allCases) { option in
                Label(option.label, systemImage: option.systemImage).tag(option)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .frame(maxWidth: 220)
    }

    // MARK: - Sections

    @ViewBuilder private func section(_ section: EbayPreviewModel.Section) -> some View {
        switch section {
        case .gallery: gallery
        case .title: titleBlock
        case .condition: conditionBlock
        case .price: priceBlock
        case .specifics: specificsBlock
        case .description: descriptionBlock
        }
    }

    @ViewBuilder private var gallery: some View {
        VStack(alignment: .leading, spacing: 8) {
            ZStack {
                if let hero {
                    ItemPhotoThumbnail(photo: hero, maxDimension: 1200, contentMode: .fit) {
                        Color.secondary.opacity(0.1)
                    }
                } else {
                    // Not decoration. A listing with no publishable photo is one
                    // eBay will refuse, and this is the cheapest place to find
                    // that out.
                    VStack(spacing: 6) {
                        Image(systemName: "photo.badge.exclamationmark")
                            .font(.system(size: 28))
                        Text("No photo will publish")
                            .font(.caption)
                    }
                    .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: viewport == .mobile ? 300 : 360)
            .background(Color.secondary.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))

            if listablePhotos.count > 1 {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(listablePhotos, id: \.id) { photo in
                            Button {
                                activePhotoId = photo.id
                            } label: {
                                ItemPhotoThumbnail(photo: photo, maxDimension: 120) {
                                    Color.secondary.opacity(0.1)
                                }
                                .frame(width: 48, height: 48)
                                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                                .overlay {
                                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                                        .stroke(
                                            photo.id == hero?.id ? Color.brandNavy : .clear,
                                            lineWidth: 2
                                        )
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }

            // The count is read off the rows this sheet drew, not passed in.
            // A caption that could disagree with the gallery above it is worse
            // than no caption: it is the preview being wrong about itself.
            Text("\(listablePhotos.count) photo\(listablePhotos.count == 1 ? "" : "s") will publish")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private var titleBlock: some View {
        Text(model.title.isEmpty ? String(localized: "Untitled listing") : model.title)
            .font(.headline)
            .foregroundStyle(model.title.isEmpty ? Color.secondary : Color.primary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var conditionBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(model.conditionLabel)
                .font(.caption.weight(.medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(Color.brandNavy.opacity(0.08), in: Capsule())
                .foregroundStyle(Color.brandNavy)
            if let note = model.conditionDescription, !note.isEmpty {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var priceBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(model.priceLabel)
                .font(.title2.weight(.bold))
                .monospacedDigit()
            Text(model.formatLabel)
                .font(.caption)
                .foregroundStyle(.secondary)
            if let shipping = model.shippingPolicyName {
                Label(shipping, systemImage: "shippingbox")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if let returns = model.returnPolicyName {
                Label(returns, systemImage: "arrow.uturn.backward")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) { Divider() }
        .overlay(alignment: .bottom) { Divider() }
    }

    private var specificsBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Item specifics")
                .font(.subheadline.weight(.semibold))
            ForEach(model.specifics) { row in
                HStack(alignment: .top) {
                    Text(row.label)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 12)
                    Text(row.value)
                        .font(.caption.weight(.medium))
                        .multilineTextAlignment(.trailing)
                }
                .padding(.vertical, 4)
                Divider()
            }
        }
    }

    @ViewBuilder private var descriptionBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Description")
                .font(.subheadline.weight(.semibold))
            switch model.description {
            case .empty:
                EmptyView()
            case let .plain(text):
                Text(text)
                    .font(.footnote)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        Color.secondary.opacity(0.08),
                        in: RoundedRectangle(cornerRadius: CornerRadius.control)
                    )
            case let .html(body, credentials):
                // The credentials block is real markup, and eBay renders it as
                // markup. Showing the raw tags would be a preview of something
                // no buyer sees.
                PreviewWebView(
                    html: EbayPreviewModel.htmlDocument(
                        body: body,
                        credentials: credentials,
                        dark: colorScheme == .dark
                    )
                )
                .frame(minHeight: 220)
                .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
            }
        }
    }
}

/// A web view that renders one string and goes nowhere.
///
/// US-3104 AC4, and both halves matter. **JavaScript is off**: the description
/// carries a seller's own text and a server-built block, neither of which needs
/// to run code, and a preview that executes script is a preview with an attack
/// surface. **Navigation is refused**: a description can carry a link, and a tap
/// on one inside a preview must not silently load a page inside the composer —
/// there is no address bar and no back button, so the seller would have no way
/// to tell where they had ended up.
private struct PreviewWebView: UIViewRepresentable {
    let html: String

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        config.suppressesIncrementalRendering = true

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        // The description scrolls with the sheet, not inside itself: two nested
        // scroll views on one screen is a description a seller cannot read.
        webView.scrollView.isScrollEnabled = false
        webView.loadHTMLString(html, baseURL: nil)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // Re-load only when the string actually changed. WKWebView reloading on
        // every layout pass would flash the description white on each keystroke
        // behind the sheet.
        guard context.coordinator.loadedHTML != html else { return }
        context.coordinator.loadedHTML = html
        webView.loadHTMLString(html, baseURL: nil)
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var loadedHTML: String?

        /// Allow the `loadHTMLString` load and nothing else.
        ///
        /// `loadHTMLString(_:baseURL: nil)` navigates to `about:blank`, so that
        /// is the one URL permitted. A link tap arrives as `.linkActivated` with
        /// an http(s) URL and is cancelled — swallowed, per the AC, rather than
        /// handed to Safari: this is a preview of what a page will look like,
        /// not a browser.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            let isInitialLoad = navigationAction.navigationType == .other
                && (navigationAction.request.url?.scheme ?? "about") == "about"
            decisionHandler(isInitialLoad ? .allow : .cancel)
        }
    }
}
