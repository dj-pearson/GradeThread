const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MIN_RESOLUTION = 1200;

export interface ImageValidationError {
  field: string;
  message: string;
}

export interface ImageValidationResult {
  valid: boolean;
  errors: ImageValidationError[];
  width?: number;
  height?: number;
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load image. The file may be corrupted."));
    };
    img.src = url;
  });
}

function getExifOrientation(file: File): Promise<number> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const view = new DataView(e.target?.result as ArrayBuffer);

      // Check for JPEG SOI marker
      if (view.getUint16(0, false) !== 0xffd8) {
        resolve(1);
        return;
      }

      let offset = 2;
      while (offset < view.byteLength) {
        if (offset + 2 > view.byteLength) break;
        const marker = view.getUint16(offset, false);

        // APP1 marker (EXIF)
        if (marker === 0xffe1) {
          // Check for "Exif\0\0" header
          if (offset + 10 > view.byteLength) break;
          if (view.getUint32(offset + 4, false) !== 0x45786966) {
            resolve(1);
            return;
          }

          const tiffOffset = offset + 10;
          if (tiffOffset + 2 > view.byteLength) break;
          const littleEndian = view.getUint16(tiffOffset, false) === 0x4949;

          if (tiffOffset + 8 > view.byteLength) break;
          const ifdOffset = view.getUint32(tiffOffset + 4, littleEndian);
          const ifdStart = tiffOffset + ifdOffset;

          if (ifdStart + 2 > view.byteLength) break;
          const entries = view.getUint16(ifdStart, littleEndian);

          for (let i = 0; i < entries; i++) {
            const entryOffset = ifdStart + 2 + i * 12;
            if (entryOffset + 12 > view.byteLength) break;

            // Tag 0x0112 is Orientation
            if (view.getUint16(entryOffset, littleEndian) === 0x0112) {
              resolve(view.getUint16(entryOffset + 8, littleEndian));
              return;
            }
          }

          // Searched through all IFD entries, no orientation found
          resolve(1);
          return;
        }

        // Skip other markers
        if (offset + 2 > view.byteLength) break;
        if ((marker & 0xff00) !== 0xff00) break;
        if (offset + 4 > view.byteLength) break;
        offset += 2 + view.getUint16(offset + 2, false);
      }

      resolve(1);
    };
    reader.onerror = () => resolve(1);
    // Read only the first 64KB for EXIF data
    reader.readAsArrayBuffer(file.slice(0, 65536));
  });
}

export async function validateImage(
  file: File
): Promise<ImageValidationResult> {
  const errors: ImageValidationError[] = [];

  // Check file type
  if (
    !ALLOWED_MIME_TYPES.includes(file.type as (typeof ALLOWED_MIME_TYPES)[number])
  ) {
    errors.push({
      field: "type",
      message: `Invalid file type "${file.type}". Please upload a JPEG, PNG, or WebP image.`,
    });
  }

  // Check file size
  if (file.size > MAX_FILE_SIZE) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    errors.push({
      field: "size",
      message: `File size (${sizeMB}MB) exceeds the 10MB limit. Please upload a smaller image.`,
    });
  }

  // Check resolution (only if type is valid so we can load it)
  if (errors.length === 0) {
    try {
      const img = await loadImage(file);
      const width = img.naturalWidth;
      const height = img.naturalHeight;

      if (width < MIN_RESOLUTION || height < MIN_RESOLUTION) {
        errors.push({
          field: "resolution",
          message: `Image resolution (${width}x${height}) is too low. Minimum required is ${MIN_RESOLUTION}x${MIN_RESOLUTION} pixels.`,
        });
      }

      return { valid: errors.length === 0, errors, width, height };
    } catch {
      errors.push({
        field: "file",
        message: "Failed to load image. The file may be corrupted.",
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

export async function compressImage(
  file: File,
  maxWidth = 2400,
  quality = 0.85
): Promise<Blob> {
  const img = await loadImage(file);
  const orientation = await getExifOrientation(file);

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to create canvas context.");
  }

  let { naturalWidth: width, naturalHeight: height } = img;

  // Apply EXIF orientation: swap dimensions for rotated orientations
  const needsSwap = orientation >= 5 && orientation <= 8;
  if (needsSwap) {
    [width, height] = [height, width];
  }

  // Scale down if wider than maxWidth
  if (width > maxWidth) {
    const ratio = maxWidth / width;
    width = maxWidth;
    height = Math.round(height * ratio);
  }

  canvas.width = width;
  canvas.height = height;

  // Apply EXIF orientation transform
  switch (orientation) {
    case 2:
      ctx.transform(-1, 0, 0, 1, width, 0);
      break;
    case 3:
      ctx.transform(-1, 0, 0, -1, width, height);
      break;
    case 4:
      ctx.transform(1, 0, 0, -1, 0, height);
      break;
    case 5:
      ctx.transform(0, 1, 1, 0, 0, 0);
      break;
    case 6:
      ctx.transform(0, 1, -1, 0, height, 0);
      break;
    case 7:
      ctx.transform(0, -1, -1, 0, height, width);
      break;
    case 8:
      ctx.transform(0, -1, 1, 0, 0, width);
      break;
  }

  // Draw with correct dimensions for the orientation
  if (needsSwap) {
    ctx.drawImage(img, 0, 0, height, width);
  } else {
    ctx.drawImage(img, 0, 0, width, height);
  }

  // Convert to blob — prefer WebP, fall back to JPEG
  const outputType =
    file.type === "image/png" ? "image/png" : "image/webp";
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (b) resolve(b);
        else reject(new Error("Failed to compress image."));
      },
      outputType,
      quality
    );
  });

  return blob;
}
