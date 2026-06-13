// Shopify GraphQL Admin API client for FlipDesk (US-710) — the real publish /
// update / delist path, replacing the legacy REST product calls in
// shopify-client.ts. The REST helpers there are kept ONLY for the read/sync feed
// (product status + paid orders); every WRITE now goes through GraphQL because:
//
//   • the modern product model (variants, media, publications, inventory levels)
//     is GraphQL-first and the REST product endpoints are being wound down, and
//   • GraphQL exposes the cost-based rate-limit accounting we have to honor
//     (extensions.cost.throttleStatus) — there is a HARD ceiling of 1000 cost
//     points per query regardless of plan, so anything that could touch >250
//     records must be designed for bulkOperationRunMutation from day one (AC4).
//
// Publish is an idempotent create-or-replace via productSet (which subsumes the
// older productCreate + productVariantsBulkCreate two-step — it sets the product
// and its variant atomically), then inventorySetQuantities scopes stock to a
// Location, then publishablePublish exposes it on the Online Store channel.
//
// All ids on the wire are GIDs (gid://shopify/Product/123). We persist the bare
// NUMERIC id in listings.platform_listing_id so the REST sync/order-matching in
// shopify-client.ts keeps working unchanged.

import { fetchWithTimeout } from "./circuit-breaker.ts";
import { SHOPIFY_API_VERSION } from "./shopify-client.ts";

const GQL_TIMEOUT_MS = 25_000;
const MAX_THROTTLE_RETRIES = 5;

// Shopify caps a single GraphQL query at 1000 cost points regardless of plan.
// Any mutation that could touch more records than this threshold MUST be routed
// through bulkOperationRunMutation instead of a synchronous mutation (AC4).
export const BULK_RECORD_THRESHOLD = 250;

/** True when an op touching `recordCount` records must go through the bulk API. */
export function requiresBulk(recordCount: number): boolean {
  return recordCount > BULK_RECORD_THRESHOLD;
}

// ── GID <-> numeric id ───────────────────────────────────────────────

/** `gid://shopify/Product/123` → `"123"`; passes a bare numeric id through. */
export function gidToNumericId(gid: string | null | undefined): string {
  if (!gid) return "";
  const m = /\/(\d+)(?:\?.*)?$/.exec(gid);
  return m ? m[1]! : gid;
}

/** `"123"` or a full GID → `gid://shopify/<Type>/123`. */
export function toGid(type: string, id: string): string {
  if (id.startsWith("gid://")) return id;
  return `gid://shopify/${type}/${id}`;
}

// ── Cost / throttle accounting (AC4) ─────────────────────────────────

export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export interface GraphqlCost {
  requestedQueryCost: number;
  actualQueryCost: number | null;
  throttleStatus: ThrottleStatus | null;
}

// Pure: pull extensions.cost out of a GraphQL response body. Returns null when
// the server didn't report cost (older versions / errors).
export function parseCost(body: unknown): GraphqlCost | null {
  const cost = (body as { extensions?: { cost?: Record<string, unknown> } })
    ?.extensions?.cost;
  if (!cost) return null;
  const ts = cost.throttleStatus as Record<string, unknown> | undefined;
  return {
    requestedQueryCost: Number(cost.requestedQueryCost ?? 0),
    actualQueryCost: cost.actualQueryCost != null
      ? Number(cost.actualQueryCost)
      : null,
    throttleStatus: ts
      ? {
        maximumAvailable: Number(ts.maximumAvailable ?? 0),
        currentlyAvailable: Number(ts.currentlyAvailable ?? 0),
        restoreRate: Number(ts.restoreRate ?? 0),
      }
      : null,
  };
}

// Pure: a GraphQL response is THROTTLED when it carries an error with
// extensions.code === "THROTTLED" (Shopify returns HTTP 200 for these).
export function isThrottled(body: unknown): boolean {
  const errors = (body as { errors?: Array<{ extensions?: { code?: string } }> })
    ?.errors;
  if (!Array.isArray(errors)) return false;
  return errors.some((e) => e?.extensions?.code === "THROTTLED");
}

