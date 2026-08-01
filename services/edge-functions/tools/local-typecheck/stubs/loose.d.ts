// deno-lint-ignore-file no-explicit-any
//
// `any` is the POINT of this file: it stands in for third-party modules whose
// real .d.ts files live behind registries this sandbox cannot reach. It is a
// local development aid and is never bundled or deployed — but `deno lint` (no
// path argument, as CI runs it) walks the whole project, so the exemption has to
// be declared here rather than assumed.
// Loose stubs so tsc can type-check services/edge-functions/src locally when
// deno.land / esm.sh / jsr are unreachable (this sandbox's egress policy).
//
// Third-party surface is `any`, and noImplicitAny is off in this tsconfig,
// because without the real .d.ts every supabase row callback would be a false
// TS7006. What this DOES still catch is errors in our own code: wrong argument
// counts to our functions, missing union arms, bad property access on our own
// interfaces, unassignable literals. CI's `deno check` remains the real gate.
declare module "*";
declare namespace Anthropic { type Any = any; }
declare namespace Stripe { type Any = any; }
declare namespace Deno { type Any = any; }
declare const Deno: any;
