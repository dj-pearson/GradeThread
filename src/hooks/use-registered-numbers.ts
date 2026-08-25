import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { edgeFetch } from "@/lib/edge-fetch";

// US-2808: the client for /api/admin/registered-numbers, which US-2244 built and
// nothing ever called.
//
// WHAT THIS QUEUE IS. An RN or CA number is the FTC-registered identifier
// printed on a garment's care tag, and it names the company that made or imported
// the garment. The FTC registry has no API and no bulk download, so coverage
// cannot be imported — it has to be resolved by a person, one number at a time.
//
// The queue is not hypothetical: grading-pipeline.ts already records a sighting
// for every tag it reads (assessRegisteredNumber then
// recordRegisteredNumberSighting), so it has been filling on live traffic with
// nowhere to be seen. Ordering by sighting_count is what makes the work finite —
// resolve the number that appears on the most tags first.
//
// Every route here is gated on the edge by adminAuthMiddleware (admin JWT +
// AAL2) AND a whole-router content:publish scope check.

export interface RegisteredNumberSighting {
  registry_key: string;
  kind: "RN" | "CA";
  digits: string;
  sighting_count: number;
  declared_brands: string[] | null;
  resolved: boolean;
  first_seen_at: string | null;
  last_seen_at: string | null;
}

export interface RegisteredNumberRegistryRow {
  registry_key: string;
  company_name: string | null;
  brand_keys: string[] | null;
  source_url: string | null;
  notes: string | null;
  verified: boolean;
  updated_at: string | null;
}

export interface RegisteredNumberQueue {
  sightings: RegisteredNumberSighting[];
  registry: RegisteredNumberRegistryRow[];
}

export interface ResolveRegisteredNumberInput {
  registry_key: string;
  company_name?: string;
  brand_keys?: string[];
  source_url?: string;
  notes?: string;
  verified?: boolean;
}

async function jfetch<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const res = await edgeFetch(path, { ...init, json: init?.json, silentGate: true });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (data as { error?: string }).error || `${res.status} ${res.statusText}`,
    );
  }
  return data as T;
}

const QUEUE_KEY = "registered_numbers";

export function useRegisteredNumbers(includeResolved: boolean) {
  return useQuery({
    // includeResolved is part of the key, not a filter applied after the fetch:
    // the server decides what the queue contains, and caching one response under
    // both meanings would show a resolved-inclusive list as the open queue.
    queryKey: [QUEUE_KEY, { includeResolved }],
    queryFn: () =>
      jfetch<RegisteredNumberQueue>(
        `/api/admin/registered-numbers?limit=200${includeResolved ? "&include_resolved=true" : ""}`,
      ),
  });
}

export function useResolveRegisteredNumber() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ResolveRegisteredNumberInput) =>
      jfetch<{ registry_key: string; brand_keys: string[] }>(
        `/api/admin/registered-numbers`,
        { method: "POST", json: input },
      ),
    onSuccess: (res) => {
      // Both views, because resolving removes the row from the open queue AND
      // adds it to the registry: invalidating only the active one leaves the
      // other stale behind a toggle the operator will flip in a second.
      qc.invalidateQueries({ queryKey: [QUEUE_KEY] });
      toast.success(`Saved ${res.registry_key}`);
    },
    onError: (e: Error) => toastError(e),
  });
}