// Pure: how long to wait before retrying a throttled query. We honor Shopify's
// leaky-bucket accounting — wait until the bucket has restored enough points for
// the requested cost — then apply exponential backoff per attempt so repeated
// throttles back off rather than hammering. Clamped to a sane ceiling.
export function computeThrottleWaitMs(
  cost: GraphqlCost | null,
  attempt: number,
): number {
  const ts = cost?.throttleStatus;
  let bucketMs = 1000;
  if (ts && ts.restoreRate > 0) {
    const needed = (cost?.requestedQueryCost ?? 0) - ts.currentlyAvailable;
    if (needed > 0) bucketMs = (needed / ts.restoreRate) * 1000;
  }
  const base = Math.max(bucketMs, 500);
  const backed = base * Math.pow(2, Math.max(0, attempt));
  return Math.min(Math.round(backed), 30_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface GraphqlError {
  message: string;
  field?: string[] | null;
}

export class ShopifyGraphqlError extends Error {
  readonly userErrors: GraphqlError[];
  readonly status: number;
  constructor(message: string, userErrors: GraphqlError[] = [], status = 502) {
    super(message);
    this.name = "ShopifyGraphqlError";
    this.userErrors = userErrors;
    this.status = status;
  }
}

interface GraphqlResponse<T> {
  data: T;
  cost: GraphqlCost | null;
}

// Core GraphQL caller. Reads extensions.cost.throttleStatus and retries with
// exponential backoff on THROTTLED (AC4); surfaces top-level GraphQL errors as a
// thrown ShopifyGraphqlError. userErrors on individual mutations are handled by
// the typed wrappers below (they know which payload field carries them).
export async function shopifyGraphql<T = Record<string, unknown>>(
  shop: string,
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<GraphqlResponse<T>> {
  const url = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  let lastCost: GraphqlCost | null = null;

  for (let attempt = 0; attempt <= MAX_THROTTLE_RETRIES; attempt++) {
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ query, variables }),
      },
      GQL_TIMEOUT_MS,
    );

    // A 429 (or 5xx) at the HTTP layer is also retryable with backoff.
    if (res.status === 429 || res.status >= 500) {
      await res.body?.cancel();
      if (attempt < MAX_THROTTLE_RETRIES) {
        await sleep(computeThrottleWaitMs(lastCost, attempt));
        continue;
      }
      throw new ShopifyGraphqlError(
        `Shopify GraphQL transport error (${res.status}).`,
        [],
        res.status,
      );
    }
    if (!res.ok) {
      const text = await res.text();
      throw new ShopifyGraphqlError(
        `Shopify GraphQL failed (${res.status}): ${text}`,
        [],
        res.status,
      );
    }

    const body = await res.json() as {
      data?: T;
      errors?: Array<{ message?: string; extensions?: { code?: string } }>;
    };
    lastCost = parseCost(body);

    if (isThrottled(body)) {
      if (attempt < MAX_THROTTLE_RETRIES) {
        await sleep(computeThrottleWaitMs(lastCost, attempt));
        continue;
      }
      throw new ShopifyGraphqlError(
        "Shopify GraphQL throttled — retries exhausted.",
        [],
        429,
      );
    }

    if (Array.isArray(body.errors) && body.errors.length > 0) {
      const msg = body.errors.map((e) => e.message ?? "error").join("; ");
      throw new ShopifyGraphqlError(`Shopify GraphQL error: ${msg}`);
    }
    if (body.data == null) {
      throw new ShopifyGraphqlError("Shopify GraphQL returned no data.");
    }
    return { data: body.data, cost: lastCost };
  }
  // Unreachable: the loop either returns or throws.
  throw new ShopifyGraphqlError("Shopify GraphQL retries exhausted.", [], 429);
}

function throwOnUserErrors(errs: GraphqlError[] | undefined, op: string): void {
  if (errs && errs.length > 0) {
    throw new ShopifyGraphqlError(
      `Shopify ${op} failed: ${errs.map((e) => e.message).join("; ")}`,
      errs,
    );
  }
}

// ── Publish payload (pure builder, unit-tested) ──────────────────────

export interface ShopifyGraphqlProductInput {
  /** Existing product GID/numeric id for an update; omit/empty to create. */
  productId?: string | null;
  title: string;
  descriptionHtml: string;
  vendor?: string | null;
  productType?: string | null;
  tags?: string[];
  price: number;
  sku?: string | null;
  imageUrls?: string[];
  /** ACTIVE = eligible to be published; DRAFT = hidden. */
  status?: "ACTIVE" | "DRAFT";
}

