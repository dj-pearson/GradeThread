import { createMiddleware } from "hono/factory";
import { supabaseAdmin } from "../lib/supabase.ts";

// Admin auth middleware (US-221). Adds an admin-role check on top of the
// existing user auth — must be applied after authMiddleware so c.var.userId
// is already set.

type AdminEnv = {
  Variables: {
    userId: string;
    user: { id: string; email?: string; [key: string]: unknown };
    adminRole: "admin" | "super_admin";
  };
};

const ADMIN_ROLES = new Set(["admin", "super_admin"]);

export const adminAuthMiddleware = createMiddleware<AdminEnv>(async (c, next) => {
  const userId = c.get("userId");
  if (!userId) {
    return c.json({ error: "Unauthenticated" }, 401);
  }

  const { data, error } = await supabaseAdmin
    .from("users")
    .select("role")
    .eq("id", userId)
    .single();

  if (error || !data) {
    return c.json({ error: "User not found" }, 401);
  }
  if (!ADMIN_ROLES.has(data.role)) {
    return c.json({ error: "Admin access required" }, 403);
  }

  c.set("adminRole", data.role as "admin" | "super_admin");
  await next();
});
