import SwiftUI
import UIKit

/// US-1575: the native measurement overlay editor — the iOS mirror of the
/// web's MeasurementPhotoEditor. The item's MeasureCard photo renders with
/// each measurement as a draggable line; values are ESTIMATED from the photo
/// via the server calibration homography (px -> card-plane inches, math in
/// ``MeasureGeometry``) and the copy says so until the US-1580 gate is met.
///
/// Server endpoints do all the heavy lifting (calibrate / extract / overlay /
/// correction — see ``MeasureService``); identical save semantics to web:
/// line geometry -> measure_calibration.lines, touched values -> the parent's
/// measurements (persisted by the canvas save path), overlay regenerated
/// best-effort, correction deltas logged for touched auto-measured keys.
struct MeasurementPhotoEditorView: View {
    let itemId: String
    let itemCategory: String?
    let photo: LocalItemPhoto
    /// Current measurement values from the canvas draft (inches).
    let values: [String: Double]
    /// Applies touched values back onto the canvas draft (the canvas save
    /// persists them alongside everything else, same as the web onApply).
    let onApply: ([String: Double]) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var calibration: MeasureService.Calibration?
    @State private var lines: [MeasureGeometry.Line] = []
    @State private var touched: Set<String> = []
    /// The auto pass's proposal per key (for US-1580 correction deltas).
    @State private var proposals: [String: MeasureService.ExtractedMeasurement] = [:]
    @State private var qualityMessage: String?
    @State private var busy: String?
    @State private var imageSize: CGSize?
    /// What the current drag grabbed, and where it was last seen.
    ///
    /// US-2889 AC3: a drag now moves either an ENDPOINT (resize) or the LINE
    /// BODY (reposition). The body case needs the previous point, because it
    /// moves by a delta rather than snapping a point to the finger - snapping
    /// would teleport the line so its midpoint sat under the touch.
    @State private var drag: (grab: MeasureGeometry.Grab, last: CGPoint)?

    private let service = MeasureService()

