import AVFoundation

/// US-2137 AC2: which back camera a macro capture should run on.
///
/// WHY THIS IS ITS OWN FILE AND PURE. The selection is the part that can be
/// WRONG — a bad preference order silently downgrades every macro shot on
/// hardware that could have done better, and nothing about that looks like a
/// failure. The part that needs a real camera is one `DiscoverySession` call.
/// Splitting them means the rule is unit-testable on a machine with no camera,
/// which is also the only kind of machine this repo's CI web lane has.
///
/// THE ORDER IS THE WHOLE POINT. A triple-camera device can focus far closer
/// than a wide-angle one, which is what a serial number or a stitch pitch
/// needs. Dual-wide is the middle case. Wide-angle is what every device has and
/// is exactly today's behaviour — so older hardware degrades to precisely what
/// it does now rather than to an error.
public enum MacroCameraSelection {

    /// Best first. `builtInWideAngleCamera` MUST stay last and MUST stay
    /// present: it is the universal fallback, and dropping it would turn an
    /// older phone from "works as before" into "no video device".
    public static let preferredTypes: [AVCaptureDevice.DeviceType] = [
        .builtInTripleCamera,
        .builtInDualWideCamera,
        .builtInWideAngleCamera,
    ]

    /// Pick the most macro-capable device from what a discovery session found.
    ///
    /// Takes the device TYPES rather than the devices so it can be tested
    /// without AVFoundation handing back hardware. Returns the index into
    /// `available` so the caller can map back to its own array.
    ///
    /// Deliberately preference-ordered rather than "first available": a
    /// DiscoverySession returns devices in ITS own order, and taking the first
    /// one it hands back is how a wide-angle gets chosen on a phone that has a
    /// triple. That is the silent downgrade this exists to prevent.
    public static func indexOfPreferred(
        among available: [AVCaptureDevice.DeviceType]
    ) -> Int? {
        for wanted in preferredTypes {
            if let i = available.firstIndex(of: wanted) { return i }
        }
        // Nothing recognised. Nil rather than 0: picking an arbitrary unknown
        // device is worse than letting the caller fall back deliberately.
        return nil
    }

    /// How close this device can focus, in metres, or nil when it will not say.
    ///
    /// Feeds the AC1 guidance copy — "how close" is a real number on a real
    /// device rather than a guess in a string. AVFoundation reports -1 when the
    /// value is unknown, which is NOT a distance and must not reach the copy.
    public static func focusDistanceMetres(_ raw: Float) -> Float? {
        guard raw.isFinite, raw > 0 else { return nil }
        // Reported in millimetres. A metre value is what the copy layer wants,
        // and doing the conversion here keeps the unit in one place.
        return raw / 1000
    }
}
