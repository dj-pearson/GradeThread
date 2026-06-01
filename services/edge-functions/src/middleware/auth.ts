import { createMiddleware } from "hono/factory";
import type { User } from "@supabase/supabase-js";
import { supabaseAdmin } from "../lib/supabase.ts";

type AuthEnv = {
  Variables: {
    user: User;
    userId: string;
  };
};

export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const token = authHeader.replace("Bearer ", "");

  const { data, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !data.user) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  c.set("user", data.user);
  c.set("userId", data.user.id);

  await next();
});
