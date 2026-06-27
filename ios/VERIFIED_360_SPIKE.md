# Verified 360 — photogrammetric / LiDAR capture spike (US-1281)

> **Status:** spike / decision record. The *decision logic* + server-side badge
> mechanism land in this story; the full guided ARKit capture UI is the
> deliberately-deferred "full build" (AC4: *spike before committing*), which needs
> real-device QA before it ships.

## 1. Goal

A premium, opt-in capture mode that proves **true geometric coverage** of a
garment (multi-angle, and where available depth), so a submission can earn a
stronger **360-Verified** badge and the widest coverage-gated guarantee scope
(US-1279). It builds on the 2D zone-coverage engine (US-1276): on devices that
cannot do 360, capture **falls back** to 2D zone coverage and 360 is **never
required**.

## 2. Approaches evaluated

| Option | API | Depth | Pros | Cons | Verdict |
|---|---|---|---|---|---|
| **A. RealityKit Object Capture** (`ObjectCaptureSession`) | RealityKit, iOS 17+ | Uses LiDAR when present; works without via photogrammetry | First-party guided capture UI, on-device coverage feedback ("more angles needed"), produces a usable coverage metric without us reconstructing a mesh | iPhone requires A14 Bionic + (practically) LiDAR for good results; heavy; large captures | **Chosen** for the full build |
| B. Raw ARKit scene reconstruction (`ARWorldTrackingConfiguration` + `.sceneReconstruction = .mesh`) | ARKit | LiDAR-only | Direct mesh → exact surface-coverage % | LiDAR-only (excludes most non-Pro devices); we'd build the guidance UX ourselves | Fallback signal source only |
| C. Manual multi-angle photo set (no depth) | AVFoundation | none | Works on any camera | No geometric proof — this is just US-1276's 2D coverage with more photos | This **is** the 2D fallback |

**Decision:** Object Capture (A) for capable devices; ARKit scene-reconstruction
support (B) is the capability probe; everything else falls back to the 2D
zone-coverage path (C / US-1276).

## 3. Device matrix

Capability is probed at runtime (`Capture360Support.detectCapability()`), never
hard-coded by model — but the practical matrix is:

| Device class | LiDAR | Verified 360 offered | Capture path |
|---|---|---|---|
| iPhone Pro / Pro Max (12 Pro → present) | ✅ | ✅ (depth-backed) | Object Capture, depth used |
| iPad Pro (2020+) | ✅ | ✅ (depth-backed) | Object Capture, depth used |
| iPhone non-Pro, A14+ (12 → present) | ❌ | ⚠️ photogrammetry-only *(QA-gated)* | Object Capture, no depth |
| iPhone < A14 / older iPad | ❌ | ❌ | **2D zone coverage (US-1276)** |
| Simulator / unsupported | ❌ | ❌ | 2D zone coverage |

The conservative launch gate offers Verified 360 only where the runtime probe
reports both photogrammetry support **and** (for the depth-backed tier) LiDAR;
the photogrammetry-only tier stays behind real-device QA. Falling back is silent
— the seller just doesn't see the 360 option.

## 4. Coverage contract (client → server)

The on-device capture session reports a small, **trusted-but-server-verified**
metrics blob; the server (`verified-360.ts`) is authoritative and re-checks the
thresholds, exactly like Live Capture's device-attestation (US-1283). Sent as the
`capture_360` form field (JSON) on `/api/grade` when `verified_360_opt_in=true`:

```jsonc
{
  "angles": 12,                 // distinct viewpoints captured around the garment
  "geometric_coverage": 0.93,   // device-computed fraction of surface covered (0..1)
  "depth_available": true,      // LiDAR/TrueDepth depth was used
  "capture_complete": true,     // the guided session reported the pass complete
  "device_model": "iPhone16,1"
}
```

**Server thresholds** (mirrored in `Capture360Support` so the UI can preview the
outcome; env-tunable):

- `VERIFIED_360_MIN_ANGLES` (default **8**)
- `VERIFIED_360_MIN_COVERAGE` (default **0.85**)
- `VERIFIED_360_CONFIDENCE_BOOST` (default **0.1**)

When all pass → badge `verified_360`, a bounded grade-confidence boost, and the
stored coverage is upgraded to **geometric-complete** (every applicable zone
documented → widest guarantee scope). Any shortfall → no badge, no penalty,
falls back to the 2D coverage already computed. Never lowers a grade.

## 5. What ships in this story vs. the deferred full build

**Ships now (verifiable on CI):**
- Server evaluator + badge + confidence/coverage boost (`verified-360.ts`,
  wired in `grading-pipeline.ts`), persisted to `grade_reports.verified_360`.
- Migration `00316` — `submissions.verified_360_opt_in` + `submissions.capture_360`
  + `grade_reports.verified_360` + `public_grade_reports.verified_360_badge`.
- Public certificate + SSR + OG badge ("360-Verified").
- iOS pure capability/mode-decision model + thresholds (`Capture360Support.swift`,
  unit-tested) — AC1/AC2 decision logic.

**Deferred (the "full build", needs real-device QA — AC4):**
- The guided `ObjectCaptureSession` capture UI + on-device coverage HUD.
- Wiring the capture metrics into the existing `PhotoIntakeView` submit flow.
- Photogrammetry-only (no-LiDAR) tier enablement after device QA.
