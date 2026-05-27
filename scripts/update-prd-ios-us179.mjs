// Mark US-179 passed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-179": {
    passes: true,
    notes:
      "Done 2026-05-27. Voice dictation + barcode scanner as on-form shortcuts. ios/GradeThread/Speech/SpeechDictation.swift wraps SFSpeechRecognizer + AVAudioEngine, @MainActor @Observable exposing isRecording / recognizedText / isAvailable / lastError. Permission flow requests both speech (SFSpeechRecognizer.requestAuthorization) AND microphone (AVAudioApplication.requestRecordPermission, iOS 17+ API). AVAudioSession configured with .record category + .measurement mode (disables AGC for clearer consonant capture). Partial results stream into recognizedText each frame the recognizer fires; isFinal stops the session. ios/GradeThread/Capture/BarcodeScanner.swift uses AVCaptureSession + AVCaptureVideoDataOutput + VNDetectBarcodesRequest per AC (rather than the simpler AVCaptureMetadataOutput path — same Vision plumbing as the OCR fallback in US-177). Symbologies: ean13/ean8/upce/code128/qr. Detections delivered via AsyncStream<String> with a 1s dedupe window so the consumer's single-shot scan-and-dismiss never fires twice. BarcodeScanView is the modal scanner — back-camera preview + centered viewfinder rectangle, success haptic via UINotificationFeedbackGenerator on first detected code. DetailsIntakeView's SKU row gains a barcode.viewfinder button that fullScreenCovers BarcodeScanView; Notes row gains a mic.fill button (only rendered when SpeechDictation.isAvailable returns true) that toggles dictation. Recognized text streams into form.notes via .onChange(of: dictation.recognizedText) — appends to whatever the user already typed before pressing the mic (notesAnchorBeforeDictation), so dictation extends rather than replaces. View .onDisappear stops dictation if the user swipes away mid-record. NSSpeechRecognitionUsageDescription + NSMicrophoneUsageDescription added to Info.plist; the existing NSCameraUsageDescription was updated to mention barcode scanning so the prompt covers both surfaces. Graceful simulator degradation: dictation.isAvailable returns false on simulators without proper recognizer support (hides the mic button); BarcodeScanView falls through to a clear 'Camera access is off' surface with a deep-link to Settings.",
  },
};

const prd = JSON.parse(fs.readFileSync(PRD, "utf8"));
let touched = 0;
for (const story of prd.userStories) {
  const u = updates[story.id];
  if (!u) continue;
  story.passes = u.passes;
  story.notes = u.notes;
  touched++;
}

fs.writeFileSync(PRD, JSON.stringify(prd, null, 2) + "\n", "utf8");
console.log(`Updated ${touched} stories in prd.json`);
