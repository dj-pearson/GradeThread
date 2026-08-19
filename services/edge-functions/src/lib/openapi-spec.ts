// US-1793: the published OpenAPI 3.1 spec for the public GradeThread B2B API.
//
// Served UNAUTHENTICATED at GET /api/v1/openapi.json (mounted in main.ts before
// the api-key auth middleware) so partners can import it into Postman / codegen
// / a docs renderer. Hand-authored from the actual /api/v1 handlers — keep it in
// lockstep when routes/fields change. The human docs portal is /developers.

// Enum sources (edge): GARMENT_TYPES/GARMENT_CATEGORIES (ai-extract.ts),
// GRADE_IMAGE_TYPES (api-grade-ingest.ts), GRADE_TIERS (grade-pricing.ts),
// API_KEY_SCOPES (api-key.ts).
const GARMENT_TYPES = ["tops", "bottoms", "outerwear", "dresses", "footwear", "accessories"];
const GARMENT_CATEGORIES = [
  "t-shirt", "shirt", "blouse", "sweater", "hoodie", "jacket", "coat", "jeans", "pants", "shorts",
  "skirt", "dress", "sneakers", "boots", "sandals", "hat", "bag", "belt", "scarf",
  "neckwear", "gloves", "other",
];
const IMAGE_TYPES = [
  "front", "back", "label", "label_2", "detail", "detail_2", "detail_3", "detail_4", "defect",
  "measurement_chest", "measurement_waist", "measurement_length", "measurement_sleeve", "measurement_inseam",
];
const GRADE_TIERS = ["standard", "premium", "express"];

const PROD_SERVER = "https://functions.gradethread.com";

// The standard success/error envelope every /api/v1 route returns.
const ENVELOPE_DESC =
  "All responses use the envelope `{ data, error, meta }`. On success `error` is null; " +
  "on failure `data` is null and `error` is `{ message, details }` (some errors add `code`). " +
  "Two exceptions predate the envelope: a 401 from auth returns `{ error: string }`, and a " +
  "429 from the monthly-quota gate returns `{ error, code: \"quota_exceeded\", resets_at }`.";

function envelope(dataSchema: unknown) {
  return {
    type: "object",
    properties: {
      data: dataSchema,
      error: { $ref: "#/components/schemas/ApiError" },
      meta: { type: "object", nullable: true },
    },
    required: ["data", "error", "meta"],
  };
}

const errorResponse = {
  description: "Error envelope",
  content: { "application/json": { schema: envelope({ type: "null" }) } },
};

// US-2563. Declared per-operation rather than as a blanket header so it appears
// in the generated client for the calls that actually charge, which is where an
// integrator needs to see it.
const idempotencyKeyParam = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  schema: { type: "string", maxLength: 255 },
  description:
    "Any unique string (a UUID is fine), reused verbatim on retry. Without one, a retried " +
    "request is a second garment and a second charge. Retained 24 hours.",
};

const idempotencyResponses = {
  "409": {
    ...errorResponse,
    description:
      "A request with this Idempotency-Key is still being processed (IDEMPOTENCY_IN_PROGRESS). " +
      "Honour Retry-After.",
  },
  "422": {
    ...errorResponse,
    description:
      "This Idempotency-Key was already used with a different request body " +
      "(IDEMPOTENCY_KEY_REUSED). Mint a new key per distinct request.",
  },
};

