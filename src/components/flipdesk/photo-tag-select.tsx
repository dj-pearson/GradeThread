// US-2466: the one photo-tag picker.
//
// It replaced three hand-rolled flat lists (photo-manager, reconcile,
// autolister), each of which mapped FLIPDESK_PHOTO_TYPES straight into a Select
// and so showed all 28 entries for every item — including "Measure: Inseam" on
// a t-shirt and six near-identical "Detail N" rows. That is the specific thing
// sellers reported as unnavigable.
//
// Two sections, which is what iOS has done since US-2134:
//
//   1. "Suggested for <garment>" — the profile's own slots, in CAPTURE order.
//      Not alphabetical: the order is Front → Back → Tag → Detail →
//      measurements, which is the order a seller actually shoots in, so the
//      next tag they want is the next one down.
//   2. "All types" — everything else, A-Z, so a rare tag is findable by name
//      rather than by knowing where it sits in a canonical ordering.
//
// Nothing is hidden. Anything not suggested is demoted, never removed.

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FLIPDESK_PHOTO_TYPES, PHOTO_TYPE_LABELS } from "@/lib/constants";
import { measurementGroupFor } from "@/lib/measurement-templates";
import {
  isRetiredPhotoType,
  RETIRED_PHOTO_TYPES,
  roleLabel,
  rolesForType,
} from "@/lib/photo-roles";
import type { PhotoProfile } from "@/lib/photo-profiles";
import type { FlipdeskPhotoType } from "@/types/database";

/** A choice in the picker. `slot` is the Select's value: "type" or "type:role". */
interface TagOption {
  slot: string;
  type: FlipdeskPhotoType;
  role: string | null;
  label: string;
}

export function slotKey(type: string, role?: string | null): string {
  return role ? `${type}:${role}` : type;
}

function parseSlot(slot: string): { type: FlipdeskPhotoType; role: string | null } {
  const i = slot.indexOf(":");
  return i === -1
    ? { type: slot as FlipdeskPhotoType, role: null }
    : {
      type: slot.slice(0, i) as FlipdeskPhotoType,
      role: slot.slice(i + 1),
    };
}

/**
 * Every choice a seller may pick, minus the retired types. A type that takes
 * roles contributes one option PER ROLE and none for the bare type — picking
 * "Detail" with no qualifier is not a thing anyone wants when "Fabric close-up"
 * is sitting right there, and an unqualified option would quietly compete with
 * the qualified ones for the same slot.
 */
function allOptions(garment: string | null | undefined): TagOption[] {
  const group = measurementGroupFor(garment);
  const out: TagOption[] = [];
  for (const t of FLIPDESK_PHOTO_TYPES) {
    if (isRetiredPhotoType(t)) continue;
    const roles = rolesForType(t, group);
    if (roles.length === 0) {
      out.push({ slot: t, type: t, role: null, label: PHOTO_TYPE_LABELS[t] });
      continue;
    }
    for (const r of roles) {
      out.push({
        slot: slotKey(t, r.key),
        type: t,
        role: r.key,
        label: r.label,
      });
    }
  }
  return out;
}

/** The label to show for whatever the photo is tagged as RIGHT NOW. */
function currentLabel(
  type: FlipdeskPhotoType,
  role: string | null,
  garment: string | null | undefined,
): string {
  // A retired type keeps its old name until the seller retags it, so an
  // un-backfilled photo never renders as a blank or as the wrong thing.
  if (isRetiredPhotoType(type)) return PHOTO_TYPE_LABELS[type];
  const group = measurementGroupFor(garment);
  return roleLabel(type, role, group) ?? PHOTO_TYPE_LABELS[type];
}

export function PhotoTagSelect({
  photoType,
  photoRole,
  garment,
  profile,
  onChange,
  className,
  ariaLabel = "Photo type",
  disabled = false,
}: {
  photoType: FlipdeskPhotoType;
  photoRole: string | null;
  /** Free-text garment word; picks the suggested set and the measurement roles. */
  garment?: string | null;
  /** The resolved photo profile — its `roles` are the suggested section. */
  profile?: PhotoProfile;
  onChange: (type: FlipdeskPhotoType, role: string | null) => void;
  className?: string;
  ariaLabel?: string;
  /** Read-only mode: the current tag still renders, it just cannot be changed. */
  disabled?: boolean;
}) {
  const options = allOptions(garment);
  const byslot = new Map(options.map((o) => [o.slot, o]));

  // The suggested section is the profile's slots, in profile order. Filtered
  // through `byslot` so a profile that names a retired type cannot resurrect it.
  const suggested: TagOption[] = [];
  const seen = new Set<string>();
  for (const r of profile?.roles ?? []) {
    const key = slotKey(r.type, r.role);
    const opt = byslot.get(key);
    if (!opt || seen.has(key)) continue;
    seen.add(key);
    // The profile's label wins: it is written for this category ("Sweatband"
    // for a hat, not "Interior / Lining").
    suggested.push({ ...opt, label: r.label });
  }

  const rest = options
    .filter((o) => !seen.has(o.slot))
    .sort((a, b) => a.label.localeCompare(b.label));

  const current = slotKey(photoType, photoRole);
  // A photo on a retired type has no matching option, so the Select would
  // render an empty trigger. Give it one, marked, so the seller can see what it
  // is and choose something current.
  const orphan = !byslot.has(current);

  return (
    <Select
      value={current}
      disabled={disabled}
      onValueChange={(v) => {
        const { type, role } = parseSlot(v);
        onChange(type, role);
      }}
    >
      <SelectTrigger className={className} aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {orphan && (
          <SelectItem value={current} className="text-xs text-muted-foreground">
            {currentLabel(photoType, photoRole, garment)} (old tag)
          </SelectItem>
        )}
        {suggested.length > 0 && (
          <SelectGroup>
            <SelectLabel className="text-[10px] uppercase tracking-wide">
              Suggested{profile?.label ? ` · ${profile.label}` : ""}
            </SelectLabel>
            {suggested.map((o) => (
              <SelectItem key={o.slot} value={o.slot} className="text-xs">
                {o.label}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        <SelectGroup>
          <SelectLabel className="text-[10px] uppercase tracking-wide">
            All types
          </SelectLabel>
          {rest.map((o) => (
            <SelectItem key={o.slot} value={o.slot} className="text-xs">
              {o.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/** Exported for the retag surfaces that need to label a stored pair. */
export function photoTagLabel(
  type: FlipdeskPhotoType,
  role: string | null,
  garment?: string | null,
): string {
  return currentLabel(type, role, garment);
}

/** The retired-type map, re-exported so callers need one import, not two. */
export { RETIRED_PHOTO_TYPES };
