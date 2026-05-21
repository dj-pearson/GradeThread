import { Hono } from "hono";

// Image processing pipeline (Sharp-based) and cold-storage archival.
// Expected env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET

export const flipdeskImageRoutes = new Hono();

// Process a freshly uploaded photo: resize variants, EXIF strip, watermark, thumbnail.
// Body: { item_photo_id: string }
flipdeskImageRoutes.post("/process", (c) => {
  return c.json({ error: "Not implemented" }, 501);
});

// Generate background-removed flat-lay variant for an item photo.
flipdeskImageRoutes.post("/remove-bg", (c) => {
  return c.json({ error: "Not implemented" }, 501);
});

// Scheduled: move photos for completed items older than N days from Supabase to R2.
flipdeskImageRoutes.post("/archive", (c) => {
  return c.json({ error: "Not implemented" }, 501);
});
