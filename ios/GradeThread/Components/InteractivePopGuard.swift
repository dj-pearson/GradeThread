import SwiftUI
import UIKit

/// US-1513: blocks the navigation stack's edge-swipe (interactive pop) gesture
/// while `blocked` is true.
///
/// SwiftUI has no first-party control over the pop gesture, so a PUSHED view
/// with unsaved edits (item canvas, specifics editor) could always be popped by
/// a back-swipe — silently discarding the work even when a custom Back button
/// intercepts with a discard confirmation. `navigationBarBackButtonHidden`
/// disables the swipe as a side effect on most OS versions, but not reliably on
/// newer ones; this pins the behavior either way.
///
/// Attach via `.background(InteractivePopGuard(blocked: isDirty))`. The guard
/// re-enables the gesture the moment `blocked` flips false or the view leaves
/// the hierarchy, and only ever re-enables a recognizer it disabled itself.
struct InteractivePopGuard: UIViewControllerRepresentable {
    let blocked: Bool

    func makeUIViewController(context: Context) -> GuardController {
        GuardController()
    }

    func updateUIViewController(_ controller: GuardController, context: Context) {
        controller.blocked = blocked
    }

    final class GuardController: UIViewController {
        var blocked = false { didSet { apply() } }
        /// The recognizer this instance disabled, so tear-down never re-enables
        /// a gesture some other guard (or UIKit itself) turned off.
        private weak var disabledRecognizer: UIGestureRecognizer?

        // The navigation controller isn't reachable until the representable is
        // installed in the hierarchy, so re-apply at every attach point.
        override func didMove(toParent parent: UIViewController?) {
            super.didMove(toParent: parent)
            apply()
        }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            apply()
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            restore()
        }

        private func apply() {
            guard blocked else {
                restore()
                return
            }
            guard let recognizer = navigationController?.interactivePopGestureRecognizer,
                  recognizer.isEnabled
            else { return }
            recognizer.isEnabled = false
            disabledRecognizer = recognizer
        }

        private func restore() {
            disabledRecognizer?.isEnabled = true
            disabledRecognizer = nil
        }
    }
}