// Builds the ProductSetInput variables for the productSet mutation. productSet
// is an idempotent create-or-replace: with an `id` it replaces that product,
// without one it creates. It sets the single variant (price/sku/tracked stock)
// and ingests images by public `src` URL inline.
export function buildProductSetVariables(
  input: ShopifyGraphqlProductInput,
): { input: Record<string, unknown> } {
  const productInput: Record<string, unknown> = {
    title: input.title,
    descriptionHtml: input.descriptionHtml ?? "",
    status: input.status ?? "ACTIVE",
    variants: [
      {
        price: input.price.toFixed(2),
        ...(input.sku ? { sku: input.sku } : {}),
        inventoryItem: { tracked: true },
      },
    ],
  };
  if (input.productId) {
    productInput.id = toGid("Product", gidToNumericId(input.productId));
  }
  if (input.vendor) productInput.vendor = input.vendor;
  if (input.productType) productInput.productType = input.productType;
  if (input.tags && input.tags.length > 0) productInput.tags = input.tags;
  const images = (input.imageUrls ?? []).filter((u) => !!u);
  if (images.length > 0) {
    productInput.files = images.map((src) => ({
      originalSource: src,
      contentType: "IMAGE",
    }));
  }
  return { input: productInput };
}

const PRODUCT_SET_MUTATION = `
mutation productSet($input: ProductSetInput!) {
  productSet(input: $input, synchronous: true) {
    product {
      id
      handle
      onlineStoreUrl
      variants(first: 1) { nodes { id inventoryItem { id } } }
    }
    userErrors { field message }
  }
}`;

export interface ProductSetResult {
  productGid: string;
  handle: string | null;
  onlineStoreUrl: string | null;
  variantGid: string | null;
  inventoryItemGid: string | null;
}

export async function productSet(
  shop: string,
  token: string,
  input: ShopifyGraphqlProductInput,
): Promise<ProductSetResult> {
  const { data } = await shopifyGraphql<{
    productSet: {
      product: {
        id: string;
        handle: string | null;
        onlineStoreUrl: string | null;
        variants: { nodes: Array<{ id: string; inventoryItem: { id: string } }> };
      } | null;
      userErrors: GraphqlError[];
    };
  }>(shop, token, PRODUCT_SET_MUTATION, buildProductSetVariables(input));
  throwOnUserErrors(data.productSet.userErrors, "productSet");
  const p = data.productSet.product;
  if (!p) throw new ShopifyGraphqlError("Shopify productSet returned no product.");
  const variant = p.variants.nodes[0];
  return {
    productGid: p.id,
    handle: p.handle,
    onlineStoreUrl: p.onlineStoreUrl,
    variantGid: variant?.id ?? null,
    inventoryItemGid: variant?.inventoryItem?.id ?? null,
  };
}

// ── Inventory (scoped to a Location) ─────────────────────────────────

const PRIMARY_LOCATION_QUERY = `
query primaryLocation {
  locations(first: 1, query: "status:active") { nodes { id } }
}`;

export async function resolvePrimaryLocationId(
  shop: string,
  token: string,
): Promise<string | null> {
  const { data } = await shopifyGraphql<{
    locations: { nodes: Array<{ id: string }> };
  }>(shop, token, PRIMARY_LOCATION_QUERY);
  return data.locations.nodes[0]?.id ?? null;
}

const INVENTORY_SET_MUTATION = `
mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
  inventorySetQuantities(input: $input) {
    inventoryAdjustmentGroup { createdAt reason }
    userErrors { field message }
  }
}`;

// Sets the on-hand "available" quantity for an inventory item AT a specific
// Location (AC1). ignoreCompareQuantity skips the optimistic-concurrency check —
// we are the source of truth for a single-unit reseller item.
export async function inventorySetQuantities(
  shop: string,
  token: string,
  inventoryItemGid: string,
  locationGid: string,
  quantity: number,
): Promise<void> {
  const { data } = await shopifyGraphql<{
    inventorySetQuantities: { userErrors: GraphqlError[] };
  }>(shop, token, INVENTORY_SET_MUTATION, {
    input: {
      name: "available",
      reason: "correction",
      ignoreCompareQuantity: true,
      quantities: [
        {
          inventoryItemId: inventoryItemGid,
          locationId: locationGid,
          quantity: Math.max(0, Math.round(quantity)),
        },
      ],
    },
  });
  throwOnUserErrors(data.inventorySetQuantities.userErrors, "inventorySetQuantities");
}

// ── Publication (Online Store channel) ───────────────────────────────

const PUBLICATIONS_QUERY = `
query publications {
  publications(first: 25) { nodes { id name } }
}`;

