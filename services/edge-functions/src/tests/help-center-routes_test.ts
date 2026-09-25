import "./_env.ts";
// Route-level Help Center behaviour, driven through the real supabase-js client
// against the in-memory PostgREST stand-in.
//
// No tenant-isolation_test.ts case: help_articles and help_feedback have no
// tenant (see the header of help-center_test.ts). The property these routes
// guard is visibility, which is pinned here and in help-center_test.ts.
import { assert, assertEquals } from "@std/assert";
import { buildPatch } from "../routes/help-center.ts";
import { HOSTILE_HELP_BODY, TIPTAP_HELP_BODY } from "./_help-bodies.ts";

Deno.test("H1: buildPatch stores a sanitized body_html", () => {
  const built = buildPatch({ body_html: HOSTILE_HELP_BODY });
  assert("patch" in built);
  const stored = String(built.patch.body_html).toLowerCase();
  for (const bad of ["<script", "onerror", "<meta", "<form", "<input", "evil"]) {
    assert(!stored.includes(bad), `stored body still carries ${bad}`);
  }
});

Deno.test("H1: buildPatch leaves a normal editor body byte-identical", () => {
  const built = buildPatch({ body_html: TIPTAP_HELP_BODY });
  assert("patch" in built);
  assertEquals(built.patch.body_html, TIPTAP_HELP_BODY);
});
