import { Hono } from "hono";

export const gradeRoutes = new Hono();

// Submit a garment for grading
gradeRoutes.post("/submit", async (c) => {
  // TODO: Implement grading pipeline
  // 1. Validate auth token
  // 2. Check usage limits
  // 3. Create submission record
  // 4. Upload images to storage
  // 5. Queue AI grading job
  return c.json({
    message: "Grading submission endpoint - not yet implemented",
    status: "pending",
  }, 202);
});

// Get grading status
gradeRoutes.get("/status/:id", async (c) => {
  const id = c.req.param("id");
  // TODO: Fetch submission status from DB
  return c.json({
    id,
    message: "Status endpoint - not yet implemented",
    status: "pending",
  });
});