// Resolves the Online Store publication (sales channel) id. Returns null when
// the store has no Online Store channel installed (headless-only shops).
export async function resolveOnlineStorePublicationId(
  shop: string,
  token: string,
): Promise<string | null> {
  const { data } = await shopifyGraphql<{
    publications: { nodes: Array<{ id: string; name: string }> };
  }>(shop, token, PUBLICATIONS_QUERY);
  const online = data.publications.nodes.find(
    (n) => n.name.toLowerCase() === "online store",
  );
  return online?.id ?? data.publications.nodes[0]?.id ?? null;
}

const PUBLISH_MUTATION = `
mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $input) {
    publishable { availablePublicationsCount { count } }
    userErrors { field message }
  }
}`;

// publishablePublish is the current (non-deprecated) form of the legacy
// productPublish mutation — it pushes the product live on the given channel(s).
export async function publishToChannel(
  shop: string,
  token: string,
  productGid: string,
  publicationGid: string,
): Promise<void> {
  const { data } = await shopifyGraphql<{
    publishablePublish: { userErrors: GraphqlError[] };
  }>(shop, token, PUBLISH_MUTATION, {
    id: productGid,
    input: [{ publicationId: publicationGid }],
  });
  throwOnUserErrors(data.publishablePublish.userErrors, "publishablePublish");
}

const UNPUBLISH_MUTATION = `
mutation publishableUnpublish($id: ID!, $input: [PublicationInput!]!) {
  publishableUnpublish(id: $id, input: $input) {
    userErrors { field message }
  }
}`;

// Soft delist: remove the product from a channel without deleting it (AC3's
// "unpublish" alternative to productDelete). Used when we want to keep the
// product record but pull it from the storefront.
export async function unpublishFromChannel(
  shop: string,
  token: string,
  productGid: string,
  publicationGid: string,
): Promise<void> {
  const { data } = await shopifyGraphql<{
    publishableUnpublish: { userErrors: GraphqlError[] };
  }>(shop, token, UNPUBLISH_MUTATION, {
    id: productGid,
    input: [{ publicationId: publicationGid }],
  });
  throwOnUserErrors(data.publishableUnpublish.userErrors, "publishableUnpublish");
}

const PRODUCT_DELETE_MUTATION = `
mutation productDelete($input: ProductDeleteInput!) {
  productDelete(input: $input) {
    deletedProductId
    userErrors { field message }
  }
}`;

// Hard delist (AC3): delete the product. Idempotent — a "product not found"
// userError is treated as already-gone so a double-delist (e.g. auto-end after a
// manual end) succeeds.
export async function deleteProductGraphql(
  shop: string,
  token: string,
  productId: string,
): Promise<"deleted" | "gone"> {
  const { data } = await shopifyGraphql<{
    productDelete: { deletedProductId: string | null; userErrors: GraphqlError[] };
  }>(shop, token, PRODUCT_DELETE_MUTATION, {
    input: { id: toGid("Product", gidToNumericId(productId)) },
  });
  const errs = data.productDelete.userErrors;
  if (errs && errs.length > 0) {
    const notFound = errs.some((e) =>
      /not found|does not exist|doesn't exist/i.test(e.message)
    );
    if (notFound) return "gone";
    throwOnUserErrors(errs, "productDelete");
  }
  return "deleted";
}

// ── Orchestrated publish ─────────────────────────────────────────────

export interface ShopifyPublishResult {
  /** Bare numeric product id for listings.platform_listing_id (REST-compatible). */
  productId: string;
  /** Bare numeric variant id (stored in listings.platform_offer_id). */
  variantId: string | null;
  handle: string | null;
  listingUrl: string | null;
}

