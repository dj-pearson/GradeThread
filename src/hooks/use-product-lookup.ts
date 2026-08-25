// US-598: resolve a scanned barcode/UPC (or a sneaker style code) into product
// data the web intake form can autofill. Mirrors the use-ai-extract hook's
// auth + workspace header plumbing.
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { supabase } from "@/lib/supabase";
import { edgeApiUrl } from "@/lib/edge-api";
import { useAuthStore } from "@/stores/auth-store";

export interface ProductLookupResponse {
  found: boolean;
  code: string;
  sku: string;
  brand: string | null;
  style: string | null;
  productTitle: string | null;
  aspects: Record<string, string[]> | null;
  matchCount: number;
  source: "gtin" | "style";
}

export interface ProductLookupInput {
  code: string;
  categoryId?: string;
}

interface ApiError extends Error {
  status?: number;
}

async function lookupHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error("You must be signed in to look up barcodes.");
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.access_token}`,
    "Content-Type": "application/json",
  };
  const { activeWorkspaceOwnerId, user } = useAuthStore.getState();
  const ownerId = activeWorkspaceOwnerId ?? user?.id;
  if (ownerId) headers["X-Workspace-Owner"] = ownerId;
  return headers;
}

async function lookupProduct(
  input: ProductLookupInput
): Promise<ProductLookupResponse> {
  const res = await fetch(`${edgeApiUrl()}/api/flipdesk/product/lookup`, {
    method: "POST",
    headers: await lookupHeaders(),
    body: JSON.stringify(input),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: ApiError = new Error(json.error || "Barcode lookup failed.");
    err.status = res.status;
    throw err;
  }
  return json as ProductLookupResponse;
}

function lookupErrorToast(err: ApiError): void {
  if (err.status === 422) {
    // Not a recognizable code — saved as a plain SKU, not an error per se.
    toast.message("Couldn't match that code", {
      description: "It'll be saved as the SKU — fill the rest in manually.",
    });
  } else if (err.status === 502) {
    toast.error("Product lookup is temporarily unavailable. Try again shortly.");
  } else {
    toastError(err, "Barcode lookup failed.");
  }
}

export function useProductLookup() {
  return useMutation<ProductLookupResponse, ApiError, ProductLookupInput>({
    mutationFn: lookupProduct,
    onError: lookupErrorToast,
  });
}
