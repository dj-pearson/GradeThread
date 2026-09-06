// Minimal ambient types for onnxruntime-web (US-3069).
//
// The package ships types at node_modules/onnxruntime-web/types.d.ts but its
// package.json "exports" map does not point at them, so TypeScript resolves the
// import to dist/ort.bundle.min.mjs and reports TS7016 — "there are types … but
// this result could not be resolved when respecting package.json exports".
// That is the library's packaging, not ours, and it is fixed by declaring the
// SURFACE WE USE rather than by turning off the check for the whole file.
//
// Deliberately small: three members. A wider hand-written declaration is a
// second source of truth that drifts from the real library without anything
// failing, and the parts we do not call cannot drift if they are not declared.

declare module "onnxruntime-web" {
  export const env: {
    wasm: {
      /** Where the runtime's .wasm files are served from. Same-origin here. */
      wasmPaths: string;
      numThreads?: number;
      simd?: boolean;
    };
  };

  export class Tensor {
    constructor(type: "float32", data: Float32Array, dims: readonly number[]);
    readonly data: Float32Array;
    readonly dims: readonly number[];
  }

  export interface InferenceSessionLike {
    readonly inputNames: string[];
    readonly outputNames: string[];
    run(
      feeds: Record<string, unknown>,
    ): Promise<Record<string, { data: Float32Array }>>;
  }

  export const InferenceSession: {
    create(
      path: string,
      options?: {
        executionProviders?: string[];
        graphOptimizationLevel?: "disabled" | "basic" | "extended" | "all";
      },
    ): Promise<InferenceSessionLike>;
  };
}
