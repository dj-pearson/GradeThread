// Throwaway: exercise the 00462-seeded Off-White decoder spec against the real
// engine, using the spec EXACTLY as the migration writes it.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { decodeTagCode } = await import("./src/lib/brand-decoders.ts");
const { decoderSpecsFromPack } = await import("./src/lib/brand-knowledge.ts");

const pack = {
  brand: "Off-White",
  key: "offwhite",
  known: true,
  aliases: [],
  categoryFocus: [],
  authenticationTells: [],
  tagEras: [],
  styles: [],
  decoders: [{
    decoderKind: "style_number",
    description: "seeded",
    pattern:
      "^(?<code>O(?<gender>[MW])[A-Z]{2}\\d{3}(?<season>[A-Z]\\d{2})[A-Z]{3}\\d{3,4})$",
    extractionRules: {
      fieldMap: { code: "styleCode", gender: "gender", season: "season" },
      transforms: { gender: "genderCode" },
      confidence: 0.5,
    },
    examples: [],
  }],
  colorways: [],
  sizingCharts: [],
  source: "db" as const,
};

const specs = decoderSpecsFromPack(pack as never);
console.log("specs built:", specs.length);

for (
  const code of [
    "OMAA038R21FAB001",
    "OWAA049S23FAB002",
    "OMAA038R21FAB0011",
    // negatives — must NOT decode
    "038R21",
    "OXAA038R21FAB001",
    "OMAA38R21FAB001",
    "12345678",
    "OMAA038R21FA001",
  ]
) {
  const r = decodeTagCode("offwhite", code, specs);
  console.log(
    code.padEnd(20),
    r ? JSON.stringify({ styleCode: r.styleCode, gender: r.gender, season: r.season }) : "NO MATCH",
  );
}
