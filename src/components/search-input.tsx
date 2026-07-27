import * as React from "react";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface SearchInputProps
  extends Omit<React.ComponentProps<typeof Input>, "type"> {
  /**
   * Accessible name for the field. Falls back to the placeholder, then to
   * "Search". A search input MUST have an accessible name — placeholder text
   * alone is not one (it disappears on input). WCAG 3.3.2 / 4.1.2.
   */
  label?: string;
  /** Class for the relative wrapper (e.g. flex sizing). */
  containerClassName?: string;
}

/**
 * A search field with a leading (decorative, aria-hidden) magnifier icon and a
 * guaranteed accessible name. Use this instead of the hand-rolled
 * `<div className="relative"><Search/><Input placeholder="Search…"/></div>`
 * pattern so every search box is reachable and announced.
 */
export function SearchInput({
  label,
  placeholder,
  className,
  containerClassName,
  ...props
}: SearchInputProps) {
  const accessibleName = label ?? placeholder ?? "Search";
  return (
    <div className={cn("relative", containerClassName)}>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        type="search"
        aria-label={accessibleName}
        placeholder={placeholder ?? accessibleName}
        className={cn("pl-9", className)}
        {...props}
      />
    </div>
  );
}