    private var garmentClass: String {
        MeasureGroupMap.group(forCategory: itemCategory)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let message = qualityMessage {
                        qualityBanner(message)
                    }
                    editorCanvas
                    if calibration != nil {
                        Text("Drag the circles onto the garment, or use Adjust below. Values are estimated from the photo via the MeasureCard — review each before listing.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        adjustSection
                    }
                }
                .padding()
            }
            .navigationTitle("Photo measurements")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    if calibration != nil {
                        Button {
                            Task { await runExtract() }
                        } label: {
                            if busy == "extract" {
                                ProgressView()
                            } else {
                                Label("Auto-measure", systemImage: "sparkles")
                            }
                        }
                        .disabled(busy != nil)
                        // US-2534: the label is swapped for a bare ProgressView
                        // while running, so during the one period the user most
                        // wants to know what is happening VoiceOver had nothing
                        // to read. A stable label survives the swap; the value
                        // carries the state instead.
                        .accessibilityLabel("Auto-measure")
                        .accessibilityValue(busy == "extract" ? "Measuring" : "")
                        Button("Save") {
                            Task { await save() }
                        }
                        .disabled(busy != nil || lines.isEmpty)
                    }
                }
            }
            .task { await bootstrap() }
        }
    }

    // MARK: - Subviews

    private func qualityBanner(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(message, systemImage: "exclamationmark.triangle")
                .font(.callout)
            HStack {
                Button("Try again") {
                    Task { await runCalibrate(force: true) }
                }
                .buttonStyle(.bordered)
                .disabled(busy != nil)
                Text("Or retake the photo with all four squares visible.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .background(.yellow.opacity(0.15), in: RoundedRectangle(cornerRadius: 10))
    }

    @ViewBuilder
    private var editorCanvas: some View {
        if let url = URL(string: photo.photoURL) {
            GeometryReader { geo in
                let scale = displayScale(containerWidth: geo.size.width)
                ZStack(alignment: .topLeading) {
                    AsyncImage(url: url) { image in
                        image.resizable().scaledToFit()
                    } placeholder: {
                        ProgressView()
                    }
                    if let calib = calibration, imageSize != nil {
                        linesOverlay(calibration: calib, scale: scale)
                    }
                }
            }
            .aspectRatio(canvasAspect, contentMode: .fit)
            .onAppear {
                if let w = photo.width, let h = photo.height, w > 0, h > 0 {
                    imageSize = CGSize(width: w, height: h)
                }
            }
        }
    }

    private var canvasAspect: CGFloat {
        guard let size = imageSize, size.height > 0 else { return 4 / 3 }
        return size.width / size.height
    }

    private func displayScale(containerWidth: CGFloat) -> Double {
        guard let size = imageSize, size.width > 0 else { return 1 }
        return Double(containerWidth / size.width)
    }

    private func linesOverlay(calibration: MeasureService.Calibration, scale: Double) -> some View {
        Canvas { context, _ in
            for line in lines {
                let a = CGPoint(x: line.e1.x * scale, y: line.e1.y * scale)
                let b = CGPoint(x: line.e2.x * scale, y: line.e2.y * scale)
                let flaggedKey = proposals[line.key]?.flagged == true && !touched.contains(line.key)
                let color: Color = flaggedKey ? .orange : Color(red: 0.06, green: 0.20, blue: 0.38)
                var path = Path()
                path.move(to: a)
                path.addLine(to: b)
                context.stroke(path, with: .color(.white), lineWidth: 5)
                context.stroke(path, with: .color(color), lineWidth: 2.5)
                for pt in [a, b] {
                    let dot = CGRect(x: pt.x - 7, y: pt.y - 7, width: 14, height: 14)
                    context.fill(Path(ellipseIn: dot), with: .color(.white))
                    context.stroke(Path(ellipseIn: dot), with: .color(color), lineWidth: 2.5)
                }
                let inches = MeasureGeometry.inchesBetween(calibration.homography, line.e1, line.e2)
                let text = Text("\(line.label.components(separatedBy: " (").first ?? line.label) \(MeasureGeometry.formatQuarter(inches))\u{2033}")
                    .font(.caption2.bold())
                    .foregroundStyle(color)
                let mid = CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 14)
                context.draw(text, at: mid)
            }
        }
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { value in
                    handleDrag(at: value.location, scale: scale)
                }
                .onEnded { _ in drag = nil }
        )
    }

    // MARK: - Adjust without dragging (US-2534)

    /// The canvas positions endpoints with a `DragGesture`, which exactly one
    /// input method can reach. This is the same action offered as controls, so
    /// VoiceOver, Switch Control and full keyboard access can perform it.
    ///
    /// NOT an `accessibilityAdjustableAction` on the canvas, which was the
    /// cheaper option and the wrong one: that gives one increment axis for the
    /// whole canvas, and an endpoint needs two axes and a choice of which of the
    /// two endpoints is moving. It also would have stayed invisible to Switch
    /// Control, which needs a real control to select.
    ///
    /// Rendered for EVERYONE rather than gated on a VoiceOver check. A gate
    /// would make the feature depend on a runtime flag nobody tests, and a
    /// sighted user with shaky hands on a phone-sized canvas wants this too.
    @ViewBuilder
    private var adjustSection: some View {
        if !lines.isEmpty, let size = imageSize, let calib = calibration {
            let step = MeasureNudge.step(imgW: size.width, imgH: size.height)
            VStack(alignment: .leading, spacing: 8) {
                Text("Adjust")
                    .font(.subheadline.weight(.semibold))
                // US-2889 AC4: above the per-line rows, because a line that is
                // off screen cannot be fixed by the nudge buttons underneath -
                // they move an endpoint the seller cannot see.
                recoverStrandedRow
                ForEach(lines.indices, id: \.self) { index in
                    adjustRow(index: index, step: step, calibration: calib, size: size)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func adjustRow(
        index: Int,
        step: Double,
        calibration calib: MeasureService.Calibration,
        size: CGSize
    ) -> some View {
        let line = lines[index]
        let inches = MeasureGeometry.inchesBetween(calib.homography, line.e1, line.e2)
        let short = line.label.components(separatedBy: " (").first ?? line.label
        return DisclosureGroup {
            VStack(alignment: .leading, spacing: 6) {
                endpointRow(index: index, end: .e1, name: "Start", step: step, size: size)
                endpointRow(index: index, end: .e2, name: "End", step: step, size: size)
            }
            .padding(.top, 4)
        } label: {
            HStack {
                Text(short).font(.footnote)
                Spacer()
                Text("\(MeasureGeometry.formatQuarter(inches))\u{2033}")
                    .font(.footnote.weight(.medium))
                    .monospacedDigit()
            }
            // One element, so the reader announces the measurement WITH the name
            // instead of two unrelated fragments.
            .accessibilityElement(children: .combine)
            .accessibilityLabel(short)
            .accessibilityValue("\(MeasureGeometry.formatQuarter(inches)) inches")
        }
        .font(.footnote)
        .tint(Color.brandNavy)
    }

    /// US-2889 AC4: one press to bring stranded lines back.
    ///
    /// Shown ONLY when there is something to recover. A permanent button would
    /// be a permanent invitation to move measurements that are exactly where the
    /// seller put them, and the count is what makes the offer legible - "2 lines
    /// are off screen" says what pressing it will touch.
    ///
    /// It says LINES rather than endpoints on purpose: the recovery moves whole
    /// lines and keeps their length, so a seller does not have to wonder whether
    /// their numbers changed.
    @ViewBuilder
    private var recoverStrandedRow: some View {
        let n = strandedCount
        if n > 0 {
            VStack(alignment: .leading, spacing: 4) {
                Text(
                    n == 1
                        ? "1 measurement is off screen."
                        : "\(n) measurements are off screen."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                Button {
                    AppRouter.haptic()
                    recenterStrandedLines()
                } label: {
                    Label("Bring back into view", systemImage: "arrow.down.left.and.arrow.up.right")
                }
                .buttonStyle(.bordered)
                .accessibilityHint(
                    "Moves them back inside the photo without changing what they measure."
                )
            }
        }
    }

    private func endpointRow(
        index: Int,
        end: MeasureGeometry.End,
        name: String,
        step: Double,
        size: CGSize
    ) -> some View {
        HStack(spacing: 6) {
            Text(name)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 44, alignment: .leading)
            ForEach(MeasureNudge.Direction.allCases, id: \.self) { direction in
                Button {
                    nudge(index: index, end: end, direction: direction, step: step, size: size)
                } label: {
                    Image(systemName: arrow(direction))
                        .frame(minWidth: 30, minHeight: 30)
                }
                .buttonStyle(.bordered)
                // Named with the LINE and the ENDPOINT, not just the direction:
                // eight of these are on screen at once and "Left, Left, Left"
                // down the list names nothing.
                .accessibilityLabel(
                    "\(lines[index].label.components(separatedBy: " (").first ?? lines[index].label), \(name), move \(direction.label.lowercased())"
                )
            }
        }
    }

    private func arrow(_ direction: MeasureNudge.Direction) -> String {
        switch direction {
        case .left:  return "arrow.left"
        case .right: return "arrow.right"
        case .up:    return "arrow.up"
        case .down:  return "arrow.down"
        }
    }

    private func nudge(
        index: Int,
        end: MeasureGeometry.End,
        direction: MeasureNudge.Direction,
        step: Double,
        size: CGSize
    ) {
        guard lines.indices.contains(index) else { return }
        let moved = MeasureNudge.nudged(
            end == .e1 ? lines[index].e1 : lines[index].e2,
            direction,
            step: step,
            imgW: size.width,
            imgH: size.height
        )
        if end == .e1 {
            lines[index].e1 = moved
        } else {
            lines[index].e2 = moved
        }
        // The SAME touched bookkeeping the drag path does. Without it a nudged
        // line would not be saved and would not log a correction delta, so the
        // accessible path would silently be a worse path.
        touched.insert(lines[index].key)
        if let calib = calibration {
            let inches = MeasureGeometry.inchesBetween(
                calib.homography, lines[index].e1, lines[index].e2
            )
            UIAccessibility.post(
                notification: .announcement,
                argument: MeasureNudge.announcement(
                    lineLabel: lines[index].label,
                    endName: end == .e1 ? "Start" : "End",
                    inches: inches
                )
            )
        }
    }

    // MARK: - Interaction

    private func handleDrag(at location: CGPoint, scale: Double) {
        guard let size = imageSize, scale > 0 else { return }
        if drag == nil, let grab = MeasureGeometry.hitTest(
            lines: lines, displayPoint: location, scale: scale
        ) {
            drag = (grab, location)
        }
        guard let active = drag else { return }

        switch active.grab {
        case .end(let index, let end):
            guard lines.indices.contains(index) else { return }
            // An endpoint follows the finger, clamped to the frame. Clamping an
            // ENDPOINT is correct here: the seller is resizing, so a shorter
            // line at the edge is the answer they asked for.
            let pt = CGPoint(
                x: min(max(0, location.x / scale), size.width),
                y: min(max(0, location.y / scale), size.height)
            )
            if end == .e1 { lines[index].e1 = pt } else { lines[index].e2 = pt }
            touched.insert(lines[index].key)

        case .line(let index):
            guard lines.indices.contains(index) else { return }
            // The body moves by the DELTA since the last event, and the clamp
            // applies to that delta rather than to the endpoints - clamping the
            // endpoints would shorten and re-angle the line at the edge, which
            // changes the measurement while the seller is only repositioning it.
            lines[index] = MeasureGeometry.translateLine(
                lines[index],
                dx: (location.x - active.last.x) / scale,
                dy: (location.y - active.last.y) / scale,
                imgW: size.width,
                imgH: size.height
            )
            touched.insert(lines[index].key)
        }
        drag = (active.grab, location)
    }

    /// How many lines currently sit outside the frame (US-2889 AC4).
    ///
    /// Non-zero means geometry written before the calibration carry existed: a
    /// portrait-to-landscape turn left endpoints past the new edge, where the
    /// canvas draws them off screen and neither a drag nor a nudge can reach
    /// them, because both need the endpoint visible.
    private var strandedCount: Int {
        guard let size = imageSize else { return 0 }
        return lines.filter {
            MeasureGeometry.isOutsideFrame($0, imgW: size.width, imgH: size.height)
        }.count
    }

    /// Bring every stranded line back into view, keeping each one's length.
    private func recenterStrandedLines() {
        guard let size = imageSize else { return }
        for index in lines.indices
        where MeasureGeometry.isOutsideFrame(lines[index], imgW: size.width, imgH: size.height) {
            lines[index] = MeasureGeometry.recenteredIntoFrame(
                lines[index], imgW: size.width, imgH: size.height
            )
            // The SAME touched bookkeeping a drag does. Without it a recovered
            // line is not saved, and the next open strands it again.
            touched.insert(lines[index].key)
        }
    }

    // MARK: - Server flows

    private func bootstrap() async {
        await runCalibrate(force: false)
    }

    /// AC2: calibrate on open; quality-gate errors show VERBATIM with retake
    /// guidance so a bad card shot is caught at the shelf.
    private func runCalibrate(force: Bool) async {
        busy = "calibrate"
        defer { busy = nil }
        do {
            let calib = try await service.calibrate(photoId: photo.id, force: force)
            calibration = calib
            qualityMessage = nil
            seedLines(from: calib)
        } catch let failure as MeasureService.QualityFailure {
            qualityMessage = failure.message
        } catch {
            qualityMessage = "Could not reach the measurement service. Check your connection and try again."
        }
    }

    private func seedLines(from calib: MeasureService.Calibration) {
        var seeded: [MeasureGeometry.Line] = []
        for (key, stored) in (calib.lines ?? [:]).sorted(by: { $0.key < $1.key }) {
            guard stored.e1.count == 2, stored.e2.count == 2 else { continue }
            seeded.append(MeasureGeometry.Line(
                key: key,
                label: stored.label,
                e1: CGPoint(x: stored.e1[0], y: stored.e1[1]),
                e2: CGPoint(x: stored.e2[0], y: stored.e2[1])
            ))
        }
        lines = seeded
        touched = []
    }

    private func runExtract() async {
        busy = "extract"
        defer { busy = nil }
        do {
            let result = try await service.extract(photoId: photo.id)
            proposals = Dictionary(
                uniqueKeysWithValues: result.measurements.map { ($0.key, $0) })
            var next = values
            for m in result.measurements where result.written.contains(m.key) {
                next[m.key] = m.inches
            }
            onApply(next)
            // Re-pull the calibration so the freshly persisted lines seed.
            await runCalibrate(force: false)
        } catch {
            qualityMessage = "Auto-measure failed. You can still place lines by hand."
        }
    }

    private func save() async {
        guard let calib = calibration else { return }
        busy = "save"
        defer { busy = nil }
        var stored: [String: MeasureService.StoredLine] = [:]
        var next = values
        var corrections: [MeasureService.CorrectionDelta] = []
        for line in lines {
            let inches = MeasureGeometry.inchesBetween(calib.homography, line.e1, line.e2)
            stored[line.key] = MeasureService.StoredLine(
                e1: [line.e1.x, line.e1.y],
                e2: [line.e2.x, line.e2.y],
                inches: inches,
                label: line.label
            )
            if touched.contains(line.key) {
                next[line.key] = inches
                if let proposal = proposals[line.key] {
                    corrections.append(MeasureService.CorrectionDelta(
                        key: line.key,
                        proposed: proposal.inches,
                        final: inches,
                        confidence: proposal.confidence,
                        flagged: proposal.flagged
                    ))
                }
            }
        }
        do {
            try await service.saveLines(photoId: photo.id, calibration: calib, lines: stored)
        } catch {
            qualityMessage = "Saving line positions failed — your values were still applied locally."
        }
        onApply(next)
        touched = []
        // Best-effort side effects, same as web.
        await service.recordCorrections(garmentClass: garmentClass, corrections: corrections)
        await service.regenerateOverlay(itemId: itemId)
        dismiss()
    }
}

/// Category -> measurement group, mirroring the web's `measurementGroupFor`
/// closely enough for telemetry class labels (the server derives its own
/// group for extraction — this only labels correction rows).
enum MeasureGroupMap {
    static func group(forCategory category: String?) -> String {
        let c = (category ?? "").lowercased()
        if c.isEmpty { return "generic" }
        if c.contains("shoe") || c.contains("sneaker") || c.contains("boot") { return "shoes" }
        if c.contains("watch") { return "watch" }
        if c.contains("dress") || c.contains("romper") || c.contains("jumpsuit") { return "dress" }
        if c.contains("jacket") || c.contains("coat") || c.contains("blazer")
            || c.contains("vest") || c.contains("cardigan") { return "outerwear" }
        if c.contains("pant") || c.contains("jean") || c.contains("short")
            || c.contains("skirt") || c.contains("trouser") || c.contains("legging") { return "bottom" }
        if c.contains("shirt") || c.contains("tee") || c.contains("top")
            || c.contains("sweater") || c.contains("hoodie") || c.contains("polo") { return "top" }
        return "generic"
    }
}