// Full create-or-replace publish: productSet → inventorySetQuantities (scoped to
// the primary Location) → publishablePublish to the Online Store. Inventory and
// channel-publish are best-effort: a product that was set but not stocked/
// published is still returned (the caller has its id and can re-push), so a
// transient failure in step 2/3 doesn't orphan a created product.
export async function publishShopifyProduct(
  shop: string,
  token: string,
  input: ShopifyGraphqlProductInput,
  quantity = 1,
): Promise<ShopifyPublishResult> {
  const set = await productSet(shop, token, input);

  if (set.inventoryItemGid) {
    try {
      const locationGid = await resolvePrimaryLocationId(shop, token);
      if (locationGid) {
        await inventorySetQuantities(
          shop,
          token,
          set.inventoryItemGid,
          locationGid,
          quantity,
        );
      }
    } catch (err) {
      console.warn(
        "[shopify-graphql] inventorySetQuantities failed (continuing):",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if ((input.status ?? "ACTIVE") === "ACTIVE") {
    try {
      const publicationGid = await resolveOnlineStorePublicationId(shop, token);
      if (publicationGid) {
        await publishToChannel(shop, token, set.productGid, publicationGid);
      }
    } catch (err) {
      console.warn(
        "[shopify-graphql] publishablePublish failed (continuing):",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const productId = gidToNumericId(set.productGid);
  return {
    productId,
    variantId: set.variantGid ? gidToNumericId(set.variantGid) : null,
    handle: set.handle,
    listingUrl: set.onlineStoreUrl ?? (set.handle
      ? `https://${shop}/products/${set.handle}`
      : null),
  };
}

// ── Bulk operations (>250 records, AC4) ──────────────────────────────
//
// The synchronous mutations above are correct for one garment at a time. Any
// caller that needs to publish/update MORE than BULK_RECORD_THRESHOLD records in
// one shot MUST NOT loop them synchronously (it would blow the 1000-point query
// ceiling); it stages a JSONL file and runs the mutation in bulk. These helpers
// are the building blocks for that path.

const STAGED_UPLOADS_CREATE = `
mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}`;

export interface StagedUploadTarget {
  url: string;
  resourceUrl: string;
  parameters: Array<{ name: string; value: string }>;
}

export async function stagedUploadsCreate(
  shop: string,
  token: string,
  filename: string,
  mimeType: string,
  byteSize: number,
): Promise<StagedUploadTarget> {
  const { data } = await shopifyGraphql<{
    stagedUploadsCreate: {
      stagedTargets: StagedUploadTarget[];
      userErrors: GraphqlError[];
    };
  }>(shop, token, STAGED_UPLOADS_CREATE, {
    input: [
      {
        resource: "BULK_MUTATION_VARIABLES",
        filename,
        mimeType,
        httpMethod: "POST",
        fileSize: String(byteSize),
      },
    ],
  });
  throwOnUserErrors(data.stagedUploadsCreate.userErrors, "stagedUploadsCreate");
  const target = data.stagedUploadsCreate.stagedTargets[0];
  if (!target) {
    throw new ShopifyGraphqlError("Shopify stagedUploadsCreate returned no target.");
  }
  return target;
}

const BULK_RUN_MUTATION = `
mutation bulkOperationRunMutation($mutation: String!, $stagedUploadPath: String!) {
  bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {
    bulkOperation { id status }
    userErrors { field message }
  }
}`;

export interface BulkOperationHandle {
  id: string;
  status: string;
}

// Kicks off a bulk mutation over a previously-staged JSONL of variables. The
// staged path comes from stagedUploadsCreate + the actual file POST. Poll
// currentBulkOperation() until status is COMPLETED.
export async function bulkOperationRunMutation(
  shop: string,
  token: string,
  mutation: string,
  stagedUploadPath: string,
): Promise<BulkOperationHandle> {
  const { data } = await shopifyGraphql<{
    bulkOperationRunMutation: {
      bulkOperation: BulkOperationHandle | null;
      userErrors: GraphqlError[];
    };
  }>(shop, token, BULK_RUN_MUTATION, { mutation, stagedUploadPath });
  throwOnUserErrors(
    data.bulkOperationRunMutation.userErrors,
    "bulkOperationRunMutation",
  );
  const op = data.bulkOperationRunMutation.bulkOperation;
  if (!op) throw new ShopifyGraphqlError("Shopify bulk operation did not start.");
  return op;
}

const CURRENT_BULK_OP = `
query currentBulkOperation {
  currentBulkOperation(type: MUTATION) {
    id status errorCode objectCount url
  }
}`;

export interface BulkOperationStatus {
  id: string;
  status: string;
  errorCode: string | null;
  objectCount: number | null;
  url: string | null;
}

export async function currentBulkOperation(
  shop: string,
  token: string,
): Promise<BulkOperationStatus | null> {
  const { data } = await shopifyGraphql<{
    currentBulkOperation: {
      id: string;
      status: string;
      errorCode: string | null;
      objectCount: string | null;
      url: string | null;
    } | null;
  }>(shop, token, CURRENT_BULK_OP);
  const op = data.currentBulkOperation;
  if (!op) return null;
  return {
    id: op.id,
    status: op.status,
    errorCode: op.errorCode,
    objectCount: op.objectCount != null ? Number(op.objectCount) : null,
    url: op.url,
  };
}
