import { useEffect, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useEbayCategorySuggest, type EbayCategorySuggestion } from "@/hooks/use-ebay";

// The eBay category search box and its suggestion list, shared by the listing
// composer's EbayCategoryPicker and the listing template editor. The caller
// owns the query text (so it can seed and reset it) and what a pick does.

// 250ms debounce — eBay's Taxonomy quota is generous but not free.
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export interface EbayCategorySearchProps {
  query: string;
  onQueryChange: (q: string) => void;
  onPick: (s: EbayCategorySuggestion) => void;
  /** The input's id, for the caller's <Label htmlFor>. */
  inputId: string;
}

export function EbayCategorySearch({
  query,
  onQueryChange,
  onPick,
  inputId,
}: EbayCategorySearchProps) {
  const debounced = useDebounced(query.trim(), 250);
  const suggestQuery = useEbayCategorySuggest(debounced);
  return (
    <>
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={inputId}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="e.g. men's blazer, women's silk blouse"
          className="pl-8"
        />
        {suggestQuery.isFetching && (
          <Loader2 className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
      </div>
      {debounced.length >= 2 && suggestQuery.data && (
        <div className="max-h-64 overflow-y-auto rounded-md border">
          {suggestQuery.data.length === 0 ? (
            <div className="p-3 text-xs text-muted-foreground">
              No matches. Try a different keyword.
            </div>
          ) : (
            suggestQuery.data.map((s) => (
              <button
                key={s.categoryId}
                type="button"
                onClick={() => onPick(s)}
                className="block w-full border-b px-3 py-2 text-left text-xs hover:bg-muted/50 last:border-b-0"
              >
                <div className="font-medium">{s.categoryName}</div>
                <div className="text-muted-foreground">{s.categoryTreePath}</div>
              </button>
            ))
          )}
        </div>
      )}
      {suggestQuery.isError && (
        <p className="text-xs text-destructive">{(suggestQuery.error as Error).message}</p>
      )}
    </>
  );
}
