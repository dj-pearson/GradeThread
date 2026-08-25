import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { edgeFetch } from "@/lib/edge-fetch";

// Auto-Disclosure Engine — fetch an item's condition & flaws disclosure +
// annotated defect-photo data, apply it to the listing, and persist annotated
// photos. All endpoints are tenant-scoped on the edge via item ownership.

export interface DisclosureBbox {
  0: number;
  1: number;
  2: number;
  3: number;
}

export interface PhotoAnnotation {
  n: number;
  issue: string;
  severity: "minor" | "moderate" | "major";
  location: string;
  bbox: [number, number, number, number] | null;
}

export interface DisclosurePhoto {
  image_type: string;
  url: string;
  annotations: PhotoAnnotation[];
}

export interface DisclosureData {
  graded: boolean;
  item?: {
    id: string;
    title: string | null;
    brand?: string | null;
    // US-538: per-item opt-in for AutoLister auto-attaching annotated photos.
    annotate_defect_photos?: boolean;
  };
  grade?: {
    overall_score: number;
    grade_tier: string;
    certificate_id: string | null;
    // US-2567: the human-readable GT-XXXXXXX burned into every asset in the
    // evidence pack. Null for an uncertified grade, which prints no stamp
    // rather than an empty one.
    certificate_number?: string | null;
  };
  disclosure?: {
    plain: string;
    markdown: string;
    html: string;
    defect_count: number;
    has_defects: boolean;
    style_features: string[];
  };
  photos?: DisclosurePhoto[];
}

export function useDisclosure(itemId: string | undefined) {
  return useQuery({
    queryKey: ["disclosure", itemId],
    enabled: !!itemId,
    staleTime: 60_000,
    queryFn: async (): Promise<DisclosureData> => {
      const res = await edgeFetch(`/api/flipdesk/disclosure/item/${itemId}`);
      if (!res.ok) throw new Error("Failed to load disclosure");
      return (await res.json()) as DisclosureData;
    },
  });
}

export function useApplyDisclosure(itemId: string | undefined) {
  return useMutation({
    mutationFn: async (): Promise<{ applied: boolean; already_present?: boolean }> => {
      const res = await edgeFetch(
        `/api/flipdesk/disclosure/item/${itemId}/apply-to-listing`,
        { method: "POST" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        applied?: boolean;
        already_present?: boolean;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Failed to add to listing");
      return { applied: !!data.applied, already_present: data.already_present };
    },
    onSuccess: (r) => {
      toast.success(
        r.already_present
          ? "Disclosure is already on this listing."
          : "Condition & flaws added to your listing description.",
      );
    },
    onError: (err: Error) => toastError(err),
  });
}

// US-538: toggle the per-item opt-in for AutoLister auto-attaching
// defect-callout photos composited from the verified grade.
export function useSetAnnotationOptIn(itemId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean): Promise<boolean> => {
      const res = await edgeFetch(
        `/api/flipdesk/disclosure/item/${itemId}/annotation-optin`,
        { method: "POST", json: { enabled } },
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to update setting");
      return enabled;
    },
    onSuccess: (enabled) => {
      toast.success(
        enabled
          ? "AutoLister will attach annotated defect photos for this item."
          : "Auto-annotation turned off for this item.",
      );
      queryClient.invalidateQueries({ queryKey: ["disclosure", itemId] });
    },
    onError: (err: Error) => toastError(err),
  });
}

export function useSaveAnnotatedPhoto(itemId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (args: { imageType: string; dataUrl: string }) => {
      const res = await edgeFetch(
        `/api/flipdesk/disclosure/item/${itemId}/annotated-photo`,
        { method: "POST", json: { image_type: args.imageType, data_url: args.dataUrl } },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        photo_id?: string | null;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Failed to save photo");
      return data;
    },
    onSuccess: () => {
      toast.success("Annotated photo added to this item's photos.");
      queryClient.invalidateQueries({ queryKey: ["item_photos", itemId] });
    },
    onError: (err: Error) => toastError(err),
  });
}
