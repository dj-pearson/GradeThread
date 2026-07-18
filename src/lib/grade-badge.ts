// Client-side compositing of a GradeThread grade badge onto a listing photo.
//
// ⚠ NOT WIRED, AND DELIBERATELY SO — DO NOT "RESTORE" IT.
//
// compositeGradeBadge has no callers (verified 2026-07-18). Badge-on-photo was
// dropped from the publish path in commit 8e1802a6 as an eBay-POLICY decision:
// third-party-grading marks burned onto listing imagery are what the policy
// objects to. The grade authority signal is now TEXT ONLY, written into the
// listing DESCRIPTION by applyGradeListingPromotion on the edge.
//
// Re-wiring this would reintroduce a policy problem someone already thought
// about. If badge imagery is wanted again, that is a policy question first.
// The edge counterpart services/edge-functions/src/lib/grade-badge.ts is dead
// for the same reason.
//
// (Historic) Used by the listing composer (US-118) to produce an eBay-ready
// hero image with the grade burned into a corner.

// Refreshed media-kit palette (design.md §2A): Obsidian Navy anchor + Vibrant
// Crimson accent. Keep these in sync with src/index.css brand tokens.
const NAVY = "#0C1E36";
const RED = "#F03D5F";

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Required so the canvas stays untainted and toBlob can read it back.
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error("Could not load the photo for badge compositing."));
    img.src = url;
  });
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Draws the grade badge into the bottom-right corner of `photoUrl` and
// returns the result as a JPEG blob.
export async function compositeGradeBadge(
  photoUrl: string,
  grade: number,
  label: string | null,
): Promise<Blob> {
  const img = await loadImage(photoUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context is unavailable.");

  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // Size the badge relative to the image's shorter edge so it scales well.
  const unit = Math.min(canvas.width, canvas.height);
  const pad = unit * 0.04;
  const badgeW = unit * 0.36;
  const badgeH = badgeW * 0.46;
  const x = canvas.width - badgeW - pad;
  const y = canvas.height - badgeH - pad;
  const radius = badgeH * 0.16;

  ctx.save();

  // Soft drop shadow under the card.
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = badgeH * 0.16;
  ctx.shadowOffsetY = badgeH * 0.05;
  ctx.fillStyle = NAVY;
  roundRectPath(ctx, x, y, badgeW, badgeH, radius);
  ctx.fill();
  ctx.shadowColor = "transparent";

  // Red accent stripe down the left edge.
  ctx.fillStyle = RED;
  roundRectPath(ctx, x, y, badgeW * 0.07, badgeH, radius);
  ctx.fill();

  const textX = x + badgeW * 0.16;
  ctx.fillStyle = "#FFFFFF";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  ctx.font = `700 ${badgeH * 0.18}px Inter, Arial, sans-serif`;
  ctx.fillText("GRADETHREAD VERIFIED", textX, y + badgeH * 0.28);

  ctx.font = `700 ${badgeH * 0.4}px Inter, Arial, sans-serif`;
  ctx.fillText(`${grade.toFixed(1)} / 10`, textX, y + badgeH * 0.62);

  if (label) {
    ctx.font = `500 ${badgeH * 0.15}px Inter, Arial, sans-serif`;
    ctx.fillText(label.toUpperCase(), textX, y + badgeH * 0.85);
  }

  ctx.restore();

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("Failed to export the badged photo.")),
      "image/jpeg",
      0.92,
    );
  });
}
