/** "needs_photos" -> "Needs Photos", "t-shirt" -> "T Shirt". */
export function formatLabel(value: string): string {
  return value
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
