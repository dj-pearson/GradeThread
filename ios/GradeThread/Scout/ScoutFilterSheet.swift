import SwiftUI

/// US-3098 — "how much do I need to make, and what is the most I will pay".
///
/// Before this, a scan took a keyword and a brand and returned whatever eBay
/// listed first, graded. The seller's actual question was never askable: they
/// read eight rows and did the arithmetic themselves, on a phone, in a shop.
///
/// Two things about the shape of this sheet are deliberate.
///
/// **Everything persists.** Sourcing is a handful of searches run over and
/// over — the same brands, the same bar. A filter that resets on launch is a
/// filter that gets set once and then abandoned, so these live in
/// `UserDefaults` through ``ScoutStore`` rather than in view state.
///
/// **"Look at" is not "Sort".** The picker here decides which fifty listings
/// eBay hands phase one, before anything is graded. The sort control on the
/// results header reorders the eight that came back. They are one word apart
/// and mean entirely different things, so they are on different screens and
/// neither is called "sort".
struct ScoutFilterSheet: View {
    @ObservedObject var store: ScoutStore
    /// Run the scan on Apply, so the sheet is not a dead end that leaves the
    /// seller to find the button again themselves.
    let onApply: () -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent(String(localized: "Max I will pay")) {
                        TextField("40", text: $store.maxTotalText)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                            .keyboardDoneToolbar()
                    }
                } footer: {
                    // Said plainly because it is the whole point of the field:
                    // a $12 tee with $9 shipping is a $21 item, and it used to
                    // pass a $15 cap that a $20 free-shipping listing failed.
                    Text("The item plus its shipping. A listing eBay gives no shipping for is compared on its price alone.")
                }

                Section {
                    LabeledContent(String(localized: "Min return")) {
                        HStack(spacing: 2) {
                            TextField("30", text: $store.minMarginPctText)
                                .keyboardType(.decimalPad)
                                .multilineTextAlignment(.trailing)
                                .keyboardDoneToolbar()
                            Text(verbatim: "%").foregroundStyle(.secondary)
                        }
                    }
                    LabeledContent(String(localized: "Min profit")) {
                        TextField("20", text: $store.minMarginDollarsText)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                            .keyboardDoneToolbar()
                    }
                } header: {
                    Text("What it has to make")
                } footer: {
                    Text("Both are after eBay's fees. Leave either blank to ignore it.")
                }

                Section {
                    Toggle(String(localized: "Buy It Now only"), isOn: $store.buyItNowOnly)
                    Toggle(String(localized: "Free shipping only"), isOn: $store.freeShippingOnly)
                    Picker(String(localized: "Look at"), selection: $store.browseSort) {
                        ForEach(ScoutStore.BrowseSort.allCases) { sort in
                            Text(sort.label).tag(sort)
                        }
                    }
                } header: {
                    Text("Which listings")
                } footer: {
                    Text("\"Look at\" picks which listings eBay shows us before anything is graded. Sorting the results you get back is on the results list.")
                }

                Section {
                    Button(role: .destructive) {
                        store.clearFilters()
                    } label: {
                        Text("Clear all filters")
                    }
                    .disabled(!store.hasFilters)
                }
            }
            .navigationTitle("Deal filter")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Apply") {
                        dismiss()
                        onApply()
                    }
                    .disabled(!store.canSearch)
                }
            }
        }
    }
}