export const OPENAPI_SPEC = {
  openapi: "3.1.0",
  info: {
    title: "GradeThread API",
    version: "1.0.0",
    description:
      "Programmatic AI condition grading for pre-owned clothing. Submit garment photos, " +
      "receive a 1.0–10.0 grade + condition report + shareable certificate. " +
      ENVELOPE_DESC +
      "\n\nAuthenticate with the `X-API-Key` header (Business plan). A free, deterministic " +
      "sandbox lives under `/api/v1/sandbox/*` (same auth + scopes, no credits, no writes). " +
      "Rate limits are per-key, per-minute, split into read (GET) and write budgets; the " +
      "monthly call quota is reported by `GET /api/v1/usage`." +
      "\n\n### Idempotency\n\n" +
      "Every write (`POST`/`PUT`/`PATCH`/`DELETE`) accepts an `Idempotency-Key` header — any " +
      "unique string up to 255 characters, a UUID being the obvious choice. **Send one on every " +
      "call that costs money and reuse it verbatim when you retry.** Grading is billed per " +
      "garment, so a retry without a key is a second garment and a second charge; with a key, " +
      "the original response is replayed and nothing is charged.\n\n" +
      "- Same key, same body, still running → `409` (`IDEMPOTENCY_IN_PROGRESS`) with `Retry-After`.\n" +
      "- Same key, same body, finished → the original status and body, plus `Idempotent-Replay: true`.\n" +
      "- Same key, **different** body → `422` (`IDEMPOTENCY_KEY_REUSED`). Mint a new key per request.\n" +
      "- Only successful (2xx) responses are stored. A `4xx`/`5xx` releases the key so your retry " +
      "is a real attempt.\n\n" +
      "Keys are retained for 24 hours. Beyond that, reconcile with `GET /api/v1/grades` rather " +
      "than resubmitting. Human docs: https://gradethread.com/developers",
    contact: { name: "GradeThread Developer Support", url: "https://gradethread.com/developers" },
  },
  servers: [{ url: PROD_SERVER, description: "Production" }],
  security: [{ ApiKeyAuth: [] }],
  tags: [
    { name: "Grading", description: "Submit garments and retrieve grade reports." },
    { name: "Batch", description: "Grade many garments in one call (durable, async)." },
    { name: "Price Guide", description: "Resale Condition Index value data by item + grade band." },
    { name: "Account", description: "Usage, quota, and webhook configuration." },
    { name: "Sandbox", description: "Free, deterministic mock endpoints for integration testing." },
  ],
  paths: {
    "/api/v1/grades": {
      post: {
        tags: ["Grading"],
        summary: "Submit a garment for grading",
        description:
          "Uploads photos and enqueues grading. Charges via included grades → credits; if neither " +
          "covers it, returns 402. Images may be `url` (https) or base64. Requires `front`, `back` " +
          "and `label`; max 14 images.\n\nA `detail*` close-up is strongly recommended and is NOT " +
          "required (US-2397). Without one the garment is still graded, but confidence is capped at " +
          "0.6 and the submission is routed to human review, so the result takes longer. Send one " +
          "whenever you have it; a garment you cannot photograph up close is still gradable.",
        security: [{ ApiKeyAuth: ["submit"] }],
        parameters: [idempotencyKeyParam],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/GradeSubmissionRequest" } },
          },
        },
        responses: {
          "202": {
            description: "Accepted — grading in progress",
            content: {
              "application/json": {
                schema: envelope({ $ref: "#/components/schemas/GradeAccepted" }),
              },
            },
          },
          "400": errorResponse,
          "402": {
            description: "Payment required — insufficient included grades / credits",
            content: { "application/json": { schema: envelope({ type: "null" }) } },
          },
          "403": errorResponse,
          ...idempotencyResponses,
          "503": { ...errorResponse, description: "Grading temporarily unavailable" },
        },
      },
      get: {
        tags: ["Grading"],
        summary: "List grade submissions",
        security: [{ ApiKeyAuth: ["read"] }],
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
          { name: "status", in: "query", schema: { type: "string" }, description: "Optional status filter." },
        ],
        responses: {
          "200": {
            description: "Paginated list",
            content: {
              "application/json": {
                schema: envelope({ type: "array", items: { $ref: "#/components/schemas/GradeListItem" } }),
              },
            },
          },
        },
      },
    },
    "/api/v1/grades/{id}": {
      get: {
        tags: ["Grading"],
        summary: "Get a grade report",
        security: [{ ApiKeyAuth: ["read"] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": {
            description: "The submission and its grade report (null until completed)",
            content: {
              "application/json": {
                schema: envelope({ $ref: "#/components/schemas/GradeDetail" }),
              },
            },
          },
          "404": errorResponse,
        },
      },
    },
    "/api/v1/grades/batch": {
      post: {
        tags: ["Batch"],
        summary: "Submit up to 50 garments as one batch",
        description:
          "Validates every garment (same rules as a single grade) and rejects the whole batch on any " +
          "invalid one. Returns immediately; each garment is graded in the background and charged " +
          "individually. Poll `GET /api/v1/grades/batch/{id}`. A `grade.completed` webhook also fires " +
          "per garment. Prefer image URLs over base64 in a batch." +
          "\n\n**Send an `Idempotency-Key`.** A retry without one re-enqueues every garment in " +
          "the batch and charges for all of them again.",
        security: [{ ApiKeyAuth: ["submit"] }],
        parameters: [idempotencyKeyParam],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["garments"],
                properties: {
                  garments: {
                    type: "array",
                    minItems: 1,
                    maxItems: 50,
                    items: { $ref: "#/components/schemas/GradeSubmissionRequest" },
                  },
                },
              },
            },
          },
        },
        responses: {
          "202": {
            description: "Batch accepted",
            content: {
              "application/json": {
                schema: envelope({ $ref: "#/components/schemas/BatchAccepted" }),
              },
            },
          },
          "400": errorResponse,
          "403": errorResponse,
          ...idempotencyResponses,
          "503": errorResponse,
        },
      },
    },
    "/api/v1/grades/batch/{id}": {
      get: {
        tags: ["Batch"],
        summary: "Poll a batch's status + per-garment results",
        security: [{ ApiKeyAuth: ["read"] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": {
            description: "Batch status (partial-success semantics)",
            content: {
              "application/json": { schema: envelope({ $ref: "#/components/schemas/BatchStatus" }) },
            },
          },
          "404": errorResponse,
        },
      },
    },
    "/api/v1/items": {
      get: {
        tags: ["Inventory"],
        summary: "List inventory items",
        description:
          "Keyset-paginated. Pass `meta.next_cursor` back as `cursor` for the next page; offset " +
          "paging would skip rows when inventory changes mid-walk. Money is integer cents.",
        security: [{ ApiKeyAuth: ["read"] }],
        parameters: [
          { name: "status", in: "query", schema: { type: "string" }, description: "Pipeline status." },
          { name: "brand", in: "query", schema: { type: "string" } },
          { name: "category", in: "query", schema: { type: "string" } },
          { name: "search", in: "query", schema: { type: "string" }, description: "Text in the item title." },
          { name: "listed", in: "query", schema: { type: "boolean" } },
          { name: "created_after", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "created_before", in: "query", schema: { type: "string", format: "date-time" } },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 25 },
          },
          { name: "cursor", in: "query", schema: { type: "string" }, description: "From a previous meta.next_cursor." },
        ],
        responses: {
          "200": {
            description: "A page of items",
            content: {
              "application/json": {
                schema: envelope({
                  type: "object",
                  properties: {
                    items: { type: "array", items: { $ref: "#/components/schemas/ItemSummary" } },
                  },
                }),
              },
            },
          },
          "400": errorResponse,
          "403": errorResponse,
        },
      },
    },
    "/api/v1/items/{id}": {
      get: {
        tags: ["Inventory"],
        summary: "One item, with photos",
        description:
          "Photo URLs are signed and short-lived for the private bucket. An item that does not exist " +
          "and an item belonging to another account both return 404.",
        security: [{ ApiKeyAuth: ["read"] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": {
            description: "The item",
            content: {
              "application/json": { schema: envelope({ $ref: "#/components/schemas/ItemDetail" }) },
            },
          },
          "403": errorResponse,
          "404": errorResponse,
        },
      },
    },
    "/api/v1/usage": {
      get: {
        tags: ["Account"],
        summary: "This key's monthly usage vs quota",
        security: [{ ApiKeyAuth: ["read"] }],
        responses: {
          "200": {
            description: "Quota state",
            content: {
              "application/json": { schema: envelope({ $ref: "#/components/schemas/QuotaState" }) },
            },
          },
        },
      },
    },
    "/api/v1/webhook": {
      patch: {
        tags: ["Account"],
        summary: "Set or clear the grade-completion webhook URL",
        description:
          "Applies to ALL of your API keys. The URL must be https + publicly routable. GradeThread " +
          "POSTs a `grade.completed` event when a grade finalizes, signed with " +
          "`X-GradeThread-Signature` (HMAC-SHA256 of the body, using that key's hash as the secret). " +
          "See the GradeCompletedEvent schema.",
        security: [{ ApiKeyAuth: ["webhook_manage"] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["webhook_url"],
                properties: {
                  webhook_url: { type: "string", format: "uri", nullable: true, description: "null clears it." },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Updated",
            content: {
              "application/json": {
                schema: envelope({
                  type: "object",
                  properties: {
                    webhook_url: { type: "string", nullable: true },
                    keys_updated: { type: "integer" },
                  },
                }),
              },
            },
          },
          "400": errorResponse,
          "404": errorResponse,
        },
      },
    },
    "/api/v1/price-guide": {
      get: {
        tags: ["Price Guide"],
        summary: "Resale Condition Index catalog",
        security: [{ ApiKeyAuth: ["read"] }],
        responses: {
          "200": {
            description: "Catalog of priced items",
            content: {
              "application/json": {
                schema: envelope({
                  type: "object",
                  properties: {
                    items: { type: "array", items: { $ref: "#/components/schemas/PriceGuideCatalogItem" } },
                  },
                }),
              },
            },
          },
        },
      },
    },
    "/api/v1/price-guide/{slug}": {
      get: {
        tags: ["Price Guide"],
        summary: "Value bands for one item",
        security: [{ ApiKeyAuth: ["read"] }],
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Item value bands by grade",
            content: {
              "application/json": { schema: envelope({ $ref: "#/components/schemas/PriceGuideEntry" }) },
            },
          },
          "404": errorResponse,
        },
      },
    },
    "/api/v1/sandbox/grades": {
      post: {
        tags: ["Sandbox"],
        summary: "Deterministic mock grade (no credits, no writes)",
        description: "Same auth + `submit` scope as production. Returns a deterministic sample grade.",
        security: [{ ApiKeyAuth: ["submit"] }],
        requestBody: {
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: {
          "200": {
            description: "Sample grade (meta.sandbox = true)",
            content: { "application/json": { schema: envelope({ type: "object" }) } },
          },
        },
      },
    },
    // US-2635: the three sandbox reads. The spec described the sandbox in
    // info.description and declared a Sandbox tag, then listed only the POST —
    // so a client generated from this file could submit a mock grade and had no
    // way to fetch the result, which is the whole point of a sandbox.
    "/api/v1/sandbox/grades/{id}": {
      get: {
        tags: ["Sandbox"],
        summary: "Fetch a deterministic mock grade",
        description:
          "Returns a sample grade for any id — deterministic, so the same id always " +
          "yields the same body. Poll this after POST /api/v1/sandbox/grades to " +
          "exercise your read path without spending credits.",
        security: [{ ApiKeyAuth: ["read"] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Sample grade (meta.sandbox = true)",
            content: { "application/json": { schema: envelope({ type: "object" }) } },
          },
          "403": errorResponse,
        },
      },
    },
    "/api/v1/sandbox/price-guide": {
      get: {
        tags: ["Sandbox"],
        summary: "Deterministic mock price-guide catalog",
        description: "The sandbox mirror of GET /api/v1/price-guide. Fixed sample items.",
        security: [{ ApiKeyAuth: ["read"] }],
        responses: {
          "200": {
            description: "Sample catalog (meta.sandbox = true)",
            content: { "application/json": { schema: envelope({ type: "object" }) } },
          },
          "403": errorResponse,
        },
      },
    },
    "/api/v1/sandbox/price-guide/{slug}": {
      get: {
        tags: ["Sandbox"],
        summary: "Deterministic mock value bands for one item",
        description: "The sandbox mirror of GET /api/v1/price-guide/{slug}.",
        security: [{ ApiKeyAuth: ["read"] }],
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Sample value bands (meta.sandbox = true)",
            content: { "application/json": { schema: envelope({ type: "object" }) } },
          },
          "403": errorResponse,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: "apiKey",
        in: "header",
        name: "X-API-Key",
        description:
          "Your secret key, format `gt_sk_` + 64 hex chars. Create + rotate keys in the dashboard " +
          "(Business plan). Scopes: `read`, `submit`, `webhook_manage` — a route requires the scope " +
          "listed on it (the OAuth-scope notation here maps to key scopes).",
      },
    },
    schemas: {
      ApiError: {
        type: "object",
        nullable: true,
        properties: {
          message: { type: "string" },
          code: { type: "string" },
          details: { type: "array", items: {} },
        },
      },
      GradeImage: {
        type: "object",
        required: ["image_type"],
        description: "Provide exactly one of `url` (https) or `base64` (+ `content_type`).",
        properties: {
          image_type: { type: "string", enum: IMAGE_TYPES },
          url: { type: "string", format: "uri" },
          base64: { type: "string" },
          content_type: { type: "string", enum: ["image/jpeg", "image/png", "image/webp"] },
        },
      },
      GradeSubmissionRequest: {
        type: "object",
        required: ["title", "garment_type", "garment_category", "images"],
        properties: {
          title: { type: "string" },
          garment_type: { type: "string", enum: GARMENT_TYPES },
          garment_category: { type: "string", enum: GARMENT_CATEGORIES },
          brand: { type: "string" },
          description: { type: "string" },
          tier: { type: "string", enum: GRADE_TIERS, default: "standard" },
          images: {
            type: "array",
            minItems: 1,
            maxItems: 14,
            description:
              "Must include front, back and label; each image_type at most once. A detail* " +
              "close-up is recommended, not required — without one the grade is capped at 0.6 " +
              "confidence and human-reviewed.",
            items: { $ref: "#/components/schemas/GradeImage" },
          },
        },
      },
      GradeAccepted: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          status: { type: "string", example: "processing" },
          tier: { type: "string", enum: GRADE_TIERS },
          payment_method: { type: "string", enum: ["included", "credits"] },
        },
      },
      GradeReport: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          overall_score: { type: "number", minimum: 1, maximum: 10 },
          grade_tier: { type: "string" },
          fabric_condition_score: { type: "number" },
          structural_integrity_score: { type: "number" },
          cosmetic_appearance_score: { type: "number" },
          functional_elements_score: { type: "number" },
          odor_cleanliness_score: { type: "number" },
          confidence_score: { type: "number", minimum: 0, maximum: 1 },
          ai_summary: { type: "string" },
          detailed_notes: { type: "string" },
          model_version: { type: "string" },
          certificate_id: { type: "string", nullable: true },
          created_at: { type: "string", format: "date-time" },
        },
      },
      GradeDetail: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          status: { type: "string", enum: ["pending", "processing", "completed", "disputed", "failed"] },
          garment_type: { type: "string" },
          garment_category: { type: "string" },
          title: { type: "string" },
          brand: { type: "string", nullable: true },
          description: { type: "string", nullable: true },
          grade_report: { oneOf: [{ $ref: "#/components/schemas/GradeReport" }, { type: "null" }] },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
        },
      },
      GradeListItem: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          status: { type: "string" },
          garment_type: { type: "string" },
          garment_category: { type: "string" },
          title: { type: "string" },
          brand: { type: "string", nullable: true },
          grade: {
            type: "object",
            nullable: true,
            properties: {
              overall_score: { type: "number" },
              grade_tier: { type: "string" },
              confidence_score: { type: "number" },
              certificate_id: { type: "string", nullable: true },
            },
          },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
        },
      },
      BatchAccepted: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          status: { type: "string", example: "running" },
          item_count: { type: "integer" },
        },
      },
      BatchStatus: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          status: { type: "string", enum: ["pending", "running", "completed", "failed", "partial"] },
          item_count: { type: "integer" },
          succeeded_count: { type: "integer" },
          failed_count: { type: "integer" },
          error: { type: "string", nullable: true },
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                status: { type: "string", enum: ["pending", "running", "completed", "failed"] },
                grade_id: { type: "string", format: "uuid", nullable: true },
                error: { type: "string", nullable: true },
              },
            },
          },
        },
      },
      ItemSummary: {
      type: "object",
      description: "The compact projection a list returns. Money is integer cents.",
      properties: {
        id: { type: "string", format: "uuid" },
        item_number: { type: "string", nullable: true },
        title: { type: "string" },
        brand: { type: "string", nullable: true },
        size: { type: "string", nullable: true },
        category: { type: "string", nullable: true },
        status: { type: "string" },
        list_price_cents: { type: "integer", nullable: true },
        grade: { type: "number", nullable: true, description: "1.0-10.0 when graded." },
        grade_label: { type: "string", nullable: true },
        listed: { type: "boolean" },
        photo_count: { type: "integer" },
        created_at: { type: "string", format: "date-time" },
      },
    },
    ItemPhoto: {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        photo_type: { type: "string", nullable: true },
        url: { type: "string", description: "Signed and short-lived for private photos." },
        sort_order: { type: "integer", nullable: true },
      },
    },
    ItemDetail: {
      allOf: [
        { $ref: "#/components/schemas/ItemSummary" },
        {
          type: "object",
          properties: {
            description: { type: "string", nullable: true },
            color: { type: "string", nullable: true },
            style: { type: "string", nullable: true },
            notes: { type: "string", nullable: true },
            container: { type: "string", nullable: true },
            location_bin: { type: "string", nullable: true },
            purchase_price_cents: { type: "integer", nullable: true },
            purchase_date: { type: "string", format: "date-time", nullable: true },
            source_name: { type: "string", nullable: true },
            target_price_cents: { type: "integer", nullable: true },
            measurements: { type: "object", nullable: true },
            certificate_url: { type: "string", nullable: true },
            has_required_photos: { type: "boolean" },
            listing: { type: "object", nullable: true },
            sale: { type: "object", nullable: true },
            photos: { type: "array", items: { $ref: "#/components/schemas/ItemPhoto" } },
            updated_at: { type: "string", format: "date-time" },
          },
        },
      ],
    },
    QuotaState: {
        type: "object",
        properties: {
          quota: { type: "integer", nullable: true, description: "null = unlimited" },
          used: { type: "integer" },
          remaining: { type: "integer", nullable: true },
          exceeded: { type: "boolean" },
          resets_at: { type: "string", format: "date-time", description: "Start of next UTC month" },
        },
      },
      PriceGuideCatalogItem: {
        type: "object",
        properties: {
          slug: { type: "string" },
          brand: { type: "string" },
          label: { type: "string" },
          currency: { type: "string" },
          headlineMedianCents: { type: "integer", nullable: true },
          totalSampleSize: { type: "integer" },
          refreshedAt: { type: "string", format: "date-time", nullable: true },
        },
      },
      PriceBand: {
        type: "object",
        properties: {
          band: { type: "string", enum: ["high", "mid", "low"] },
          label: { type: "string" },
          gradeRange: { type: "string" },
          currency: { type: "string" },
          valueLowCents: { type: "integer", nullable: true },
          valueMedianCents: { type: "integer", nullable: true },
          valueHighCents: { type: "integer", nullable: true },
          valueSampleSize: { type: "integer" },
          sellThrough: { type: "number", nullable: true },
          medianDaysToSell: { type: "integer", nullable: true },
        },
      },
      PriceGuideEntry: {
        type: "object",
        properties: {
          slug: { type: "string" },
          brand: { type: "string" },
          label: { type: "string" },
          categoryId: { type: "string", nullable: true },
          currency: { type: "string" },
          refreshedAt: { type: "string", format: "date-time", nullable: true },
          totalSampleSize: { type: "integer" },
          bands: { type: "array", items: { $ref: "#/components/schemas/PriceBand" } },
          sellThroughScope: { type: "string" },
        },
      },
      GradeCompletedEvent: {
        type: "object",
        description:
          "Delivered to your webhook_url when a grade finalizes. Verify X-GradeThread-Signature " +
          "(HMAC-SHA256 hex of the raw body, secret = the delivering key's hash).",
        properties: {
          event: { type: "string", enum: ["grade.completed"] },
          data: {
            type: "object",
            properties: {
              submission_id: { type: "string", format: "uuid" },
              grade_report: {
                type: "object",
                description: "Leaner than the REST grade_report.",
                properties: {
                  id: { type: "string", format: "uuid" },
                  submission_id: { type: "string", format: "uuid" },
                  overall_score: { type: "number" },
                  grade_tier: { type: "string" },
                  certificate_id: { type: "string", nullable: true },
                  finalized_at: { type: "string", format: "date-time" },
                },
              },
            },
          },
          timestamp: { type: "string", format: "date-time" },
        },
      },
    },
  },
} as const;
